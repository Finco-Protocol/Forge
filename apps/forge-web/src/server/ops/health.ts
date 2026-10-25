/**
 * W05 operational health (GET /api/health): database round-trip latency and
 * pool usage, schema migration version, indexer lag, worker heartbeats and
 * the ledger integrity flag. Every probe is independent: one failing probe
 * is reported, never thrown, so the endpoint stays usable during incidents.
 */
import type { AppContext } from "../context";
import { migrationStatus } from "../db/migrate";
import { checkpointName } from "../indexer/indexer";
import { ledgerIntegrity } from "../finance/materialized";

const errMsg = (e: unknown) => (e as Error).message.split("\n")[0]!;

export async function dbHealth(ctx: AppContext) {
  const t0 = performance.now();
  try {
    await ctx.db.query("SELECT 1");
    const latencyMs = Math.round((performance.now() - t0) * 100) / 100;
    const m = await migrationStatus(ctx.db);
    return {
      ok: m.pending.length === 0 && m.drift.length === 0 && m.unknown.length === 0,
      latencyMs,
      pool: ctx.db.stats(),
      migration: { version: m.version, applied: m.applied.length, expected: m.expected.length, pending: m.pending, drift: m.drift.map((d) => d.name), unknown: m.unknown },
    };
  } catch (e) {
    return { ok: false, latencyMs: null, pool: ctx.db.stats(), error: errMsg(e) };
  }
}

export async function indexerHealth(ctx: AppContext) {
  try {
    const { rows } = await ctx.db.query<{ last_block: string; updated_at: Date }>("SELECT last_block::text, updated_at FROM indexer_checkpoints WHERE name = $1", [checkpointName(ctx)]);
    const head = await ctx.client.getBlockNumber({ cacheTime: 0 }).catch(() => null);
    const last = rows[0] ? BigInt(rows[0].last_block) : null;
    const safeHead = head === null ? null : head - BigInt(ctx.cfg.confirmations);
    return {
      ok: last !== null && safeHead !== null,
      lastIndexedBlock: last?.toString() ?? null,
      headBlock: head?.toString() ?? null,
      /** Blocks between the finality-safe head and the checkpoint (0 = fully caught up). */
      lagBlocks: last !== null && safeHead !== null ? (safeHead > last ? safeHead - last : 0n).toString() : null,
      checkpointAgeSeconds: rows[0] ? Math.round((Date.now() - new Date(rows[0].updated_at).getTime()) / 1000) : null,
      confirmations: ctx.cfg.confirmations,
    };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

export async function workerHealth(ctx: AppContext) {
  try {
    const { rows } = await ctx.db.query<{ worker_id: string; application_name: string; state: string; beat_at: Date; passes: string; last_pass_ms: number | null; last_error: string | null; age: string }>(
      `SELECT worker_id, application_name, state, beat_at, passes::text, last_pass_ms, last_error, extract(epoch FROM now() - beat_at)::text AS age
         FROM worker_heartbeats WHERE state <> 'stopped' OR beat_at > now() - interval '1 day' ORDER BY beat_at DESC LIMIT 20`,
    );
    const stale = ctx.cfg.worker.heartbeatStaleSeconds;
    const workers = rows.map((r) => ({ id: r.worker_id, applicationName: r.application_name, state: r.state, ageSeconds: Math.round(Number(r.age)), passes: Number(r.passes), lastPassMs: r.last_pass_ms, lastError: r.last_error }));
    const live = workers.filter((w) => w.state !== "stopped" && w.ageSeconds <= stale);
    return { ok: live.length > 0, live: live.length, staleAfterSeconds: stale, workers };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

export async function ledgerHealth(ctx: AppContext) {
  try {
    const i = await ledgerIntegrity(ctx.db, ctx.cfg.chainId);
    const snap = (
      await ctx.db.query<{ block_number: string; created_at: Date; bytes: string }>(
        "SELECT block_number::text, created_at, octet_length(state)::text AS bytes FROM ledger_snapshots WHERE chain_id = $1 ORDER BY ledger_snapshots.block_number DESC LIMIT 1",
        [ctx.cfg.chainId],
      )
    ).rows[0];
    return {
      ok: !(i?.halted ?? false),
      mode: ctx.cfg.ledger.mode,
      halted: i?.halted ?? false,
      haltReason: i?.haltReason ?? null,
      lastCheckAt: i?.lastCheckAt ?? null,
      lastCheckOk: i?.lastCheckOk ?? null,
      latestSnapshot: snap ? { block: snap.block_number, createdAt: snap.created_at, bytes: Number(snap.bytes) } : null,
    };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

export async function systemHealth(ctx: AppContext) {
  const [db, indexer, worker, ledger] = await Promise.all([dbHealth(ctx), indexerHealth(ctx), workerHealth(ctx), ledgerHealth(ctx)]);
  return { db, indexer, worker, ledger };
}

/**
 * W07 liveness/readiness split:
 *  - `/api/live` is process liveness only: it touches no dependency at all and
 *    answers 200 as long as the event loop serves requests.
 *  - `/api/ready` refuses readiness (HTTP 503) while a CRITICAL dependency is
 *    unavailable: the database (incl. migration drift), the primary RPC and the
 *    ledger integrity flag. A halted ledger means the financial projection is
 *    not trustworthy; an unreachable RPC means nothing can be signed or read.
 *    Indexer/worker degradation is reported by /api/health and alerts (they
 *    catch up by design and are covered by their own rules), so they do not
 *    flip readiness by themselves.
 */
export function liveness() {
  return { ok: true as const, live: true as const, at: new Date().toISOString() };
}

export async function readiness(ctx: AppContext) {
  const [db, ledger] = await Promise.all([dbHealth(ctx), ledgerHealth(ctx)]);
  const block = await ctx.client.getBlockNumber({ cacheTime: 0 }).catch(() => null);
  const failing: string[] = [];
  if (!db.ok) failing.push("db");
  if (block === null) failing.push("rpc");
  if (!ledger.ok) failing.push("ledger");
  return {
    ok: failing.length === 0,
    ready: failing.length === 0,
    failing,
    // Booleans only — no connection strings, no error bodies (see /api/ops/health).
    db: { ok: db.ok },
    rpc: { ok: block !== null },
    ledger: { ok: ledger.ok, halted: ledger.halted },
  };
}
