/**
 * Sandbox convenience: with FORGE_EMBEDDED_WORKER=true the indexer/worker
 * runs inside the Next.js server process (PGlite is single-process).
 * Production runs `pnpm worker` as a separate process against PostgreSQL.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.FORGE_EMBEDDED_WORKER !== "true") return;
  const { getAppContext } = await import("./server/context");
  const { startWorkerLoop } = await import("./server/worker");
  const ctx = await getAppContext();
  startWorkerLoop(ctx, 1500);
  console.log("[forge] embedded worker started (sandbox)");
}
