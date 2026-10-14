/**
 * Deterministic chain-event indexer for ONE Forge factory on ONE chain.
 *
 * - Allowlist: the configured Forge factory, its authorizer, registry and
 *   locker, plus curves the factory itself announced (TokenLaunched). The
 *   original PONS factory (or any other emitter) is never read.
 * - Identity: (chainId, blockHash, logIndex); inserts are ON CONFLICT DO
 *   NOTHING, so duplicates and replays are no-ops.
 * - Finality: only blocks at depth >= FORGE_CONFIRMATIONS are indexed.
 * - Reorgs: the stored hash of every indexed block with events (and the
 *   checkpoint) is compared with the chain each tick; on divergence the
 *   indexer rolls back to the highest still-canonical block, deletes
 *   orphaned events and rebuilds affected projections from events alone.
 * - Atomicity: events, block hashes, checkpoint and projections for a
 *   range commit in one transaction; a crash re-processes the same range.
 */
import { decodeEventLog, getAddress, type Abi, type Address, type Hex, type Log } from "viem";
import { forgeBindingRegistryAbi, forgeLaunchAuthorizerAbi, ponsV2BondingCurveAbi, ponsV2LaunchFactoryAbi, ponsV2LaunchLockerAbi, ponsV2LauncherTokenAbi } from "@/shared/abis.generated";
import type { AppContext } from "../context";
import type { Queryable } from "../db";
import { readLaunchedToken, readLockState } from "../chain/forge";
import { rebuildTokenProjection, projectionPhaseMatchesOnchain } from "./projection";

export const checkpointName = (ctx: AppContext) => `forge:${ctx.cfg.chainId}:${ctx.cfg.addresses.factory.toLowerCase()}`;

export interface TickResult {
  from: bigint | null;
  to: bigint | null;
  events: number;
  reorgedTo: bigint | null;
  tokensTouched: string[];
}

interface DecodedLog {
  blockNumber: bigint;
  blockHash: Hex;
  txHash: Hex;
  logIndex: number;
  address: Address;
  eventName: string;
  args: Record<string, unknown>;
}

const jsonArgs = (args: Record<string, unknown>) => JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

export class ForgeIndexer {
  constructor(private readonly ctx: AppContext) {}

  private sources(): Array<{ address: Address; abi: Abi }> {
    const a = this.ctx.cfg.addresses;
    return [
      { address: a.factory, abi: ponsV2LaunchFactoryAbi as Abi },
      { address: a.authorizer, abi: forgeLaunchAuthorizerAbi as Abi },
      { address: a.registry, abi: forgeBindingRegistryAbi as Abi },
      { address: a.locker, abi: ponsV2LaunchLockerAbi as Abi },
    ];
  }

  async checkpoint(): Promise<{ lastBlock: bigint; lastHash: Hex | null }> {
    const name = checkpointName(this.ctx);
    const { rows } = await this.ctx.db.query<{ last_block: string; last_block_hash: string | null }>(
      "SELECT last_block::text, last_block_hash FROM indexer_checkpoints WHERE name = $1",
      [name],
    );
    if (rows[0]) return { lastBlock: BigInt(rows[0].last_block), lastHash: rows[0].last_block_hash as Hex | null };
    const start = this.ctx.cfg.addresses.deployBlock > 0n ? this.ctx.cfg.addresses.deployBlock - 1n : 0n;
    await this.ctx.db.query(
      "INSERT INTO indexer_checkpoints(name, chain_id, factory, last_block, last_block_hash) VALUES ($1,$2,$3,$4,NULL) ON CONFLICT DO NOTHING",
      [name, this.ctx.cfg.chainId, this.ctx.cfg.addresses.factory, start.toString()],
    );
    return { lastBlock: start, lastHash: null };
  }

  /** Returns the block to roll back to, or null when the indexed history is still canonical. */
  private async detectReorg(lastBlock: bigint, lastHash: Hex | null): Promise<bigint | null> {
    if (lastHash) {
      const b = await this.ctx.client.getBlock({ blockNumber: lastBlock }).catch(() => null);
      if (b && b.hash === lastHash) return null;
    } else {
      // No checkpoint hash: verify the most recent stored event block instead.
      const { rows } = await this.ctx.db.query<{ block_number: string; block_hash: string }>(
        "SELECT block_number::text, block_hash FROM indexed_blocks WHERE chain_id = $1 ORDER BY block_number DESC LIMIT 1",
        [this.ctx.cfg.chainId],
      );
      if (!rows[0]) return null;
      const b = await this.ctx.client.getBlock({ blockNumber: BigInt(rows[0].block_number) }).catch(() => null);
      if (b && b.hash === rows[0].block_hash) return null;
    }
    const { rows } = await this.ctx.db.query<{ block_number: string; block_hash: string }>(
      "SELECT block_number::text, block_hash FROM indexed_blocks WHERE chain_id = $1 AND block_number <= $2 ORDER BY block_number DESC LIMIT $3",
      [this.ctx.cfg.chainId, lastBlock.toString(), this.ctx.cfg.reorgWindow],
    );
    for (const r of rows) {
      const b = await this.ctx.client.getBlock({ blockNumber: BigInt(r.block_number) }).catch(() => null);
      if (b && b.hash === r.block_hash) return BigInt(r.block_number);
    }
    if (rows.length >= this.ctx.cfg.reorgWindow) {
      throw new Error("REORG_DEEPER_THAN_WINDOW: manual intervention required (see docs/W03-SECURITY-RUNBOOK.md)");
    }
    const deploy = this.ctx.cfg.addresses.deployBlock;
    return deploy > 0n ? deploy - 1n : 0n;
  }

  async rollbackTo(ancestor: bigint): Promise<string[]> {
    const { cfg } = this.ctx;
    return this.ctx.db.tx(async (q) => {
      const touched = await tokensForEvents(q, cfg.chainId, `block_number > ${ancestor.toString()}`);
      await q.query("DELETE FROM chain_events WHERE chain_id = $1 AND block_number > $2", [cfg.chainId, ancestor.toString()]);
      await q.query("DELETE FROM indexed_blocks WHERE chain_id = $1 AND block_number > $2", [cfg.chainId, ancestor.toString()]);
      const anc = await q.query<{ block_hash: string }>("SELECT block_hash FROM indexed_blocks WHERE chain_id = $1 AND block_number = $2", [cfg.chainId, ancestor.toString()]);
      await q.query("UPDATE indexer_checkpoints SET last_block = $2, last_block_hash = $3, updated_at = now() WHERE name = $1", [
        checkpointName(this.ctx),
        ancestor.toString(),
        anc.rows[0]?.block_hash ?? null,
      ]);
      for (const t of touched) await rebuildTokenProjection(q, cfg.chainId, cfg.addresses, t);
      // Launches whose confirmation was reorged out go back to tracking.
      await q.query("UPDATE launch_intents SET status = 'submitted', updated_at = now() WHERE status = 'confirmed' AND token_address = ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM tokens WHERE tokens.token = launch_intents.token_address)", [touched]);
      return touched;
    });
  }

  private decode(log: Log, abi: Abi): DecodedLog | null {
    try {
      const ev = decodeEventLog({ abi, data: log.data, topics: log.topics });
      return {
        blockNumber: log.blockNumber!,
        blockHash: log.blockHash!,
        txHash: log.transactionHash!,
        logIndex: log.logIndex!,
        address: getAddress(log.address),
        eventName: String(ev.eventName),
        args: (ev.args ?? {}) as Record<string, unknown>,
      };
    } catch {
      return null;
    }
  }

  async tick(): Promise<TickResult> {
    const { cfg, client, db } = this.ctx;
    const cp = await this.checkpoint();
    const ancestor = await this.detectReorg(cp.lastBlock, cp.lastHash);
    if (ancestor !== null) {
      const touched = await this.rollbackTo(ancestor);
      return { from: null, to: null, events: 0, reorgedTo: ancestor, tokensTouched: touched };
    }
    const head = await client.getBlockNumber();
    const safe = head - BigInt(cfg.confirmations);
    if (safe <= cp.lastBlock) return { from: null, to: null, events: 0, reorgedTo: null, tokensTouched: [] };
    const from = cp.lastBlock + 1n;
    const to = safe < from + cfg.indexerBatchBlocks - 1n ? safe : from + cfg.indexerBatchBlocks - 1n;

    const decoded: DecodedLog[] = [];
    for (const src of this.sources()) {
      const logs = await client.getLogs({ address: src.address, fromBlock: from, toBlock: to });
      for (const l of logs) {
        const d = this.decode(l, src.abi);
        if (d) decoded.push(d);
      }
    }
    const factory = cfg.addresses.factory;
    const known = (await db.query<{ curve: string }>("SELECT curve FROM tokens WHERE chain_id = $1 AND factory = $2", [cfg.chainId, factory])).rows.map((r) => getAddress(r.curve));
    const announced = decoded.filter((d) => d.address === factory && d.eventName === "TokenLaunched").map((d) => getAddress(d.args.curve as string));
    const curves = [...new Set([...known, ...announced])];
    for (let i = 0; i < curves.length; i += 100) {
      const logs = await client.getLogs({ address: curves.slice(i, i + 100), fromBlock: from, toBlock: to });
      for (const l of logs) {
        const d = this.decode(l, ponsV2BondingCurveAbi as Abi);
        if (d) decoded.push(d);
      }
    }
    decoded.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));

    // Fetch canonical hashes; every log must belong to the block we see now.
    const blockNums = [...new Set([...decoded.map((d) => d.blockNumber), to])];
    const blocks = new Map<bigint, { hash: Hex; timestamp: bigint }>();
    for (const n of blockNums) {
      const b = await client.getBlock({ blockNumber: n });
      blocks.set(n, { hash: b.hash, timestamp: b.timestamp });
    }
    for (const d of decoded) {
      if (blocks.get(d.blockNumber)!.hash !== d.blockHash) {
        // The range changed under us; retry next tick against a stable view.
        return { from, to: null, events: 0, reorgedTo: null, tokensTouched: [] };
      }
    }

    const toHash = blocks.get(to)!.hash;
    const touched = await db.tx(async (q) => {
      for (const [n, b] of blocks) {
        await q.query(
          "INSERT INTO indexed_blocks(chain_id, block_number, block_hash, block_timestamp) VALUES ($1,$2,$3,$4) ON CONFLICT (chain_id, block_number) DO UPDATE SET block_hash = EXCLUDED.block_hash, block_timestamp = EXCLUDED.block_timestamp",
          [cfg.chainId, n.toString(), b.hash, b.timestamp.toString()],
        );
      }
      for (const d of decoded) {
        await q.query(
          `INSERT INTO chain_events(chain_id, block_number, block_hash, tx_hash, log_index, address, event_name, args, block_timestamp)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
          [cfg.chainId, d.blockNumber.toString(), d.blockHash, d.txHash.toLowerCase(), d.logIndex, d.address, d.eventName, jsonArgs(d.args), blocks.get(d.blockNumber)!.timestamp.toString()],
        );
      }
      const touched = await tokensForEvents(q, cfg.chainId, `block_number BETWEEN ${from.toString()} AND ${to.toString()}`);
      for (const t of touched) await rebuildTokenProjection(q, cfg.chainId, cfg.addresses, t);
      await q.query("UPDATE indexer_checkpoints SET last_block = $2, last_block_hash = $3, updated_at = now() WHERE name = $1", [
        checkpointName(this.ctx),
        to.toString(),
        toHash,
      ]);
      // Prune block hashes older than the reorg window (event blocks are kept).
      await q.query(
        "DELETE FROM indexed_blocks WHERE chain_id = $1 AND block_number < $2 AND NOT EXISTS (SELECT 1 FROM chain_events e WHERE e.chain_id = indexed_blocks.chain_id AND e.block_number = indexed_blocks.block_number)",
        [cfg.chainId, (to - BigInt(cfg.reorgWindow)).toString()],
      );
      return touched;
    });
    for (const t of touched) await this.enrich(t);
    return { from, to, events: decoded.length, reorgedTo: null, tokensTouched: touched };
  }

  /** Names/symbols (immutable token metadata) and reconciliation against contract state at the checkpoint. */
  async enrich(token: string) {
    const { client, db } = this.ctx;
    const row = (await db.query<{ name: string | null }>("SELECT name FROM tokens WHERE token = $1", [token])).rows[0];
    if (!row) return;
    if (row.name === null) {
      const [name, symbol] = await Promise.all([
        client.readContract({ address: token as Address, abi: ponsV2LauncherTokenAbi, functionName: "name" }),
        client.readContract({ address: token as Address, abi: ponsV2LauncherTokenAbi, functionName: "symbol" }),
      ]);
      await db.query("UPDATE tokens SET name = $2, symbol = $3 WHERE token = $1", [token, name, symbol]);
    }
    await this.reconcile(token);
  }

  /** Compares the event-derived projection with factory/locker/curve state read AT the checkpoint block. */
  async reconcile(token: string) {
    const { client, db, cfg } = this.ctx;
    const cp = await this.checkpoint();
    const t = (await db.query<{ phase: string; curve: string; launch_block: string }>("SELECT phase, curve, launch_block::text FROM tokens WHERE token = $1", [token])).rows[0];
    if (!t || BigInt(t.launch_block) > cp.lastBlock) return;
    try {
      const launched = await readLaunchedToken(client, cfg.addresses, token as Address, cp.lastBlock);
      const lock = await readLockState(client, cfg.addresses, token as Address);
      let reserve: bigint | null = null;
      try {
        reserve = await client.readContract({ address: t.curve as Address, abi: ponsV2BondingCurveAbi, functionName: "realQuoteReserve", blockNumber: cp.lastBlock });
      } catch {
        reserve = null;
      }
      const ok = launched.exists && projectionPhaseMatchesOnchain(t.phase, launched.phase);
      await db.query(
        "UPDATE tokens SET onchain_phase = $2, reconciled_at = now(), reconcile_error = $3, curve_quote_reserve = $4, liquidity_locked = (liquidity_locked OR $5), updated_at = now() WHERE token = $1",
        [token, launched.phase, ok ? null : `projection ${t.phase} vs on-chain phase ${launched.phase}`, reserve?.toString() ?? null, lock.locked && launched.phase === 2],
      );
    } catch (e) {
      await db.query("UPDATE tokens SET reconcile_error = $2, reconciled_at = now() WHERE token = $1", [token, `reconcile read failed: ${(e as Error).message.split("\n")[0]}`]);
    }
  }
}

/** Token addresses referenced by events matching `where` (factory/locker events by args.token, curve events via tokens.curve). */
async function tokensForEvents(q: Queryable, chainId: number, where: string): Promise<string[]> {
  const { rows } = await q.query<{ token: string }>(
    `SELECT DISTINCT COALESCE(e.args->>'token', t.token) AS token
       FROM chain_events e LEFT JOIN tokens t ON t.curve = e.address
      WHERE e.chain_id = $1 AND ${where} AND (e.args->>'token' IS NOT NULL OR t.token IS NOT NULL)`,
    [chainId],
  );
  return rows.map((r) => getAddress(r.token));
}
