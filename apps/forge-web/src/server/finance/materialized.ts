/**
 * W05 — materialized financial ledger (a DERIVED cache of the W04 fold).
 *
 * Source of truth stays the W03 indexer's `chain_events`. This module keeps
 * serialized fold states ("snapshots") at indexer checkpoint blocks so a
 * request folds only the events after the newest still-canonical snapshot
 * instead of the whole history.
 *
 *  - Write path: the indexer calls `materializeInTx` inside the SAME
 *    transaction that commits a range and advances its checkpoint, so a
 *    snapshot can never describe events that are not committed (or vice
 *    versa). Retention keeps every snapshot inside the reorg window plus the
 *    newest one below it.
 *  - Read path: `loadFoldAt` picks the newest snapshot whose
 *    (block_number, block_hash) is still in `indexed_blocks` (canonical),
 *    verifies its sha256 and that the canonical event count up to its block
 *    is unchanged, then applies only newer events. Anything unexpected falls
 *    back to a fold from genesis — never to a guess.
 *  - Reorgs: the indexer's rollback deletes snapshots above the common
 *    ancestor in its rollback transaction; a snapshot whose hash is no
 *    longer canonical is ignored by the read path regardless.
 *  - Integrity: `runLedgerSelfCheck` compares the materialized ledger with
 *    the reference `buildLedger` over all events (and a fold from genesis)
 *    by deterministic digest, and checks the splitter's on-chain reconcile()
 *    deficit. Any divergence or deficit HALTS (sticky `ledger_integrity`
 *    flag + ALERT audit row); while halted the service serves the reference
 *    rebuild and the revenue attestor refuses to sign.
 */
import { getAddress, type Address } from "viem";
import type { ForgeAddresses } from "../config";
import type { Db, Queryable } from "../db";
import { audit } from "../audit";
import { buildLedger, NATIVE, type Ledger, type LedgerContext, type LedgerEvent } from "./ledger";
import {
  applyEvents,
  createFoldState,
  decodeFoldState,
  encodeFoldState,
  finalizeFold,
  foldAll,
  FOLD_VERSION,
  ledgerDigest,
  NonIncrementalHistoryError,
  sha256Hex,
  type LedgerFoldState,
} from "./ledger-fold";

export function ledgerContextFor(a: ForgeAddresses): LedgerContext {
  return {
    factory: a.factory,
    hook: a.memeHook,
    escrow: a.feeEscrow ?? NATIVE,
    vault: a.buybackVault ?? NATIVE,
    splitter: a.revenueSplitter,
    graduationExecutor: a.graduationExecutor,
  };
}

/** Snapshots are only valid for the exact fold rules + address wiring that produced them. */
export function ledgerContextKey(c: LedgerContext): string {
  return sha256Hex(
    JSON.stringify({ v: FOLD_VERSION, factory: c.factory, hook: c.hook, escrow: c.escrow, vault: c.vault, splitter: c.splitter, graduationExecutor: c.graduationExecutor ?? null }),
  );
}

interface EventRow {
  block_number: string;
  block_hash: string;
  tx_hash: string;
  log_index: number;
  address: string;
  event_name: string;
  args: Record<string, string>;
  block_timestamp: string;
}
const EVENT_COLS = "block_number::text, block_hash, tx_hash, log_index, address, event_name, args, block_timestamp::text";

export function rowToEvent(r: EventRow): LedgerEvent {
  return {
    blockNumber: BigInt(r.block_number),
    blockHash: r.block_hash,
    txHash: r.tx_hash,
    logIndex: r.log_index,
    address: getAddress(r.address),
    eventName: r.event_name,
    args: r.args,
    blockTimestamp: BigInt(r.block_timestamp),
  };
}

/** Events with afterBlock < block_number <= throughBlock (null bounds = open). */
export async function readEvents(q: Queryable, chainId: number, afterBlock: bigint | null, throughBlock: bigint | null): Promise<LedgerEvent[]> {
  const { rows } = await q.query<EventRow>(
    `SELECT ${EVENT_COLS} FROM chain_events WHERE chain_id = $1 AND ($2::bigint IS NULL OR block_number > $2::bigint) AND ($3::bigint IS NULL OR block_number <= $3::bigint)`,
    [chainId, afterBlock?.toString() ?? null, throughBlock?.toString() ?? null],
  );
  return rows.map(rowToEvent);
}

export interface Checkpoint {
  block: bigint;
  hash: string | null;
}

export async function readCheckpoint(q: Queryable, name: string): Promise<Checkpoint | null> {
  const { rows } = await q.query<{ last_block: string; last_block_hash: string | null }>("SELECT last_block::text, last_block_hash FROM indexer_checkpoints WHERE name = $1", [name]);
  return rows[0] ? { block: BigInt(rows[0].last_block), hash: rows[0].last_block_hash } : null;
}

interface SnapshotRow {
  block_number: string;
  block_hash: string;
  event_count: string;
  state: string;
  state_sha256: string;
  ledger_digest: string;
}

async function latestCanonicalSnapshot(q: Queryable, chainId: number, ctxKey: string, maxBlock: bigint): Promise<SnapshotRow | null> {
  const { rows } = await q.query<SnapshotRow>(
    `SELECT s.block_number::text, s.block_hash, s.event_count::text, s.state, s.state_sha256, s.ledger_digest
       FROM ledger_snapshots s
       JOIN indexed_blocks b ON b.chain_id = s.chain_id AND b.block_number = s.block_number AND b.block_hash = s.block_hash
      WHERE s.chain_id = $1 AND s.context_key = $2 AND s.fold_version = $3 AND s.block_number <= $4
      ORDER BY s.block_number DESC LIMIT 1`,
    [chainId, ctxKey, FOLD_VERSION, maxBlock.toString()],
  );
  return rows[0] ?? null;
}

export type FoldSource = "snapshot" | "genesis";

export interface FoldLoad {
  state: LedgerFoldState;
  source: FoldSource;
  snapshotBlock: bigint | null;
  /** Events applied on top of the snapshot (or from genesis). */
  appliedEvents: number;
  /** Why a present snapshot was not used (null when used or when none existed). */
  fallbackReason: string | null;
}

/**
 * Fold state at `through` (the checkpoint block): newest canonical, verified
 * snapshot + newer events, else a single-batch fold from genesis.
 */
export async function loadFoldAt(q: Queryable, chainId: number, c: LedgerContext, through: bigint | null): Promise<FoldLoad> {
  let fallbackReason: string | null = null;
  if (through !== null) {
    const snap = await latestCanonicalSnapshot(q, chainId, ledgerContextKey(c), through);
    if (snap) {
      const block = BigInt(snap.block_number);
      const count = (await q.query<{ n: string }>("SELECT count(*)::text AS n FROM chain_events WHERE chain_id = $1 AND block_number <= $2", [chainId, snap.block_number])).rows[0]!.n;
      if (sha256Hex(snap.state) !== snap.state_sha256) fallbackReason = `snapshot ${block} state checksum mismatch`;
      else if (count !== snap.event_count) fallbackReason = `snapshot ${block} covers ${snap.event_count} events, chain_events now has ${count} at or below it`;
      else {
        try {
          const state = decodeFoldState(snap.state);
          const tail = await readEvents(q, chainId, block, through);
          const r = applyEvents(state, tail, c, through);
          return { state, source: "snapshot", snapshotBlock: block, appliedEvents: r.applied, fallbackReason: null };
        } catch (e) {
          if (!(e instanceof NonIncrementalHistoryError)) throw e;
          fallbackReason = e.message;
        }
      }
    }
  }
  const all = await readEvents(q, chainId, null, through);
  const state = foldAll(all, c, through ?? undefined);
  return { state, source: "genesis", snapshotBlock: null, appliedEvents: state.eventCount, fallbackReason };
}

async function writeSnapshot(q: Queryable, chainId: number, c: LedgerContext, state: LedgerFoldState, block: bigint, hash: string, reorgWindow: number) {
  const text = encodeFoldState(state);
  const ctxKey = ledgerContextKey(c);
  await q.query(
    `INSERT INTO ledger_snapshots(chain_id, context_key, block_number, block_hash, fold_version, event_count, state, state_sha256, ledger_digest)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (chain_id, context_key, block_number) DO UPDATE SET block_hash = EXCLUDED.block_hash, fold_version = EXCLUDED.fold_version,
       event_count = EXCLUDED.event_count, state = EXCLUDED.state, state_sha256 = EXCLUDED.state_sha256, ledger_digest = EXCLUDED.ledger_digest, created_at = now()`,
    [chainId, ctxKey, block.toString(), hash, FOLD_VERSION, state.eventCount, text, sha256Hex(text), ledgerDigest(finalizeFold(state))],
  );
  // Retention: every snapshot inside the reorg window + the newest one below it.
  await q.query(
    `DELETE FROM ledger_snapshots WHERE chain_id = $1 AND context_key = $2 AND block_number < (
       SELECT max(block_number) FROM ledger_snapshots WHERE chain_id = $1 AND context_key = $2 AND block_number <= $3)`,
    [chainId, ctxKey, (block - BigInt(reorgWindow)).toString()],
  );
}

export interface MaterializeParams {
  chainId: number;
  ledger: LedgerContext;
  block: bigint;
  hash: string;
  reorgWindow: number;
  /** Skip when the newest canonical snapshot is fewer than this many blocks old. */
  minBlocks: number;
}

/**
 * Indexer hook: called inside the transaction that commits a range and its
 * checkpoint. Runs under a SAVEPOINT so a failure (which only means a slower
 * read path) can never abort the indexer's commit.
 */
export async function materializeInTx(q: Queryable, p: MaterializeParams): Promise<{ written: boolean; error?: string }> {
  await q.query("SAVEPOINT forge_ledger_materialize");
  try {
    const latest = await latestCanonicalSnapshot(q, p.chainId, ledgerContextKey(p.ledger), p.block);
    if (latest && p.block - BigInt(latest.block_number) < BigInt(p.minBlocks)) {
      await q.query("RELEASE SAVEPOINT forge_ledger_materialize");
      return { written: false };
    }
    const { state } = await loadFoldAt(q, p.chainId, p.ledger, p.block);
    await writeSnapshot(q, p.chainId, p.ledger, state, p.block, p.hash, p.reorgWindow);
    await q.query("RELEASE SAVEPOINT forge_ledger_materialize");
    return { written: true };
  } catch (e) {
    await q.query("ROLLBACK TO SAVEPOINT forge_ledger_materialize");
    await q.query("RELEASE SAVEPOINT forge_ledger_materialize");
    return { written: false, error: (e as Error).message.split("\n")[0] };
  }
}

/** Reorg hook: called in the indexer's rollback transaction. */
export async function rollbackSnapshots(q: Queryable, chainId: number, ancestor: bigint) {
  await q.query("DELETE FROM ledger_snapshots WHERE chain_id = $1 AND block_number > $2", [chainId, ancestor.toString()]);
}

async function readOnlySnapshotTx<T>(db: Db, fn: (q: Queryable) => Promise<T>): Promise<T> {
  return db.tx(async (q) => {
    // One consistent view of checkpoint, snapshot and events.
    await q.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    return fn(q);
  });
}

export interface LoadedLedger {
  ledger: Ledger;
  checkpoint: bigint | null;
  info: { mode: "materialized" | "full"; source: FoldSource | "reference"; snapshotBlock: string | null; appliedEvents: number; fallbackReason: string | null };
}

export async function loadMaterializedLedger(db: Db, chainId: number, c: LedgerContext, checkpointName: string): Promise<LoadedLedger> {
  return readOnlySnapshotTx(db, async (q) => {
    const cp = await readCheckpoint(q, checkpointName);
    const f = await loadFoldAt(q, chainId, c, cp?.block ?? null);
    return {
      ledger: finalizeFold(f.state),
      checkpoint: cp?.block ?? null,
      info: { mode: "materialized", source: f.source, snapshotBlock: f.snapshotBlock?.toString() ?? null, appliedEvents: f.appliedEvents, fallbackReason: f.fallbackReason },
    };
  });
}

/** The W04 reference path: buildLedger over every indexed event of the chain. */
export async function loadReferenceLedger(q: Queryable, chainId: number, c: LedgerContext, checkpointName: string): Promise<LoadedLedger> {
  const events = await readEvents(q, chainId, null, null);
  const ledger = buildLedger(events, c);
  const cp = await readCheckpoint(q, checkpointName);
  return { ledger, checkpoint: cp?.block ?? null, info: { mode: "full", source: "reference", snapshotBlock: null, appliedEvents: events.length, fallbackReason: null } };
}

/**
 * Deterministic rebuild from full history: drops this context's snapshots
 * and writes one at the checkpoint from a single-batch fold of all events.
 */
export async function rebuildSnapshots(db: Db, chainId: number, c: LedgerContext, checkpointName: string, reorgWindow: number) {
  return db.tx(async (q) => {
    const cp = await readCheckpoint(q, checkpointName);
    await q.query("DELETE FROM ledger_snapshots WHERE chain_id = $1 AND context_key = $2", [chainId, ledgerContextKey(c)]);
    const all = await readEvents(q, chainId, null, cp?.block ?? null);
    const state = cp ? foldAll(all, c, cp.block) : createFoldState();
    const digest = ledgerDigest(finalizeFold(state));
    let written = false;
    if (cp?.hash) {
      const canon = await q.query("SELECT 1 FROM indexed_blocks WHERE chain_id = $1 AND block_number = $2 AND block_hash = $3", [chainId, cp.block.toString(), cp.hash]);
      if (canon.rows.length) {
        await writeSnapshot(q, chainId, c, state, cp.block, cp.hash, reorgWindow);
        written = true;
      }
    }
    return { checkpoint: cp?.block ?? null, events: state.eventCount, digest, written };
  });
}

// ── Integrity: self-check and halt ───────────────────────────────────────

export interface LedgerIntegrity {
  halted: boolean;
  haltReason: string | null;
  haltedAt: Date | null;
  lastCheckAt: Date | null;
  lastCheckOk: boolean | null;
  lastCheckDetail: Record<string, unknown> | null;
}

export async function ledgerIntegrity(q: Queryable, chainId: number): Promise<LedgerIntegrity | null> {
  const { rows } = await q.query<{ halted: boolean; halt_reason: string | null; halted_at: Date | null; last_check_at: Date | null; last_check_ok: boolean | null; last_check_detail: Record<string, unknown> | null }>(
    "SELECT halted, halt_reason, halted_at, last_check_at, last_check_ok, last_check_detail FROM ledger_integrity WHERE chain_id = $1",
    [chainId],
  );
  const r = rows[0];
  return r ? { halted: r.halted, haltReason: r.halt_reason, haltedAt: r.halted_at, lastCheckAt: r.last_check_at, lastCheckOk: r.last_check_ok, lastCheckDetail: r.last_check_detail } : null;
}

/** Sticky fail-closed halt + operator alert. Only `clearLedgerHalt` (after a passing check) lifts it. */
export async function haltLedger(db: Db, chainId: number, reason: string, detail: Record<string, unknown>) {
  await db.query(
    `INSERT INTO ledger_integrity(chain_id, halted, halt_reason, halted_at, last_check_at, last_check_ok, last_check_detail)
     VALUES ($1, true, $2, now(), now(), false, $3)
     ON CONFLICT (chain_id) DO UPDATE SET halted = true, halt_reason = $2, halted_at = COALESCE(CASE WHEN ledger_integrity.halted THEN ledger_integrity.halted_at END, now()),
       last_check_at = now(), last_check_ok = false, last_check_detail = $3`,
    [chainId, reason, JSON.stringify(detail)],
  );
  await audit(db, "forge:ledger-self-check", "ALERT:ledger_halted", `chain:${chainId}`, { reason, ...detail });
}

async function recordCheck(db: Db, chainId: number, ok: boolean, detail: Record<string, unknown>) {
  await db.query(
    `INSERT INTO ledger_integrity(chain_id, last_check_at, last_check_ok, last_check_detail) VALUES ($1, now(), $2, $3)
     ON CONFLICT (chain_id) DO UPDATE SET last_check_at = now(), last_check_ok = $2, last_check_detail = $3`,
    [chainId, ok, JSON.stringify(detail)],
  );
}

/** Why the attestor must not sign right now (null = integrity verified). */
export async function signingBlockedReason(q: Queryable, chainId: number): Promise<string | null> {
  const i = await ledgerIntegrity(q, chainId);
  if (!i || i.lastCheckAt === null) return "LEDGER_INTEGRITY_UNVERIFIED: no materialized-ledger self-check has run yet.";
  if (i.halted) return `LEDGER_HALTED: ${i.haltReason ?? "integrity failure"} — operator review required (docs/W05-DATABASE-LEDGER.md §7).`;
  if (!i.lastCheckOk) return "LEDGER_INTEGRITY_UNVERIFIED: the last self-check did not pass.";
  return null;
}

export interface SelfCheckDeps {
  db: Db;
  chainId: number;
  ledger: LedgerContext;
  checkpointName: string;
  /**
   * On-chain splitter reconcile() deficit per asset at the checkpoint block.
   * Throws when the chain cannot be read (the check then does not pass, but
   * does not halt: an RPC outage is not evidence of a ledger fault).
   */
  readDeficits?: (assets: Address[], block: bigint) => Promise<Map<Address, bigint>>;
}

export interface SelfCheckResult {
  ok: boolean;
  halted: boolean;
  checkpoint: string | null;
  materializedDigest: string;
  referenceDigest: string;
  genesisFoldDigest: string;
  source: FoldSource;
  snapshotBlock: string | null;
  events: number;
  deficits: Array<{ asset: Address; deficit: string }>;
  problems: string[];
  durationMs: number;
}

export async function runLedgerSelfCheck(d: SelfCheckDeps): Promise<SelfCheckResult> {
  const t0 = performance.now();
  const snap = await readOnlySnapshotTx(d.db, async (q) => {
    const cp = await readCheckpoint(q, d.checkpointName);
    const mat = await loadFoldAt(q, d.chainId, d.ledger, cp?.block ?? null);
    const allEvents = await readEvents(q, d.chainId, null, null);
    const reference = buildLedger(allEvents, d.ledger);
    const genesis = foldAll(allEvents, d.ledger);
    return { cp, mat, reference, genesis, events: allEvents.length };
  });
  const materialized = finalizeFold(snap.mat.state);
  const result: SelfCheckResult = {
    ok: true,
    halted: false,
    checkpoint: snap.cp?.block.toString() ?? null,
    materializedDigest: ledgerDigest(materialized),
    referenceDigest: ledgerDigest(snap.reference),
    genesisFoldDigest: ledgerDigest(finalizeFold(snap.genesis)),
    source: snap.mat.source,
    snapshotBlock: snap.mat.snapshotBlock?.toString() ?? null,
    events: snap.events,
    deficits: [],
    problems: [],
    durationMs: 0,
  };
  const haltReasons: string[] = [];
  if (result.materializedDigest !== result.referenceDigest) haltReasons.push("MATERIALIZED_LEDGER_DIVERGENCE");
  if (result.genesisFoldDigest !== result.referenceDigest) haltReasons.push("FOLD_REFERENCE_DIVERGENCE");
  if (snap.mat.fallbackReason) result.problems.push(`snapshot not used: ${snap.mat.fallbackReason}`);

  if (d.ledger.splitter && d.readDeficits && snap.cp) {
    const assets = [...new Set<Address>([NATIVE, ...snap.reference.splitterTotals.keys()])];
    try {
      const deficits = await d.readDeficits(assets, snap.cp.block);
      for (const [asset, deficit] of deficits) {
        if (deficit > 0n) result.deficits.push({ asset, deficit: deficit.toString() });
      }
      if (result.deficits.length) haltReasons.push("SPLITTER_DEFICIT");
    } catch (e) {
      result.ok = false;
      result.problems.push(`splitter reconcile read failed: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  result.durationMs = Math.round(performance.now() - t0);
  const detail = { ...result, problems: [...result.problems, ...haltReasons] };
  if (haltReasons.length) {
    result.ok = false;
    result.halted = true;
    result.problems.push(...haltReasons);
    await haltLedger(d.db, d.chainId, haltReasons.join(", "), detail);
  } else {
    await recordCheck(d.db, d.chainId, result.ok, detail);
  }
  return result;
}

/**
 * Operator action: lifts a halt ONLY if a fresh self-check passes now. The
 * clearing is audited with the operator's identity and note.
 */
export async function clearLedgerHalt(d: SelfCheckDeps, operator: string, note: string): Promise<{ cleared: boolean; check: SelfCheckResult }> {
  // Evaluate the check without letting the still-set flag short-circuit it.
  const check = await runLedgerSelfCheck(d);
  if (!check.ok) return { cleared: false, check };
  await d.db.query("UPDATE ledger_integrity SET halted = false, halt_reason = NULL, cleared_at = now(), cleared_by = $2 WHERE chain_id = $1", [d.chainId, operator]);
  await audit(d.db, operator, "ledger_halt_cleared", `chain:${d.chainId}`, { note, referenceDigest: check.referenceDigest });
  return { cleared: true, check };
}
