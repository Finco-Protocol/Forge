/**
 * W05 backup/restore rehearsal against a scratch PostgreSQL server.
 *
 *   FORGE_REHEARSAL_ADMIN_URL=postgres://user@host:port/postgres \
 *   [PG_BIN=/usr/lib/postgresql/16/bin] tsx scripts/w05/db-backup-rehearsal.ts [--events 20000]
 *
 * Steps: create source DB -> migrate -> seed a synthetic history through the
 * indexer-shaped write path (with ledger snapshots) + audit/jobs rows ->
 * record per-table row counts and the deterministic ledger digest ->
 * pg_dump -Fc -> restore with pg_restore into a FRESH database -> verify
 * (row counts of every table, schema migration checksums, snapshot-based
 * AND reference ledger digests, startup checks) -> drop both DBs.
 * Exit code 1 on any mismatch.
 */
import { randomBytes } from "node:crypto";
import { createDatabaseSql, dropDatabaseSql } from "./sql-ident";
import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { PgDb } from "../../src/server/db";
import { assertDatabaseReady, migrate } from "../../src/server/db/migrate";
import { ledgerDigest } from "../../src/server/finance/ledger-fold";
import { loadMaterializedLedger, loadReferenceLedger } from "../../src/server/finance/materialized";
import { audit } from "../../src/server/audit";
import { generateHistory, SYN_CONTEXT } from "./synthetic-history";
import { HARNESS_CHECKPOINT, seedHistory } from "./ledger-db-harness";

const admin = process.env.FORGE_REHEARSAL_ADMIN_URL;
if (!admin) throw new Error("set FORGE_REHEARSAL_ADMIN_URL (scratch PostgreSQL admin URL)");
const bin = process.env.PG_BIN ?? "/usr/lib/postgresql/16/bin";
const nEvents = Number(process.argv[process.argv.indexOf("--events") + 1] || 20000);
const withDb = (db: string) => { const u = new URL(admin); u.pathname = `/${db}`; return u.toString(); };
// per-run random suffix: two processes with the same PID on one server never share (or force-drop) a database
const sfx = `${process.pid}_${randomBytes(4).toString("hex")}`;
const created: string[] = [];
const src = `forge_rehearsal_src_${sfx}`, dst = `forge_rehearsal_restored_${sfx}`;
const log = (m: string) => console.log(`[rehearsal] ${m}`);
const t0 = performance.now();
const lap = () => `${Math.round(performance.now() - t0)} ms`;

const ac = new pg.Client({ connectionString: admin });
await ac.connect();
const ver = (await ac.query("SHOW server_version")).rows[0].server_version;
log(`server ${ver}; pg_dump ${execFileSync(path.join(bin, "pg_dump"), ["--version"]).toString().trim()}`);
let failed = false;
const dumpFile = path.join(mkdtempSync(path.join(tmpdir(), "forge-rehearsal-")), "forge.dump");
try {
  await ac.query(createDatabaseSql(src));
  created.push(src);
  const sdb = new PgDb(withDb(src), { max: 4, applicationName: "forge-cli" });
  await migrate(sdb);
  const h = generateHistory({ seed: 20261014, targetEvents: nEvents });
  const seeded = await seedHistory(sdb, h, { chainId: 31337, rangeBlocks: 25, snapshotMinBlocks: 50, ctx: SYN_CONTEXT });
  await audit(sdb, "rehearsal", "seeded", null, { events: h.events.length });
  await sdb.query("INSERT INTO jobs(kind, dedupe_key, payload) SELECT 'repo_revalidate', 'rehearsal:' || g, '{}' FROM generate_series(1, 50) g");
  log(`seeded ${h.events.length} events, ${seeded.ranges} ranges, ${seeded.snapshots} snapshots (${lap()})`);

  const tables = (await sdb.query<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).rows.map((r) => r.t);
  const counts = async (db: PgDb) => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${t}`)).rows[0]!.n)] as const)));
  const srcCounts = await counts(sdb);
  const srcRef = ledgerDigest((await loadReferenceLedger(sdb, 31337, SYN_CONTEXT, HARNESS_CHECKPOINT)).ledger);
  const srcMat = await loadMaterializedLedger(sdb, 31337, SYN_CONTEXT, HARNESS_CHECKPOINT);
  const srcMig = (await sdb.query("SELECT name, checksum FROM schema_migrations ORDER BY name")).rows;
  await sdb.close();

  execFileSync(path.join(bin, "pg_dump"), ["--format=custom", "--no-owner", `--file=${dumpFile}`, withDb(src)]);
  log(`pg_dump -Fc -> ${statSync(dumpFile).size} bytes (${lap()})`);
  await ac.query(createDatabaseSql(dst));
  created.push(dst);
  execFileSync(path.join(bin, "pg_restore"), ["--no-owner", "--exit-on-error", `--dbname=${withDb(dst)}`, dumpFile]);
  log(`pg_restore into fresh database complete (${lap()})`);

  const ddb = new PgDb(withDb(dst), { max: 4, applicationName: "forge-cli" });
  const report = await assertDatabaseReady(ddb);
  const dstCounts = await counts(ddb);
  const dstRef = ledgerDigest((await loadReferenceLedger(ddb, 31337, SYN_CONTEXT, HARNESS_CHECKPOINT)).ledger);
  const dstMat = await loadMaterializedLedger(ddb, 31337, SYN_CONTEXT, HARNESS_CHECKPOINT);
  const dstMig = (await ddb.query("SELECT name, checksum FROM schema_migrations ORDER BY name")).rows;
  const dstMatDigest = ledgerDigest(dstMat.ledger);
  await ddb.close();

  const check = (name: string, ok: boolean, detail = "") => { log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " " + detail : ""}`); if (!ok) failed = true; };
  for (const t of tables) check(`rows ${t}`, srcCounts[t] === dstCounts[t], `${srcCounts[t]} == ${dstCounts[t]}`);
  check("migration versions + checksums", JSON.stringify(srcMig) === JSON.stringify(dstMig), `${dstMig.length} migrations, version ${report.migrations.version}`);
  check("reference ledger digest", srcRef === dstRef, srcRef);
  check("materialized ledger digest (restored snapshots)", ledgerDigest(srcMat.ledger) === dstMatDigest && dstMatDigest === dstRef, `${dstMat.info.source}@${dstMat.info.snapshotBlock}`);
  check("startup checks on restored DB", true, `PostgreSQL ${report.serverVersion}, TimeZone ${report.timeZone}`);
  log(`total ${lap()}; ${tables.length} tables, ${h.events.length} chain_events`);
} catch (e) {
  failed = true;
  console.error("[rehearsal] ERROR", (e as Error).message);
} finally {
  // drop only databases THIS run successfully created
  for (const d of created) await ac.query(dropDatabaseSql(d, true)).catch(() => undefined);
  await ac.end();
}
log(failed ? "RESULT: FAILED" : "RESULT: OK");
process.exit(failed ? 1 : 0);
