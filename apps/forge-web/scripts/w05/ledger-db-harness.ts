/**
 * W05 — writes a synthetic history into the W03 indexer tables the way the
 * indexer does (per range, ONE transaction: indexed_blocks, chain_events,
 * checkpoint, ledger snapshot via materializeInTx). Used by the
 * materialization tests, the benchmark and the backup rehearsal. No RPC.
 */
import type { Db, Queryable } from "../../src/server/db";
import type { LedgerContext, LedgerEvent } from "../../src/server/finance/ledger";
import { materializeInTx, rollbackSnapshots } from "../../src/server/finance/materialized";
import type { History } from "./synthetic-history";

export const HARNESS_CHECKPOINT = "synthetic:checkpoint";

export async function insertEvents(q: Queryable, chainId: number, events: LedgerEvent[]) {
  for (let i = 0; i < events.length; i += 2000) {
    const chunk = events.slice(i, i + 2000);
    await q.query(
      `INSERT INTO chain_events(chain_id, block_number, block_hash, tx_hash, log_index, address, event_name, args, block_timestamp)
       SELECT $1, b, h, t, l, a, n, g::jsonb, ts FROM unnest($2::bigint[], $3::text[], $4::text[], $5::int[], $6::text[], $7::text[], $8::text[], $9::bigint[]) AS u(b, h, t, l, a, n, g, ts)
       ON CONFLICT DO NOTHING`,
      [
        chainId,
        chunk.map((e) => e.blockNumber.toString()),
        chunk.map((e) => e.blockHash),
        chunk.map((e) => e.txHash),
        chunk.map((e) => e.logIndex),
        chunk.map((e) => e.address),
        chunk.map((e) => e.eventName),
        chunk.map((e) => JSON.stringify(e.args)),
        chunk.map((e) => e.blockTimestamp.toString()),
      ],
    );
  }
}

async function upsertBlocks(q: Queryable, chainId: number, blocks: Array<[number, string]>) {
  if (!blocks.length) return;
  await q.query(
    `INSERT INTO indexed_blocks(chain_id, block_number, block_hash, block_timestamp)
     SELECT $1, b, h, 0 FROM unnest($2::bigint[], $3::text[]) AS u(b, h)
     ON CONFLICT (chain_id, block_number) DO UPDATE SET block_hash = EXCLUDED.block_hash`,
    [chainId, blocks.map(([b]) => String(b)), blocks.map(([, h]) => h)],
  );
}

export interface SeedOptions {
  chainId: number;
  /** Blocks per simulated indexer range. */
  rangeBlocks: number;
  /** Ledger snapshot cadence (FORGE_LEDGER_SNAPSHOT_MIN_BLOCKS). Infinity = no snapshots. */
  snapshotMinBlocks: number;
  reorgWindow?: number;
  /** Index only blocks in (fromBlock, toBlock]. */
  fromBlock?: number;
  toBlock?: number;
  ctx: LedgerContext;
}

export async function ensureCheckpoint(db: Queryable, chainId: number, start = 0) {
  await db.query(
    "INSERT INTO indexer_checkpoints(name, chain_id, factory, last_block, last_block_hash) VALUES ($1,$2,'synthetic',$3,NULL) ON CONFLICT DO NOTHING",
    [HARNESS_CHECKPOINT, chainId, String(start)],
  );
}

/** Simulated indexer: commits ranges of the history, each with its snapshot, like ForgeIndexer.tick. */
export async function seedHistory(db: Db, h: History, o: SeedOptions): Promise<{ ranges: number; snapshots: number; ms: number[] }> {
  await ensureCheckpoint(db, o.chainId, o.fromBlock ?? 0);
  const byBlock = new Map<number, LedgerEvent[]>();
  for (const e of h.events) {
    const b = Number(e.blockNumber);
    if (!byBlock.has(b)) byBlock.set(b, []);
    byBlock.get(b)!.push(e);
  }
  const from = (o.fromBlock ?? 0) + 1;
  const to = o.toBlock ?? h.lastBlock;
  let ranges = 0;
  let snapshots = 0;
  const ms: number[] = [];
  for (let start = from; start <= to; start += o.rangeBlocks) {
    const end = Math.min(to, start + o.rangeBlocks - 1);
    const evs: LedgerEvent[] = [];
    const blocks: Array<[number, string]> = [];
    for (let b = start; b <= end; b++) {
      const xs = byBlock.get(b);
      if (xs) {
        evs.push(...xs);
        blocks.push([b, h.blockHashes.get(b)!]);
      }
    }
    if (!blocks.some(([b]) => b === end)) blocks.push([end, h.blockHashes.get(end)!]);
    const t0 = performance.now();
    const written = await db.tx(async (q) => {
      await upsertBlocks(q, o.chainId, blocks);
      await insertEvents(q, o.chainId, evs);
      await q.query("UPDATE indexer_checkpoints SET last_block = $2, last_block_hash = $3, updated_at = now() WHERE name = $1", [HARNESS_CHECKPOINT, String(end), h.blockHashes.get(end)!]);
      if (evs.length && Number.isFinite(o.snapshotMinBlocks)) {
        const m = await materializeInTx(q, { chainId: o.chainId, ledger: o.ctx, block: BigInt(end), hash: h.blockHashes.get(end)!, reorgWindow: o.reorgWindow ?? 64, minBlocks: o.snapshotMinBlocks });
        if (m.error) throw new Error(`materialize failed: ${m.error}`);
        return m.written;
      }
      return false;
    });
    ms.push(performance.now() - t0);
    ranges++;
    if (written) snapshots++;
  }
  return { ranges, snapshots, ms };
}

/** The indexer's reorg rollback, for the synthetic checkpoint (same statements as ForgeIndexer.rollbackTo). */
export async function rollbackHarness(db: Db, chainId: number, ancestor: number, ancestorHash: string) {
  await db.tx(async (q) => {
    await rollbackSnapshots(q, chainId, BigInt(ancestor));
    await q.query("DELETE FROM chain_events WHERE chain_id = $1 AND block_number > $2", [chainId, String(ancestor)]);
    await q.query("DELETE FROM indexed_blocks WHERE chain_id = $1 AND block_number > $2", [chainId, String(ancestor)]);
    await upsertBlocks(q, chainId, [[ancestor, ancestorHash]]);
    await q.query("UPDATE indexer_checkpoints SET last_block = $2, last_block_hash = $3 WHERE name = $1", [HARNESS_CHECKPOINT, String(ancestor), ancestorHash]);
  });
}
