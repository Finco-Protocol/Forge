import { createAppContext } from "../src/server/context";
import { startWorkerLoop } from "../src/server/worker";

const ctx = await createAppContext();
console.log(`[forge-worker] chain ${ctx.cfg.chainId} factory ${ctx.cfg.addresses.factory}`);
const stop = startWorkerLoop(ctx, Number(process.env.FORGE_WORKER_INTERVAL_MS ?? 2000));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (stop(), ctx.db.close().finally(() => process.exit(0))));
