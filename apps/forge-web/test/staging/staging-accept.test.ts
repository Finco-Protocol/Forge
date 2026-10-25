/**
 * W06 staging acceptance. Runs the REAL web (`next start`) and worker
 * (`tsx scripts/worker.ts`) as separate OS processes against a scratch
 * PostgreSQL database and a local Anvil chain, with a simulated GitHub.
 *
 *   FORGE_STAGING_ADMIN_URL=postgres://user:pw@127.0.0.1:5432/postgres \
 *   pnpm test:staging        (needs `pnpm build` and `forge build --profile forge`)
 *
 * Every step appends a record to the evidence file
 * (test-results/w06-staging-acceptance.json; W06_EVIDENCE_FILE overrides).
 * SIMULATED: chain (Anvil), GitHub (FakeGithub). REAL: PostgreSQL, the
 * processes, migrations, pg_dump/pg_restore, kill signals.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { encodeFunctionData, parseEther, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ponsV2BondingCurveAbi, ponsV2LaunchFactoryAbi } from "@/shared/abis.generated";
import { reviveLaunchArgs, reviveTypedData, type LaunchTxJson } from "@/shared/launch-tx";
import { createAppContext } from "@/server/context";
import { migrate, readMigrations } from "@/server/db/migrate";
import { PgDb } from "@/server/db";
import { assertStagingChain, StagingConfigError } from "@/server/staging/guard";
import { HttpClient, StagingStack, stopProc } from "../../scripts/w06/staging-stack";
import { APP_ROOT, backupDatabase, buildManifest, digestDatabase, dropDatabase, restoreDatabase, rollbackPlan, verifyManifest, withDb } from "../../scripts/w06/staging-lib";
import { createDatabaseSql } from "../../scripts/w05/sql-ident";

const ADMIN = process.env.FORGE_STAGING_ADMIN_URL;
const EVIDENCE = process.env.W06_EVIDENCE_FILE ?? path.join(APP_ROOT, "test-results", "w06-staging-acceptance.json");
const records: Array<{ step: string; status: "PASS"; detail: Record<string, unknown> }> = [];
const rec = (step: string, detail: Record<string, unknown> = {}) => records.push({ step, status: "PASS", detail });

const describeStaging = ADMIN ? describe : describe.skip;
if (!ADMIN) console.warn("[staging] FORGE_STAGING_ADMIN_URL not set: the staging acceptance suite is skipped (it is a required CI job)");

describeStaging("W06 staging acceptance (separate web + worker processes, PostgreSQL, local chain, simulated GitHub)", () => {
  let stack: StagingStack;
  let token: { token: string; curve: string; creator: string } | null = null;
  let digestBeforeRestart: Awaited<ReturnType<typeof digestDatabase>>;
  const extraDbs: string[] = [];
  const creatorKey = generatePrivateKey();

  /**
   * The worker reacts to indexed fee events with its own transactions (revenue attestation), which are then indexed
   * as new chain events. A baseline digest is only meaningful once that cascade has settled: lag 0 and neither the
   * head block nor the number of indexed events changed for several consecutive samples.
   */
  async function quiesce(stableSamples = 4, everyMs = 1_500) {
    let last = "";
    let stable = 0;
    await stack.until("indexer quiescent", async () => {
      const h = await stack.opsGet("/api/ops/health");
      const probe = new PgDb(stack.dbUrl, { max: 2, applicationName: "forge-cli" });
      const n = (await probe.query<{ n: string }>("SELECT count(*)::text AS n FROM chain_events")).rows[0]!.n;
      await probe.close();
      const sig = `${h.json.indexer?.headBlock}|${h.json.indexer?.lagBlocks}|${n}`;
      stable = sig === last && h.json.indexer?.lagBlocks === "0" ? stable + 1 : 0;
      last = sig;
      return stable >= stableSamples;
    }, 90_000, everyMs);
  }

  beforeAll(async () => {
    stack = await StagingStack.create({ adminUrl: ADMIN!, leaseSeconds: 10 });
  }, 180_000);

  afterAll(async () => {
    for (const d of extraDbs) await dropDatabase(ADMIN!, d).catch(() => undefined);
    await stack?.stop().catch(() => undefined);
    mkdirSync(path.dirname(EVIDENCE), { recursive: true });
    writeFileSync(
      EVIDENCE,
      JSON.stringify(
        {
          kind: "w06-staging-acceptance",
          simulated: ["chain: local Anvil 31337", "GitHub: in-process FakeGithub (SANDBOX_NOT_EVIDENCE)"],
          real: ["PostgreSQL server", "separate web and worker OS processes", "migrations", "pg_dump/pg_restore", "SIGTERM/SIGKILL"],
          notExecutedHere: ["docker compose (no Docker daemon in this environment; statically verified by test/unit/w06-staging-package.test.ts)"],
          steps: records,
        },
        null,
        2,
      ),
    );
  });

  it("config refusal: unsafe settings are refused BEFORE any state is touched", async () => {
    const unsafe: Array<[string, Record<string, string>, string]> = [
      ["chain 4663", { FORGE_CHAIN_ID: "4663", FORGE_NETWORK: "robinhood" }, "STAGING_NETWORK"],
      ["public RPC host", { FORGE_RPC_URL: "https://rpc.mainnet.chain.robinhood.com" }, "STAGING_RPC_HOST"],
      ["real GitHub", { GITHUB_API_URL: "https://api.github.com", GITHUB_WEB_URL: "https://github.com" }, "STAGING_GITHUB_REAL"],
      ["non-test key", { FORGE_RELAYER_PRIVATE_KEY: generatePrivateKey() }, "STAGING_KEY_NOT_TEST_ONLY"],
      ["burn flag", { FINCO_BURN_ENABLED: "true" }, "STAGING_FLAG"],
      ["signing flag", { PRODUCTION_SIGNING_ENABLED: "true" }, "STAGING_FLAG"],
      ["production-looking database", { DATABASE_URL: withDb(ADMIN!, "forge_production") }, "STAGING_DATABASE"],
    ];
    for (const [name, patch, code] of unsafe) {
      const err = await createAppContext({ ...stack.env, ...patch }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, name).toBeInstanceOf(StagingConfigError);
      expect((err as StagingConfigError).violations.map((v) => v.code), name).toContain(code);
    }
    // a separate OS process refuses too (exit != 0) and the database stays empty
    stack.startWorker({ FORGE_CHAIN_ID: "4663", FORGE_NETWORK: "robinhood" });
    const code = await stack.worker!.exited;
    expect(code).not.toBe(0);
    expect(readFileSync(stack.worker!.logFile, "utf8")).toContain("STAGING_CONFIG_REFUSED");
    const probe = new PgDb(stack.dbUrl, { max: 2, applicationName: "forge-cli" });
    const t = (await probe.query<{ t: string | null }>("SELECT to_regclass('schema_migrations')::text AS t")).rows[0]!.t;
    await probe.close();
    expect(t, "a refused start must not create any schema").toBeNull();
    rec("config_refusal", { cases: unsafe.map(([n]) => n), workerExitCode: code, schemaUntouched: true });
  });

  it("refuses an RPC that is not a local dev chain (chain 4663 probe)", async () => {
    const srv = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1237" })); // 4663
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    await expect(assertStagingChain(`http://127.0.0.1:${port}`)).rejects.toMatchObject({ violations: [{ code: "STAGING_RPC_CHAIN_MISMATCH" }] });
    srv.close();
    await expect(assertStagingChain(stack.anvil.url)).resolves.toBe(31337);
    rec("production_chain_refusal", { probedChainId: 4663, refused: true, localChainAccepted: 31337 });
  });

  it("migration from an empty database; a second run applies nothing", async () => {
    const first = await stack.migrate();
    expect(first.code, first.output).toBe(0);
    const names = readMigrations().map((m) => m.name);
    expect(first.output).toContain(names[names.length - 1]!);
    const second = await stack.migrate();
    expect(second.code, second.output).toBe(0);
    expect(second.output).toMatch(/applied:\s*\[\s*\]/);
    rec("migrate_from_empty", { migrations: names, secondRunApplied: 0 });
  });

  it("cold start: web + worker as separate processes become ready", async () => {
    await stack.startWeb();
    stack.startWorker();
    const ready = await stack.until("ready", async () => {
      const r = await fetch(`${stack.origin}/api/ready`);
      return r.status === 200 ? ((await r.json()) as Record<string, unknown>) : null;
    }, 90_000);
    const health = await stack.opsGet("/api/ops/health");
    expect(health.status).toBe(200);
    expect(health.json.db.migration.pending).toEqual([]);
    expect((await fetch(`${stack.origin}/api/ops/health`)).status).toBe(401);
    rec("cold_start", { ready, workerApplicationName: health.json.worker.workers?.[0]?.applicationName, migrationVersion: health.json.db.migration.version });
  });

  it("a real launch flows through web → chain → worker/indexer (state for the restart tests)", async () => {
    const client = new HttpClient(stack.origin);
    await client.signInGithub(stack.github, 1001);
    await stack.rpc("anvil_setBalance", [privateKeyToAccount(creatorKey).address, "0x3635C9ADC5DEA00000"]);
    expect((await client.bindWallet(creatorKey)).status).toBe(200);
    expect((await client.post("/api/github/verify", { repoId: 5001, installationId: 7001 })).status).toBe(200);
    const draft = await client.post("/api/launch/drafts", { repoId: 5001, installationId: 7001, name: "Staging Demo", symbol: "STG", description: "staging acceptance (sandbox)", logo: "https://example.org/l.png", socials: { website: "https://example.org" }, launchConfigId: 0, creatorTaxBps: 100, buybackEnabled: false, snipeTaxExemptions: [] });
    expect(draft.status, JSON.stringify(draft.json)).toBe(201);
    const auth = await client.post(`/api/launch/drafts/${draft.json.id}/authorize`);
    expect(auth.status, JSON.stringify(auth.json)).toBe(200);
    const signature = await privateKeyToAccount(creatorKey).signTypedData(reviveTypedData(auth.json.typedData));
    const signed = await client.post(`/api/launch/intents/${auth.json.intentId}/signature`, { signature });
    expect(signed.status, JSON.stringify(signed.json)).toBe(200);
    const { wallet, pub } = stack.chain(creatorKey);
    const a = reviveLaunchArgs(signed.json.tx as LaunchTxJson);
    const txHash = await wallet.writeContract({ address: (signed.json.tx as LaunchTxJson).address, abi: ponsV2LaunchFactoryAbi, functionName: "launchToken", args: [a.params, a.launchConfigId, a.pairToken, a.exemptions], value: a.value });
    await pub.waitForTransactionReceipt({ hash: txHash });
    expect((await client.post(`/api/launch/intents/${auth.json.intentId}/submitted`, { txHash })).status).toBe(200);
    token = await stack.until("token indexed", async () => {
      const r = (await (await fetch(`${stack.origin}/api/tokens`)).json()) as { tokens: Array<{ token: string; curve: string; creator: string }> };
      return r.tokens.find((t) => t.creator.toLowerCase() === privateKeyToAccount(creatorKey).address.toLowerCase()) ?? null;
    }, 60_000);
    // trade + sweep so the ledger has fee events
    await stack.rpc("evm_increaseTime", [30]);
    await stack.rpc("evm_mine");
    const buyer = stack.chain(generatePrivateKey());
    await stack.rpc("anvil_setBalance", [buyer.account.address, "0x3635C9ADC5DEA00000"]);
    const buy = await buyer.wallet.sendTransaction({ to: token.curve as Hex, data: encodeFunctionData({ abi: ponsV2BondingCurveAbi, functionName: "buy", args: [parseEther("5"), 0n, buyer.account.address] }), value: parseEther("5") });
    await buyer.pub.waitForTransactionReceipt({ hash: buy });
    const sweep = await wallet.sendTransaction({ to: token.curve as Hex, data: encodeFunctionData({ abi: ponsV2BondingCurveAbi, functionName: "sweepFees", args: [0n] }) });
    await pub.waitForTransactionReceipt({ hash: sweep });
    await stack.until("lag 0", async () => (await stack.opsGet("/api/ops/health")).json.indexer?.lagBlocks === "0", 60_000);
    await quiesce();
    digestBeforeRestart = await digestDatabase(stack.dbUrl, stack.env);
    expect(digestBeforeRestart.counts.chain_events ?? 0).toBeGreaterThan(0);
    rec("seed_activity", { launched: token.token, chainEvents: digestBeforeRestart.counts.chain_events, ledgerDigest: digestBeforeRestart.ledgerDigest });
  }, 240_000);

  it("restart with existing state: nothing lost, the ledger digest is unchanged, graceful worker exit", async () => {
    const workerExit = await stack.stopWorker("SIGTERM");
    await stack.stopWeb("SIGTERM");
    expect(workerExit).toBe(0);
    await stack.startWeb();
    stack.startWorker();
    await stack.until("ready again", async () => (await fetch(`${stack.origin}/api/ready`)).status === 200, 90_000);
    const tokens = (await (await fetch(`${stack.origin}/api/tokens`)).json()) as { tokens: Array<{ token: string }> };
    expect(tokens.tokens.map((t) => t.token)).toContain(token!.token);
    const after = await digestDatabase(stack.dbUrl, stack.env);
    expect(after.ledgerDigest).toBe(digestBeforeRestart.ledgerDigest);
    expect(after.counts.chain_events).toBe(digestBeforeRestart.counts.chain_events);
    rec("restart_with_state", { workerExitCode: workerExit, ledgerDigestUnchanged: true, chainEvents: after.counts.chain_events });
  }, 240_000);

  it("indexer recovery: the chain advances while the worker is down; on restart it catches up to the same digest as a full recompute", async () => {
    await stack.stopWorker("SIGTERM");
    const buyer = stack.chain(generatePrivateKey());
    await stack.rpc("anvil_setBalance", [buyer.account.address, "0x3635C9ADC5DEA00000"]);
    for (let i = 0; i < 3; i++) {
      const h = await buyer.wallet.sendTransaction({ to: token!.curve as Hex, data: encodeFunctionData({ abi: ponsV2BondingCurveAbi, functionName: "buy", args: [parseEther("1"), 0n, buyer.account.address] }), value: parseEther("1") });
      await buyer.pub.waitForTransactionReceipt({ hash: h });
    }
    const behind = await stack.opsGet("/api/ops/health");
    expect(Number(behind.json.indexer.lagBlocks), "the indexer must be behind while the worker is down").toBeGreaterThan(0);
    expect((await fetch(`${stack.origin}/api/ready`)).status, "readiness must withhold traffic while the worker is down").toBe(503);
    stack.startWorker();
    await stack.until("indexer caught up", async () => (await stack.opsGet("/api/ops/health")).json.indexer?.lagBlocks === "0", 90_000);
    const d = await digestDatabase(stack.dbUrl, stack.env);
    expect(d.ledgerDigest).toBe(d.materializedDigest);
    expect(d.counts.chain_events ?? 0).toBeGreaterThan(digestBeforeRestart.counts.chain_events ?? 0);
    rec("indexer_recovery", { lagWhileDown: Number(behind.json.indexer.lagBlocks), readyWhileDown: 503, caughtUp: true, ledgerEqualsMaterialized: true, eventsBefore: digestBeforeRestart.counts.chain_events, eventsAfter: d.counts.chain_events });
  }, 240_000);

  it("worker crash (SIGKILL while holding a job lease): the job is recovered after the lease expires", async () => {
    const db = new PgDb(stack.dbUrl, { max: 2, applicationName: "forge-cli" });
    // a job claimed by a worker that then dies: attempts bumped, lease in the future
    const ins = await db.query<{ id: string }>("INSERT INTO jobs(kind, dedupe_key, payload, status, attempts, run_after) VALUES ('repo_revalidate', 'w06-crash', '{\"repoId\":\"5001\"}', 'pending', 1, now() + interval '10 seconds') RETURNING id::text");
    const id = ins.rows[0]!.id;
    const killed = await stack.stopWorker("SIGKILL");
    expect(killed === null || killed === 137 || killed !== 0).toBe(true);
    const during = (await db.query<{ status: string }>("SELECT status FROM jobs WHERE id = $1", [id])).rows[0]!.status;
    expect(during).toBe("pending");
    stack.startWorker();
    const done = await stack.until("job done", async () => {
      const r = (await db.query<{ status: string; attempts: number }>("SELECT status, attempts FROM jobs WHERE id = $1", [id])).rows[0]!;
      return r.status === "done" ? r : null;
    }, 90_000);
    await db.close();
    await stack.until("ready after crash", async () => (await fetch(`${stack.origin}/api/ready`)).status === 200, 60_000);
    rec("worker_crash_recovery", { killSignal: "SIGKILL", jobStatusWhileDown: during, finalStatus: done.status, attempts: done.attempts });
  }, 240_000);

  it("failed migration handling: nothing is half-applied; a build against an un-migrated database refuses to serve", async () => {
    const name = `forge_staging_fm_${Date.now().toString(36)}`;
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(createDatabaseSql(name));
    await admin.end();
    extraDbs.push(name);
    const url = withDb(ADMIN!, name);
    const db = new PgDb(url, { max: 3, applicationName: "forge-cli" });
    const dir = mkdtempSync(path.join(tmpdir(), "forge-w06-mig-"));
    for (const m of readMigrations()) writeFileSync(path.join(dir, m.name), m.sql);
    await migrate(db, dir);
    writeFileSync(path.join(dir, "999_w06_bad.sql"), "CREATE TABLE w06_half_applied (id int);\nINSERT INTO w06_table_that_does_not_exist VALUES (1);\n");
    await expect(migrate(db, dir)).rejects.toThrow();
    const exists = (await db.query<{ t: string | null }>("SELECT to_regclass('w06_half_applied')::text AS t")).rows[0]!.t;
    const recorded = (await db.query("SELECT 1 FROM schema_migrations WHERE name = '999_w06_bad.sql'")).rows.length;
    expect(exists, "the failed migration's first statement must be rolled back").toBeNull();
    expect(recorded).toBe(0);
    await db.close();
    // a DB that was never migrated: verify mode refuses (fail closed)
    const empty = `forge_staging_em_${Date.now().toString(36)}`;
    const a2 = new pg.Client({ connectionString: ADMIN });
    await a2.connect();
    await a2.query(createDatabaseSql(empty));
    await a2.end();
    extraDbs.push(empty);
    await expect(createAppContext({ ...stack.env, DATABASE_URL: withDb(ADMIN!, empty), FORGE_DB_MIGRATE: "verify" })).rejects.toThrow(/DB_STARTUP_CHECK_FAILED.*pending/);
    rec("failed_migration_handling", { halfAppliedTable: false, badMigrationRecorded: false, verifyModeRefusesUnmigratedDb: true });
  }, 120_000);

  it("backup / restore of the live staging database: matching ledger digest, counts and migrations; rollback planning", async () => {
    const dump = path.join(stack.workdir, "staging.dump");
    backupDatabase(stack.dbUrl, dump);
    const before = await digestDatabase(stack.dbUrl, stack.env);
    const restoredName = `forge_staging_rs_${Date.now().toString(36)}`;
    const restoredUrl = await restoreDatabase(ADMIN!, dump, restoredName);
    extraDbs.push(restoredName);
    const after = await digestDatabase(restoredUrl, stack.env);
    // the live DB keeps moving (heartbeats, audit); the financial sources must match exactly
    for (const t of ["chain_events", "indexer_checkpoints", "ledger_snapshots", "schema_migrations"]) expect(after.counts[t], t).toBe(before.counts[t]);
    expect(after.ledgerDigest).toBe(before.ledgerDigest);
    expect(after.materializedDigest).toBe(before.materializedDigest);
    expect(after.migrations).toEqual(before.migrations);
    // rollback planning against manifests
    const manifest = buildManifest();
    expect(verifyManifest(manifest)).toEqual([]);
    const probe = new PgDb(stack.dbUrl, { max: 2, applicationName: "forge-cli" });
    const same = await rollbackPlan(probe, manifest);
    expect(same).toMatchObject({ safe: true, action: "code-only" });
    const older = { ...manifest, migrations: manifest.migrations.slice(0, -1) };
    const newer = await rollbackPlan(probe, older);
    await probe.close();
    expect(newer).toMatchObject({ safe: false, action: "restore-snapshot-required" });
    expect(newer.unknownToTarget).toEqual([manifest.migrations[manifest.migrations.length - 1]!.name]);
    // tamper evidence
    expect(verifyManifest({ ...manifest, app: { ...manifest.app, version: "9.9.9" } })).toContain("MANIFEST_DIGEST_MISMATCH: the manifest was edited after it was generated");
    expect(existsSync(dump)).toBe(true);
    rec("backup_restore_and_rollback", { ledgerDigest: after.ledgerDigest, materializedDigest: after.materializedDigest, chainEvents: after.counts.chain_events, rollbackToOlderBuild: newer.action, manifestDigest: manifest.digest });
  }, 180_000);

  it("graceful shutdown: SIGTERM stops the worker with exit 0", async () => {
    const code = await stopProc(stack.worker, "SIGTERM");
    expect(code).toBe(0);
    rec("graceful_worker_shutdown", { exitCode: code });
  });
});
