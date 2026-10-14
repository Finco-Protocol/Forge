/**
 * Standalone worker process (production: one or more replicas against
 * PostgreSQL). application_name = forge-worker. SIGTERM/SIGINT: stop picking
 * new work, finish the current pass, mark the heartbeat stopped, close the
 * pool, exit 0. A second signal (or the grace timeout) exits immediately
 * with code 1; every step is idempotent, so a hard stop is safe, only slower
 * to recover (job leases must expire).
 */
import { createAppContext } from "../src/server/context";
import { startWorkerLoop } from "../src/server/worker";

// Config is parsed inside createAppContext, after this default is set.
process.env.FORGE_PROCESS_ROLE ??= "worker";

const ctx = await createAppContext();
console.log(`[forge-worker] chain ${ctx.cfg.chainId} factory ${ctx.cfg.addresses.factory} (${ctx.cfg.db.pool.applicationName})`);
const worker = startWorkerLoop(ctx, Number(process.env.FORGE_WORKER_INTERVAL_MS ?? 2000));
const graceMs = Number(process.env.FORGE_WORKER_SHUTDOWN_GRACE_MS ?? 60_000);
let shuttingDown = false;
const shutdown = (sig: string) => {
  if (shuttingDown) {
    console.error(`[forge-worker] ${sig} again: exiting immediately`);
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`[forge-worker] ${sig}: finishing current pass`);
  const force = setTimeout(() => {
    console.error("[forge-worker] shutdown grace exceeded: exiting");
    process.exit(1);
  }, graceMs);
  force.unref();
  void worker
    .stop()
    .then(() => ctx.db.close())
    .then(
      () => {
        console.log("[forge-worker] stopped cleanly");
        process.exit(0);
      },
      (e: unknown) => {
        console.error("[forge-worker] shutdown error:", (e as Error).message);
        process.exit(1);
      },
    );
};
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => shutdown(sig));
