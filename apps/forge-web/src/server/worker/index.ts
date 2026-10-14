/**
 * Background worker: indexer, launch-intent tracking, Proof of Build
 * receipts, on-chain revocation jobs and periodic reconciliation. Every step
 * is idempotent; the worker can be killed at any point and restarted.
 */
import { getAddress } from "viem";
import type { AppContext } from "../context";
import { ForgeIndexer } from "../indexer/indexer";
import { issueLaunchReceipt, retractOrphanedReceipts } from "../proof/ledger";
import { refreshIntent } from "../launch/service";
import { revokeOnChain } from "../eligibility/registry-ops";
import { reconcileAll, reconcileRepository } from "../github/reconcile";
import { audit } from "../audit";
import { readRegistryState } from "../chain/forge";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { Queryable } from "../db";
import { maybeRunLedgerSelfCheck, runRevenueAttestation } from "../finance/service";
import type { AttestationOutcome } from "../finance/attestor";

/** Non-critical jobs give up (with an alert) after this many attempts. */
const MAX_ATTEMPTS = 8;
/** Critical jobs (they narrow on-chain eligibility) NEVER give up: they retry with capped backoff. */
const CRITICAL_KINDS = new Set(["registry_revoke", "repo_revalidate"]);
const CRITICAL_MAX_BACKOFF_SECONDS = 60;
/** A critical job retrying this many times raises an operator alert (once). */
const ALERT_AFTER_ATTEMPTS = 3;

export interface ClaimedJob {
  id: string;
  kind: string;
  payload: Record<string, string>;
  attempts: number;
  alerted_at: Date | null;
}

/**
 * Claims up to `limit` ready jobs. FOR UPDATE SKIP LOCKED keeps concurrent
 * claimers from blocking on or double-claiming the same row WITHIN the claim
 * statement; the lease (run_after pushed `leaseSeconds` ahead) keeps the job
 * invisible to other workers AFTER the claim commits, while it is processed.
 * (W05: without the lease a second worker could re-claim an in-flight job —
 * see test/pg/worker-concurrency.test.ts.) The processing outcome always
 * rewrites status/run_after; a crashed worker's job becomes visible again
 * when its lease expires.
 */
export async function claimJobs(db: Queryable, limit: number, leaseSeconds: number): Promise<ClaimedJob[]> {
  const { rows } = await db.query<ClaimedJob>(
    `UPDATE jobs SET attempts = attempts + 1, run_after = now() + ($2 || ' seconds')::interval WHERE id IN (
       SELECT id FROM jobs WHERE status = 'pending' AND run_after <= now() ORDER BY priority, id LIMIT $1 FOR UPDATE SKIP LOCKED
     ) RETURNING id::text, kind, payload, attempts, alerted_at`,
    [limit, String(leaseSeconds)],
  );
  return rows;
}

export async function runJobs(ctx: AppContext, limit = 20): Promise<Array<{ id: string; kind: string; ok: boolean; error?: string }>> {
  const rows = await claimJobs(ctx.db, limit, ctx.cfg.worker.jobLeaseSeconds);
  rows.sort((a, b) => Number(CRITICAL_KINDS.has(b.kind)) - Number(CRITICAL_KINDS.has(a.kind)) || Number(a.id) - Number(b.id));
  const results = [];
  for (const j of rows) {
    try {
      if (j.kind === "registry_revoke") {
        const repoId = BigInt(j.payload.repoId!);
        await revokeOnChain(ctx, repoId, j.payload.reason ?? "revoked", j.payload.creator ? getAddress(j.payload.creator) : undefined);
        // Done only when the chain (at the confirmation depth used by revokeOnChain) shows no active binding
        // for the revoked creator (or any creator when none was named).
        const s = await readRegistryState(ctx.client, ctx.cfg.addresses, repoId);
        const stillActive = s.binding.exists && s.binding.revokedAt === 0n && (!j.payload.creator || getAddress(s.binding.creator) === getAddress(j.payload.creator));
        if (stillActive) throw new Error("binding still active after revocation attempt");
      } else if (j.kind === "repo_revalidate") {
        await reconcileRepository(ctx, j.payload.repoId!);
      } else {
        throw new Error(`unknown job kind ${j.kind}`);
      }
      const done = await ctx.db.query<{ latency: string }>(
        "UPDATE jobs SET status = 'done', last_error = NULL, completed_at = now() WHERE id = $1 RETURNING extract(epoch FROM now() - created_at)::text AS latency",
        [j.id],
      );
      if (j.kind === "registry_revoke") {
        await audit(ctx.db, "forge:worker", "revocation_job_confirmed", `job:${j.id}`, { repoId: j.payload.repoId, latencySeconds: Number(done.rows[0]?.latency ?? 0) });
      }
      results.push({ id: j.id, kind: j.kind, ok: true });
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0]!;
      const critical = CRITICAL_KINDS.has(j.kind);
      const final = !critical && j.attempts >= MAX_ATTEMPTS;
      const backoff = critical ? Math.min(CRITICAL_MAX_BACKOFF_SECONDS, 2 ** j.attempts) : Math.min(3600, 2 ** j.attempts * 5);
      await ctx.db.query(
        `UPDATE jobs SET status = $2, last_error = $3, run_after = now() + ($4 || ' seconds')::interval WHERE id = $1`,
        [j.id, final ? "failed" : "pending", msg, String(backoff)],
      );
      if (final) await audit(ctx.db, "forge:worker", "ALERT:job_failed_permanently", `job:${j.id}`, { kind: j.kind, error: msg });
      if (critical && j.attempts >= ALERT_AFTER_ATTEMPTS && !j.alerted_at) {
        await ctx.db.query("UPDATE jobs SET alerted_at = now() WHERE id = $1", [j.id]);
        await audit(ctx.db, "forge:worker", "ALERT:revocation_retrying", `job:${j.id}`, { kind: j.kind, attempts: j.attempts, error: msg });
      }
      results.push({ id: j.id, kind: j.kind, ok: false, error: msg });
    }
  }
  return results;
}

/**
 * Revocation watchdog: every repository the service has invalidated, and
 * every confirmed binding whose creator no longer has an active wallet
 * binding, must be INACTIVE on chain. If not (missed job, or a confirmed
 * revocation later reorged out), a fresh revocation job is enqueued, keyed by
 * the live registry sequence so a new head always yields a new job.
 */
export async function ensureRevocationsFinal(ctx: AppContext): Promise<string[]> {
  const { rows } = await ctx.db.query<{ repo_id: string; creator: string; reason: string }>(
    `SELECT DISTINCT o.repo_id::text, o.creator, COALESCE(r.ineligible_reason, 'wallet_binding_revoked') AS reason
       FROM registry_ops o
       LEFT JOIN repositories r ON r.repo_id = o.repo_id
      WHERE o.revoke = false AND o.status = 'confirmed'
        AND (r.ineligible_reason IS NOT NULL
             OR NOT EXISTS (SELECT 1 FROM wallet_bindings w WHERE w.wallet_address = o.creator AND w.revoked_at IS NULL))`,
  );
  const enqueued: string[] = [];
  for (const r of rows) {
    const s = await readRegistryState(ctx.client, ctx.cfg.addresses, BigInt(r.repo_id));
    if (!s.binding.exists || s.binding.revokedAt !== 0n || getAddress(s.binding.creator) !== getAddress(r.creator)) continue;
    const ins = await ctx.db.query(
      "INSERT INTO jobs(kind, dedupe_key, payload) VALUES ('registry_revoke', $1, $2) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id",
      [`watchdog:${r.repo_id}:${r.creator}:${s.opSequence}`, JSON.stringify({ repoId: r.repo_id, creator: r.creator, reason: r.reason })],
    );
    if (ins.rows.length) {
      enqueued.push(r.repo_id);
      await audit(ctx.db, "forge:worker", "ALERT:revocation_not_final", `repo:${r.repo_id}`, { creator: r.creator, reason: r.reason, opSequence: s.opSequence });
    }
  }
  return enqueued;
}

export interface RevocationHealth {
  pending: number;
  oldestPendingSeconds: number;
  retrying: number;
  lastLatencySeconds: number | null;
  sloSeconds: number;
  breached: boolean;
}

export async function revocationHealth(ctx: AppContext): Promise<RevocationHealth> {
  const p = (
    await ctx.db.query<{ n: string; oldest: string | null; retrying: string }>(
      `SELECT count(*)::text AS n, max(extract(epoch FROM now() - created_at))::text AS oldest, count(*) FILTER (WHERE attempts > 0)::text AS retrying
         FROM jobs WHERE status = 'pending' AND kind = 'registry_revoke'`,
    )
  ).rows[0]!;
  const last = (
    await ctx.db.query<{ latency: string }>(
      "SELECT extract(epoch FROM completed_at - created_at)::text AS latency FROM jobs WHERE kind = 'registry_revoke' AND status = 'done' ORDER BY completed_at DESC LIMIT 1",
    )
  ).rows[0];
  const oldest = Number(p.oldest ?? 0);
  return {
    pending: Number(p.n),
    oldestPendingSeconds: oldest,
    retrying: Number(p.retrying),
    lastLatencySeconds: last ? Number(last.latency) : null,
    sloSeconds: ctx.cfg.revocationSloSeconds,
    breached: oldest > ctx.cfg.revocationSloSeconds,
  };
}

export interface WorkerPass {
  indexed: number;
  reorgedTo: bigint | null;
  receipts: string[];
  retractions: string[];
  jobs: number;
  attestations: AttestationOutcome[];
}

export async function runWorkerOnce(ctx: AppContext, opts: { reconcile?: boolean; shouldStop?: () => boolean } = {}): Promise<WorkerPass> {
  // Revocations first: they narrow eligibility and must not wait behind routine indexing.
  const firstJobs = await runJobs(ctx);
  await ensureRevocationsFinal(ctx);
  const indexer = new ForgeIndexer(ctx);
  let indexed = 0;
  let reorgedTo: bigint | null = null;
  for (let i = 0; i < 50 && !opts.shouldStop?.(); i++) {
    const r = await indexer.tick();
    indexed += r.events;
    if (r.reorgedTo !== null) {
      reorgedTo = r.reorgedTo;
      continue;
    }
    if (r.to === null) break;
  }
  // W05: periodic materialized-vs-reference ledger self-check (halts on divergence / splitter deficit).
  try {
    await maybeRunLedgerSelfCheck(ctx);
  } catch (e) {
    console.error("[forge-worker] ledger self-check:", (e as Error).message.split("\n")[0]);
  }
  // W04 Correction A: raise splitter ceilings from finalised, indexed evidence, then index the authorizations.
  let attestations: AttestationOutcome[] = [];
  try {
    attestations = await runRevenueAttestation(ctx);
  } catch (e) {
    console.error("[forge-worker] revenue attestation:", (e as Error).message.split("\n")[0]);
  }
  if (attestations.some((a) => a.status === "AUTHORIZED")) {
    for (let i = 0; i < 5; i++) {
      const r = await indexer.tick();
      indexed += r.events;
      if (r.to === null && r.reorgedTo === null) break;
    }
  }
  const retractions = await retractOrphanedReceipts(ctx);
  const live = await ctx.db.query<{ id: string }>("SELECT id FROM launch_intents WHERE status IN ('awaiting_signature','signed','submitted','included')");
  for (const i of live.rows) await refreshIntent(ctx, i.id).catch(() => undefined);
  const receipts: string[] = [];
  const pending = await ctx.db.query<{ token: string }>(
    `SELECT t.token FROM tokens t WHERE t.github_repo_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM evidence_receipts r WHERE r.token = t.token AND r.seq = (SELECT max(seq) FROM evidence_receipts r2 WHERE r2.token = t.token) AND r.kind = 'launch')`,
  );
  for (const t of pending.rows) if (await issueLaunchReceipt(ctx, t.token)) receipts.push(t.token);
  // Intents whose launch is now confirmed by the indexer.
  for (const i of live.rows) await refreshIntent(ctx, i.id).catch(() => undefined);
  const jobs = await runJobs(ctx);
  if (opts.reconcile) await reconcileAll(ctx);
  return { indexed, reorgedTo, receipts, retractions, jobs: firstJobs.length + jobs.length, attestations };
}

export type WorkerState = "starting" | "running" | "stopping" | "stopped";

export async function recordHeartbeat(
  db: Queryable,
  w: { id: string; applicationName: string },
  state: WorkerState,
  pass?: { ms: number; error: string | null },
) {
  await db.query(
    `INSERT INTO worker_heartbeats(worker_id, application_name, pid, hostname, state, passes, last_pass_ms, last_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (worker_id) DO UPDATE SET state = $5, beat_at = now(),
       passes = worker_heartbeats.passes + $6, last_pass_ms = COALESCE($7, worker_heartbeats.last_pass_ms), last_error = $8`,
    [w.id, w.applicationName, process.pid, hostname(), state, pass ? 1 : 0, pass ? Math.round(pass.ms) : null, pass?.error ?? null],
  );
}

export interface WorkerHandle {
  readonly id: string;
  /**
   * Graceful stop: no new pass starts, the current pass stops picking new
   * indexer ranges and finishes what it holds, the heartbeat is marked
   * `stopped`. Resolves when the loop has fully exited (the caller then
   * closes the pool). Idempotent.
   */
  stop(): Promise<void>;
  /** Resolves when the loop exits. */
  readonly done: Promise<void>;
}

export function startWorkerLoop(ctx: AppContext, intervalMs = 2_000, reconcileEveryMs = 10 * 60_000): WorkerHandle {
  let stopped = false;
  let lastReconcile = 0;
  let wake: (() => void) | null = null;
  const w = { id: `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`, applicationName: ctx.cfg.db.pool.applicationName };
  const beat = (state: WorkerState, pass?: { ms: number; error: string | null }) =>
    recordHeartbeat(ctx.db, w, state, pass).catch((e) => console.error("[forge-worker] heartbeat:", (e as Error).message));
  const loop = async () => {
    await beat("starting");
    while (!stopped) {
      const reconcile = Date.now() - lastReconcile > reconcileEveryMs;
      const t0 = performance.now();
      let error: string | null = null;
      try {
        await runWorkerOnce(ctx, { reconcile, shouldStop: () => stopped });
        if (reconcile) lastReconcile = Date.now();
      } catch (e) {
        error = (e as Error).message.split("\n")[0]!;
        console.error("[forge-worker]", (e as Error).message);
      }
      await beat(stopped ? "stopping" : "running", { ms: performance.now() - t0, error });
      if (stopped) break;
      await new Promise<void>((r) => {
        const t = setTimeout(r, intervalMs);
        wake = () => {
          clearTimeout(t);
          r();
        };
      });
      wake = null;
    }
    await beat("stopped");
  };
  const done = loop();
  return {
    id: w.id,
    done,
    stop: () => {
      stopped = true;
      (wake as (() => void) | null)?.();
      return done;
    },
  };
}
