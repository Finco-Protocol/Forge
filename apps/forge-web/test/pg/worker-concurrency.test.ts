/**
 * W05 worker isolation on REAL PostgreSQL with several worker processes
 * (separate pools = separate sessions): no job processed twice, no indexer
 * range committed twice, leader lock + checkpoint compare-and-swap, the
 * materialized ledger equals the reference, graceful SIGTERM shutdown.
 */
import { spawn } from "node:child_process";
import { afterAll, beforeAll, expect, it } from "vitest";
import { parseEther, type Address, type Hex } from "viem";
import { ponsV2BondingCurveAbi } from "@/shared/abis.generated";
import { PgDb } from "@/server/db";
import { migrate } from "@/server/db/migrate";
import { claimJobs, runJobs, runWorkerOnce, startWorkerLoop } from "@/server/worker";
import { ForgeIndexer, type TickResult } from "@/server/indexer/indexer";
import { loadLedger, ledgerSelfCheck } from "@/server/finance/service";
import { ledgerContextFor, loadReferenceLedger } from "@/server/finance/materialized";
import { ledgerDigest } from "@/server/finance/ledger-fold";
import { checkpointName } from "@/server/indexer/indexer";
import type { AppContext } from "@/server/context";
import { adminQuery, describePg, scratchDb, startPgSandbox, type PgSandbox } from "../helpers/pg";
import { chainClients, TestBrowser, ANVIL_KEYS } from "../helpers/sandbox";
import { freshScenario, launchThroughApi } from "../helpers/scenario";
import { rpc } from "../helpers/anvil";
import type { Sandbox } from "../helpers/sandbox";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describePg("W05 job queue: concurrent workers on PostgreSQL", () => {
  let d: Awaited<ReturnType<typeof scratchDb>>;
  const pools: PgDb[] = [];
  beforeAll(async () => {
    d = await scratchDb();
    const p = new PgDb(d.url);
    pools.push(p);
    await migrate(p);
    await p.query("CREATE TABLE w05_processed (job_id bigint NOT NULL, worker text NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp())");
  });
  afterAll(async () => {
    for (const p of pools) await p.close().catch(() => undefined);
    await d?.drop();
  });

  it("4 workers × claim/process/complete over 600 jobs: every job processed exactly once (lease + SKIP LOCKED)", async () => {
    const admin = pools[0]!;
    await admin.query("INSERT INTO jobs(kind, dedupe_key, payload) SELECT 'w05_test', 'w05:' || g, '{}' FROM generate_series(1, 600) g");
    const workers = Array.from({ length: 4 }, (_, i) => {
      const p = new PgDb(d.url, { max: 3, applicationName: `forge-worker-${i}` });
      pools.push(p);
      return { p, name: `w${i}` };
    });
    await Promise.all(
      workers.map(async (w) => {
        for (let idle = 0; idle < 3; ) {
          const jobs = await claimJobs(w.p, 7, 60);
          if (!jobs.length) {
            idle++;
            await sleep(20);
            continue;
          }
          idle = 0;
          for (const j of jobs) {
            await w.p.query("INSERT INTO w05_processed(job_id, worker) VALUES ($1, $2)", [j.id, w.name]);
            await sleep(Math.random() * 3); // processing time: the claim has committed, the row lock is gone
            await w.p.query("UPDATE jobs SET status = 'done', completed_at = now() WHERE id = $1", [j.id]);
          }
        }
      }),
    );
    const r = (await admin.query<{ n: string; distinct_jobs: string; workers: string }>("SELECT count(*)::text AS n, count(DISTINCT job_id)::text AS distinct_jobs, count(DISTINCT worker)::text AS workers FROM w05_processed")).rows[0]!;
    expect(r).toEqual({ n: "600", distinct_jobs: "600", workers: "4" });
    expect((await admin.query<{ n: string }>("SELECT count(*)::text AS n FROM jobs WHERE kind = 'w05_test' AND (status <> 'done' OR attempts <> 1)")).rows[0]!.n).toBe("0");
  });

  it("regression proof: the pre-W05 claim (no lease) re-delivers an in-flight job to a second worker; the leased claim does not", async () => {
    const admin = pools[0]!;
    const legacy = (p: PgDb) =>
      p.query<{ id: string }>(
        `UPDATE jobs SET attempts = attempts + 1 WHERE id IN (
           SELECT id FROM jobs WHERE status = 'pending' AND run_after <= now() AND kind = 'w05_regress' ORDER BY priority, id LIMIT 1 FOR UPDATE SKIP LOCKED
         ) RETURNING id::text`,
      );
    const [a, b] = [pools[1]!, pools[2]!];
    await admin.query("INSERT INTO jobs(kind, dedupe_key, payload) VALUES ('w05_regress', 'regress:1', '{}')");
    const first = (await legacy(a)).rows;
    const second = (await legacy(b)).rows; // worker A is still "processing"
    expect(first.length).toBe(1);
    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id)); // the double-processing bug
    await admin.query("DELETE FROM jobs WHERE kind = 'w05_regress'");
    await admin.query("INSERT INTO jobs(kind, dedupe_key, payload) VALUES ('w05_regress', 'regress:2', '{}')");
    const leasedA = (await claimJobs(a, 1, 60)).filter((j) => j.kind === "w05_regress");
    const leasedB = (await claimJobs(b, 1, 60)).filter((j) => j.kind === "w05_regress");
    expect(leasedA.length).toBe(1);
    expect(leasedB).toEqual([]);
  });

  it("runJobs from 3 concurrent worker contexts claims each job once (attempts = 1, results disjoint)", async () => {
    const admin = pools[0]!;
    await admin.query("INSERT INTO jobs(kind, dedupe_key, payload) SELECT 'w05_unknown_kind', 'unk:' || g, '{}' FROM generate_series(1, 120) g");
    const ctxs = [1, 2, 3].map((i) => ({ db: pools[i]!, cfg: { worker: { jobLeaseSeconds: 60 } } }) as unknown as AppContext);
    const results = await Promise.all(ctxs.map(async (c) => (await Promise.all([runJobs(c, 50), runJobs(c, 50)])).flat()));
    const ids = results.flat().filter((r) => r.kind === "w05_unknown_kind").map((r) => r.id);
    expect(ids.length).toBe(120);
    expect(new Set(ids).size).toBe(120);
    expect((await admin.query<{ n: string }>("SELECT count(*)::text AS n FROM jobs WHERE kind = 'w05_unknown_kind' AND attempts <> 1")).rows[0]!.n).toBe("0");
  });
});

describePg("W05 indexer + workers on PostgreSQL (real contracts)", () => {
  let sb: PgSandbox;
  let main: AppContext;
  const BUYER = ANVIL_KEYS[6] as Hex;

  async function activity(launches: number, buys: number) {
    // The scenario helpers drive the real API against `main` (a PostgreSQL-backed context).
    const asSandbox = { anvil: sb.anvil, deployment: sb.deployment, github: sb.github, ctx: main, env: sb.env, stop: async () => undefined } as Sandbox;
    const curves: Address[] = [];
    for (let i = 0; i < launches; i++) {
      const sc = await freshScenario(asSandbox);
      const l = await launchThroughApi(asSandbox, sc.browser as TestBrowser, sc.key, sc.draft);
      curves.push(l.submitted.json.curve as Address);
    }
    await rpc(sb.anvil.url, "evm_increaseTime", [20]);
    const { wallet, pub, account } = chainClients(sb.anvil.url, BUYER);
    for (let i = 0; i < buys; i++) {
      const h = await wallet.writeContract({ address: curves[i % curves.length]!, abi: ponsV2BondingCurveAbi, functionName: "buy", args: [parseEther("0.5"), 0n, account.address], value: parseEther("0.5") });
      await pub.waitForTransactionReceipt({ hash: h });
    }
    await rpc(sb.anvil.url, "anvil_mine", ["0x20"]);
  }

  async function assertNoDoubleIndexing(results: TickResult[]) {
    const ranges = results.filter((r) => r.from !== null && r.to !== null).map((r) => [r.from!, r.to!] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    expect(results.filter((r) => r.reorgedTo !== null)).toEqual([]);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]![0]).toBe(ranges[i - 1]![1] + 1n); // disjoint AND contiguous
    const head = await main.client.getBlockNumber({ cacheTime: 0 });
    const cp = (await main.db.query<{ last_block: string }>("SELECT last_block::text FROM indexer_checkpoints WHERE name = $1", [checkpointName(main)])).rows[0]!;
    expect(BigInt(cp.last_block)).toBe(head);
    return ranges;
  }

  beforeAll(async () => {
    sb = await startPgSandbox({ FORGE_INDEXER_BATCH_BLOCKS: "3", FORGE_LEDGER_SNAPSHOT_MIN_BLOCKS: "2", FORGE_LEDGER_SELF_CHECK_INTERVAL_MS: "0" });
    main = await sb.context("web");
  });
  afterAll(async () => sb?.stop());

  it("3 concurrent indexers (leader lock): every block range committed exactly once; materialized ledger ≡ reference", async () => {
    await activity(2, 6);
    const idx = await Promise.all([1, 2, 3].map(async () => new ForgeIndexer(await sb.context("worker"))));
    const results: TickResult[] = [];
    await Promise.all(
      idx.map(async (ix) => {
        for (let i = 0; i < 200; i++) {
          const r = await ix.tick();
          results.push(r);
          if (r.to === null && r.skipped === undefined && r.reorgedTo === null) break;
        }
      }),
    );
    const ranges = await assertNoDoubleIndexing(results);
    expect(ranges.length).toBeGreaterThan(5);
    expect(results.some((r) => r.skipped === "not_leader")).toBe(true);
    const dup = await adminQuery<{ n: string }>(sb.db.url, "SELECT count(*)::text AS n FROM (SELECT tx_hash, log_index FROM chain_events GROUP BY 1, 2 HAVING count(*) > 1) x");
    expect(dup[0]!.n).toBe("0");
    const snaps = await adminQuery<{ n: string }>(sb.db.url, "SELECT count(*)::text AS n FROM ledger_snapshots");
    expect(Number(snaps[0]!.n)).toBeGreaterThan(0);
    const mat = await loadLedger(main);
    const ref = await loadReferenceLedger(main.db, main.cfg.chainId, ledgerContextFor(main.cfg.addresses), checkpointName(main));
    expect(ledgerDigest(mat.ledger)).toBe(ledgerDigest(ref.ledger));
    expect(mat.ledger.tokens.size).toBe(2);
    expect((await ledgerSelfCheck(main)).ok).toBe(true);
  });

  it("without the leader lock, the checkpoint compare-and-swap alone still prevents double indexing", async () => {
    await activity(1, 4);
    const idx = await Promise.all([1, 2, 3, 4].map(async () => new ForgeIndexer(await sb.context("worker"), { leaderLock: false })));
    const results: TickResult[] = [];
    await Promise.all(
      idx.map(async (ix) => {
        for (let i = 0; i < 300; i++) {
          const r = await ix.tick();
          results.push(r);
          if (r.to === null && r.skipped === undefined && r.reorgedTo === null) break;
        }
      }),
    );
    await assertNoDoubleIndexing(results.filter((r) => r.from !== null && r.from > 0n));
    expect(results.some((r) => r.skipped === "checkpoint_moved")).toBe(true);
    const dup = await adminQuery<{ n: string }>(sb.db.url, "SELECT count(*)::text AS n FROM (SELECT tx_hash, log_index FROM chain_events GROUP BY 1, 2 HAVING count(*) > 1) x");
    expect(dup[0]!.n).toBe("0");
    expect((await ledgerSelfCheck(main)).ok).toBe(true);
  });

  it("two worker loops run side by side and stop gracefully (heartbeats → stopped); state stays consistent", async () => {
    const [c1, c2] = [await sb.context("worker"), await sb.context("worker")];
    const w1 = startWorkerLoop(c1, 100);
    const w2 = startWorkerLoop(c2, 100);
    await activity(1, 3);
    await sleep(3_000);
    await Promise.all([w1.stop(), w2.stop()]);
    const hb = await adminQuery<{ worker_id: string; state: string; passes: string; application_name: string }>(sb.db.url, "SELECT worker_id, state, passes::text, application_name FROM worker_heartbeats WHERE worker_id = ANY($1)", [[w1.id, w2.id]]);
    expect(hb.map((h) => h.state)).toEqual(["stopped", "stopped"]);
    expect(hb.every((h) => Number(h.passes) > 0 && h.application_name === "forge-worker")).toBe(true);
    const r = await runWorkerOnce(main); // catch up whatever the loops left
    expect(r.reorgedTo).toBeNull();
    expect((await ledgerSelfCheck(main)).ok).toBe(true);
    const health = await (await import("@/server/ops/health")).systemHealth(main);
    expect(health.db.ok).toBe(true);
    expect(health.db.migration?.version).toBe("005_ledger_materialization.sql");
    expect(health.ledger.halted).toBe(false);
    expect(health.indexer.lagBlocks).toBe("0");
  });

  it("scripts/worker.ts: SIGTERM finishes the pass, marks the heartbeat stopped, closes its pool and exits 0", async () => {
    const count = async () => Number((await adminQuery<{ n: string }>(sb.db.url, "SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = $1 AND application_name = 'forge-worker'", [sb.db.name]))[0]!.n);
    const before = await count(); // idle sessions of this test's own worker contexts
    const env: NodeJS.ProcessEnv = { ...process.env, ...sb.env, FORGE_WORKER_INTERVAL_MS: "200" };
    delete env.FORGE_PROCESS_ROLE; // the script defaults its role to "worker"
    // node --import tsx: the worker runs in THIS pid (the tsx CLI would add a wrapper process).
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/worker.ts"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b) => (out += String(b)));
    child.stderr.on("data", (b) => (out += String(b)));
    const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
    let running = false;
    for (let i = 0; i < 150 && !running; i++) {
      await sleep(200);
      const rows = await adminQuery<{ n: string }>(sb.db.url, "SELECT count(*)::text AS n FROM worker_heartbeats WHERE pid = $1 AND state IN ('starting', 'running')", [child.pid]);
      running = rows[0]!.n !== "0";
    }
    expect(running, out).toBe(true);
    expect(await count()).toBeGreaterThan(before);
    child.kill("SIGTERM");
    const code = await Promise.race([exited, sleep(30_000).then(() => "timeout" as const)]);
    expect(code, out).toBe(0);
    expect(out).toContain("stopped cleanly");
    const hb = await adminQuery<{ state: string }>(sb.db.url, "SELECT state FROM worker_heartbeats WHERE pid = $1", [child.pid]);
    expect(hb.map((h) => h.state)).toEqual(["stopped"]);
    await sleep(300);
    expect(await count()).toBeLessThanOrEqual(before); // the child's pool is closed
  });
});
