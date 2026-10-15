/**
 * W05 platform benchmark over the REAL API on a local Anvil with PGlite
 * (sandbox mode: in-process DB, fake GitHub, mini-V4 mocks). Every number is a
 * wall-clock measurement (performance.now) from THIS run; nothing is
 * extrapolated. It measures this sandbox, not production infrastructure.
 *
 *   tsx scripts/w05/bench-platform.ts [--launches 12] [--reps 12] [--json out.json]
 */
import os from "node:os";
import { writeFileSync } from "node:fs";
import { getAddress } from "viem";
import { runWorkerOnce } from "../../src/server/worker";
import { treasuryReport } from "../../src/server/finance/service";
import { startSandbox, TestBrowser } from "../../test/helpers/sandbox";
import { freshScenario, launchThroughApi } from "../../test/helpers/scenario";
import { rpc } from "../../test/helpers/anvil";

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};
const LAUNCHES = Number(arg("launches", "12"));
const REPS = Number(arg("reps", "12"));

const stat = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return { n: s.length, min: +s[0]!.toFixed(1), median: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +s[s.length - 1]!.toFixed(1) };
};
const time = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
  const t = performance.now();
  const r = await fn();
  return [r, performance.now() - t];
};

async function main() {
  const sb = await startSandbox();
  const results: Record<string, unknown> = {};
  try {
    // ── per-launch timings (sequential; each launch = fresh user/org/repo/wallet) ──
    const verify: number[] = [], draft: number[] = [], authorize: number[] = [], e2e: number[] = [];
    const tokens: string[] = [];
    let anyBrowser: TestBrowser | null = null;
    let firstIntent: string | null = null;
    for (let i = 0; i < LAUNCHES; i++) {
      const sc = await freshScenario(sb, { verify: false });
      const [, v] = await time(async () => {
        const r = await sc.browser.post("/api/github/verify", { repoId: sc.repoId, installationId: sc.installationId });
        if (r.status !== 200) throw new Error(JSON.stringify(r.json));
      });
      verify.push(v);
      const [d, dt] = await time(() => sc.browser.post("/api/launch/drafts", sc.draft));
      draft.push(dt);
      const [a, at] = await time(() => sc.browser.post(`/api/launch/drafts/${d.json.id}/authorize`));
      authorize.push(at);
      if (a.status !== 200) throw new Error(JSON.stringify(a.json));
      // Full simulation of a launch from scratch on a second repo of the same user is not possible; time a whole fresh one:
      const sc2 = await freshScenario(sb);
      const [res, tt] = await time(() => launchThroughApi(sb, sc2.browser, sc2.key, sc2.draft));
      e2e.push(tt);
      tokens.push(getAddress(res.submitted.json.token));
      anyBrowser ??= sc2.browser;
      firstIntent ??= res.auth.json.intentId;
    }
    await runWorkerOnce(sb.ctx);
    results.repositoryVerification = { ms: stat(verify), note: "POST /api/github/verify against the fake GitHub service (network = loopback), includes DB writes" };
    results.launchDraftCreate = { ms: stat(draft) };
    results.launchAuthorize = { ms: stat(authorize), note: "includes signing-policy evaluation (live chain reads) + attestation signing with the LOCAL test signer; NOT KMS latency" };
    results.fullLaunchSimulation = { ms: stat(e2e), note: "fresh user → bind → verify → draft → authorize → creator EIP-712 signature → launch tx mined on Anvil → submitted" };

    // ── transaction-status polling ──
    const poll: number[] = [];
    for (let i = 0; i < REPS * 3; i++) poll.push((await time(() => anyBrowser!.get(`/api/launch/intents/${firstIntent}`)))[1]);
    results.transactionStatusPolling = { ms: stat(poll), note: "GET /api/launch/intents/:id (authenticated)" };

    // ── token discovery ──
    const disc: number[] = [];
    for (let i = 0; i < REPS * 3; i++) disc.push((await time(() => new TestBrowser(sb).get("/api/tokens")))[1]);
    const concurrent = await time(() => Promise.all(Array.from({ length: 10 }, () => new TestBrowser(sb).get("/api/tokens"))));
    results.tokenDiscovery = { tokens: tokens.length, sequentialMs: stat(disc), concurrent10TotalMs: +concurrent[1].toFixed(1) };

    // ── generate some fee activity, then ledger/treasury ──
    await rpc(sb.anvil.url, "evm_increaseTime", [30]);
    await rpc(sb.anvil.url, "evm_mine");
    await runWorkerOnce(sb.ctx);
    const treas: number[] = [];
    for (let i = 0; i < REPS; i++) treas.push((await time(() => treasuryReport(sb.ctx)))[1]);
    const events = await sb.ctx.db.query<{ n: string }>("SELECT count(*)::text AS n FROM chain_events");
    results.treasuryDashboard = { ms: stat(treas), chainEvents: Number(events.rows[0]!.n), launches: tokens.length, note: "treasuryReport(): materialized ledger + live contract reads at the checkpoint" };

    // ── indexer restart (wipe → full re-index) ──
    await sb.ctx.db.query("DELETE FROM chain_events");
    await sb.ctx.db.query("DELETE FROM indexed_blocks");
    await sb.ctx.db.query("DELETE FROM indexer_checkpoints");
    const [, restart] = await time(() => runWorkerOnce(sb.ctx));
    const head = await sb.ctx.client.getBlockNumber();
    results.indexerRestart = { ms: +restart.toFixed(1), blocks: Number(head), chainEventsAfter: Number((await sb.ctx.db.query<{ n: string }>("SELECT count(*)::text AS n FROM chain_events")).rows[0]!.n) };

    // ── worker backlog recovery: mine a backlog while the worker is idle, time the catch-up ──
    for (let i = 0; i < 2000; i++) await rpc(sb.anvil.url, "evm_mine");
    const [, backlog] = await time(() => runWorkerOnce(sb.ctx));
    results.workerBacklogRecovery = { backlogBlocks: 2000, ms: +backlog.toFixed(1), note: "one runWorkerOnce pass after 2000 empty blocks accumulated (batch size = FORGE_INDEXER_BATCH_BLOCKS)" };
  } finally {
    await sb.stop();
  }
  const report = {
    environment: {
      os: `${os.type()} ${os.release()} ${os.arch()}`,
      cpu: `${os.cpus()[0]?.model ?? "?"} × ${os.cpus().length}`,
      memGB: +(os.totalmem() / 2 ** 30).toFixed(1),
      node: process.version,
      db: "PGlite (in-process Postgres/WASM)",
      chain: "local Anvil (automine)",
      github: "in-process fake GitHub (loopback)",
      signer: "local-test (in-process); no KMS",
      concurrency: "1 unless stated",
      launches: LAUNCHES,
      repetitions: REPS,
    },
    results,
    caveat: "Sandbox measurements only. They say nothing about production throughput (real GitHub latency, KMS signing latency, Postgres network round-trips, RPC latency).",
  };
  const out = arg("json", "");
  if (out) writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
