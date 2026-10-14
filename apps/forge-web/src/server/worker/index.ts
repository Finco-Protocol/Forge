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

const MAX_ATTEMPTS = 8;

export async function runJobs(ctx: AppContext, limit = 20): Promise<Array<{ id: string; kind: string; ok: boolean; error?: string }>> {
  const { rows } = await ctx.db.query<{ id: string; kind: string; payload: Record<string, string>; attempts: number }>(
    `UPDATE jobs SET attempts = attempts + 1 WHERE id IN (
       SELECT id FROM jobs WHERE status = 'pending' AND run_after <= now() ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED
     ) RETURNING id::text, kind, payload, attempts`,
    [limit],
  );
  const results = [];
  for (const j of rows) {
    try {
      if (j.kind === "registry_revoke") {
        await revokeOnChain(ctx, BigInt(j.payload.repoId!), j.payload.reason ?? "revoked", j.payload.creator ? getAddress(j.payload.creator) : undefined);
      } else if (j.kind === "repo_revalidate") {
        await reconcileRepository(ctx, j.payload.repoId!);
      } else {
        throw new Error(`unknown job kind ${j.kind}`);
      }
      await ctx.db.query("UPDATE jobs SET status = 'done', last_error = NULL WHERE id = $1", [j.id]);
      results.push({ id: j.id, kind: j.kind, ok: true });
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0]!;
      const final = j.attempts >= MAX_ATTEMPTS;
      await ctx.db.query(
        `UPDATE jobs SET status = $2, last_error = $3, run_after = now() + ($4 || ' seconds')::interval WHERE id = $1`,
        [j.id, final ? "failed" : "pending", msg, String(Math.min(3600, 2 ** j.attempts * 5))],
      );
      if (final) await audit(ctx.db, "forge:worker", "job_failed_permanently", `job:${j.id}`, { kind: j.kind, error: msg });
      results.push({ id: j.id, kind: j.kind, ok: false, error: msg });
    }
  }
  return results;
}

export interface WorkerPass {
  indexed: number;
  reorgedTo: bigint | null;
  receipts: string[];
  retractions: string[];
  jobs: number;
}

export async function runWorkerOnce(ctx: AppContext, opts: { reconcile?: boolean } = {}): Promise<WorkerPass> {
  const indexer = new ForgeIndexer(ctx);
  let indexed = 0;
  let reorgedTo: bigint | null = null;
  for (let i = 0; i < 50; i++) {
    const r = await indexer.tick();
    indexed += r.events;
    if (r.reorgedTo !== null) {
      reorgedTo = r.reorgedTo;
      continue;
    }
    if (r.to === null) break;
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
  return { indexed, reorgedTo, receipts, retractions, jobs: jobs.length };
}

export function startWorkerLoop(ctx: AppContext, intervalMs = 2_000, reconcileEveryMs = 10 * 60_000) {
  let stopped = false;
  let lastReconcile = 0;
  const loop = async () => {
    while (!stopped) {
      const reconcile = Date.now() - lastReconcile > reconcileEveryMs;
      try {
        await runWorkerOnce(ctx, { reconcile });
        if (reconcile) lastReconcile = Date.now();
      } catch (e) {
        console.error("[forge-worker]", (e as Error).message);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}
