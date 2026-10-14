/**
 * W05 production DB mode on REAL PostgreSQL: concurrent migrations under the
 * advisory lock, checksum drift / downgrade refusal, fail-closed startup
 * checks, pool limits and per-process application_name.
 */
import { cpSync, mkdtempSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { advisoryKey, PgDb, type Queryable } from "@/server/db";
import { assertDatabaseReady, migrate, migrationStatus, MIGRATION_LOCK, readMigrations } from "@/server/db/migrate";
import { dbConfigFromEnv } from "@/server/config";
import { adminQuery, describePg, scratchDb } from "../helpers/pg";

const SRC = path.resolve(process.cwd(), "src", "server", "db", "migrations");
const ALL = readMigrations(SRC).map((f) => f.name);

function migrationsCopy(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "forge-mig-"));
  cpSync(SRC, dir, { recursive: true });
  return dir;
}

describePg("W05 production PostgreSQL mode", () => {
  const dbs: Array<{ drop(): Promise<void> }> = [];
  const pools: PgDb[] = [];
  const open = (url: string, extra: ConstructorParameters<typeof PgDb>[1] = {}) => {
    const p = new PgDb(url, { max: 4, ...extra });
    pools.push(p);
    return p;
  };
  const fresh = async () => {
    const d = await scratchDb();
    dbs.push(d);
    return d;
  };
  beforeAll(async () => {
    // Fails loudly (not a skip) when the configured server is unreachable.
    const d = await fresh();
    expect(d.url).toContain(d.name);
  });
  afterAll(async () => {
    for (const p of pools) await p.close().catch(() => undefined);
    for (const d of dbs) await d.drop().catch(() => undefined);
  });

  it("6 processes migrating one fresh database concurrently: every migration applied exactly once, all agree on the version", async () => {
    const d = await fresh();
    const procs = Array.from({ length: 6 }, (_, i) => open(d.url, { applicationName: `forge-mig-${i}` }));
    const t0 = performance.now();
    const results = await Promise.all(procs.map((p) => migrate(p)));
    const ms = performance.now() - t0;
    expect(results.flat().sort()).toEqual(ALL);
    expect(results.filter((r) => r.length > 0).length).toBe(1);
    const rows = await adminQuery<{ name: string; checksum: string }>(d.url, "SELECT name, checksum FROM schema_migrations ORDER BY name");
    expect(rows.map((r) => r.name)).toEqual(ALL);
    expect(rows.map((r) => r.checksum)).toEqual(readMigrations(SRC).map((f) => f.checksum));
    for (const p of procs) await assertDatabaseReady(p);
    console.log(`[pg] concurrent migrate (6 pools, ${ALL.length} migrations): ${ms.toFixed(0)} ms`);
  });

  it("the migration lock is a real cluster-wide advisory lock: a held lock blocks migrators until timeout", async () => {
    const d = await fresh();
    const holder = new pg.Client({ connectionString: d.url });
    await holder.connect();
    await holder.query("SELECT pg_advisory_lock($1::bigint)", [advisoryKey(MIGRATION_LOCK)]);
    const p = open(d.url);
    await expect(migrate(p, SRC, { lockTimeoutMs: 400 })).rejects.toThrow(/MIGRATION_LOCK_TIMEOUT/);
    expect((await adminQuery<{ t: string | null }>(d.url, "SELECT to_regclass('chain_events')::text AS t"))[0]!.t).toBeNull();
    await holder.query("SELECT pg_advisory_unlock($1::bigint)", [advisoryKey(MIGRATION_LOCK)]);
    await holder.end();
    expect(await migrate(p, SRC)).toEqual(ALL);
  });

  it("drift: an applied migration file that changed refuses startup before anything is applied", async () => {
    const d = await fresh();
    const dir = migrationsCopy();
    const p = open(d.url);
    await migrate(p, dir);
    appendFileSync(path.join(dir, "003_finance.sql"), "\n-- edited after being applied\nCREATE INDEX drift_idx ON fin_claim_submissions(asset);\n");
    writeFileSync(path.join(dir, "900_new.sql"), "CREATE TABLE should_not_exist (x int);\n");
    await expect(migrate(p, dir)).rejects.toThrow(/MIGRATION_DRIFT: .*003_finance\.sql/);
    expect((await adminQuery<{ t: string | null }>(d.url, "SELECT to_regclass('should_not_exist')::text AS t"))[0]!.t).toBeNull();
    await expect(assertDatabaseReady(p, dir)).rejects.toThrow(/DB_STARTUP_CHECK_FAILED: .*migration drift: 003_finance\.sql/);
  });

  it("downgrade: a database with a migration unknown to the code refuses startup", async () => {
    const d = await fresh();
    const p = open(d.url);
    await migrate(p);
    await p.query("INSERT INTO schema_migrations(name, checksum) VALUES ('999_from_the_future.sql', 'x')");
    await expect(migrate(p)).rejects.toThrow(/MIGRATION_UNKNOWN: .*999_from_the_future\.sql/);
    await expect(assertDatabaseReady(p)).rejects.toThrow(/unknown migrations in database: 999_from_the_future\.sql/);
  });

  it("schema not at the expected version (pending migration, e.g. FORGE_DB_MIGRATE=verify before a migrator ran) fails closed", async () => {
    const d = await fresh();
    const dir = migrationsCopy();
    const p = open(d.url);
    await migrate(p, dir);
    writeFileSync(path.join(dir, "990_later.sql"), "CREATE TABLE later (x int);\n");
    await expect(assertDatabaseReady(p, dir)).rejects.toThrow(/schema not at expected version: pending 990_later\.sql/);
    expect(await migrate(p, dir)).toEqual(["990_later.sql"]);
    expect((await assertDatabaseReady(p, dir)).migrations.version).toBe("990_later.sql");
  });

  it("pre-W05 rows without checksums are adopted once (trust on first use), then verified", async () => {
    const d = await fresh();
    const p = open(d.url);
    await migrate(p);
    await p.query("UPDATE schema_migrations SET checksum = NULL WHERE name = '001_init.sql'");
    expect(await migrate(p)).toEqual([]);
    const r = await adminQuery<{ checksum: string; adopted: boolean }>(d.url, "SELECT checksum, checksum_adopted_at IS NOT NULL AS adopted FROM schema_migrations WHERE name = '001_init.sql'");
    expect(r[0]).toEqual({ checksum: readMigrations(SRC)[0]!.checksum, adopted: true });
    expect((await migrationStatus(p)).drift).toEqual([]);
  });

  it("startup checks: server >= 14, plpgsql, session TimeZone forced to UTC even when the database default differs", async () => {
    const d = await fresh();
    await adminQuery(d.url, `ALTER DATABASE ${d.name} SET timezone = 'America/New_York'`);
    const p = open(d.url);
    await migrate(p);
    const rep = await assertDatabaseReady(p);
    expect(rep.serverVersionNum).toBeGreaterThanOrEqual(140000);
    expect(rep.timeZone).toBe("UTC");
    expect(rep.extensions).toContain("plpgsql");
    // A raw connection without the pool's session settings is in New York time: the check refuses it.
    const raw = new pg.Client({ connectionString: d.url });
    await raw.connect();
    const q: Queryable = { query: async <T>(sql: string, params: unknown[] = []) => ({ rows: (await raw.query(sql, params)).rows as T[] }) };
    await expect(assertDatabaseReady(q)).rejects.toThrow(/session TimeZone is America\/New_York, expected UTC/);
    await raw.end();
  });

  it("pool limits, statement_timeout, connection timeout and application_name per process role", async () => {
    const d = await fresh();
    const cfg = dbConfigFromEnv({ DATABASE_URL: d.url, FORGE_PROCESS_ROLE: "worker", FORGE_DB_POOL_MAX: "3", FORGE_DB_STATEMENT_TIMEOUT_MS: "300" });
    expect(cfg.pool).toMatchObject({ max: 3, statementTimeoutMs: 300, applicationName: "forge-worker" });
    const defaults = dbConfigFromEnv({});
    expect(defaults.pool).toEqual({ max: 10, idleTimeoutMs: 30_000, connectionTimeoutMs: 5_000, statementTimeoutMs: 30_000, idleInTransactionTimeoutMs: 60_000, applicationName: "forge-web" });
    const p = open(d.url, cfg.pool);
    // statement_timeout enforced server-side.
    await expect(p.query("SELECT pg_sleep(2)")).rejects.toThrow(/statement timeout/);
    // max: 3 concurrent sessions, the rest wait in the pool.
    const busy = Array.from({ length: 6 }, () => p.query("SELECT pg_sleep(0.2)"));
    await new Promise((r) => setTimeout(r, 50));
    const s = p.stats();
    expect(s.total).toBe(3);
    expect(s.waiting).toBeGreaterThan(0);
    const seen = await adminQuery<{ application_name: string; n: string }>(d.url, "SELECT application_name, count(*)::text AS n FROM pg_stat_activity WHERE datname = $1 AND application_name LIKE 'forge-%' GROUP BY 1", [d.name]);
    expect(seen).toEqual([{ application_name: "forge-worker", n: "3" }]);
    await Promise.all(busy);
    // Connection timeout: an unreachable server fails fast instead of hanging.
    const dead = open("postgres://nobody@10.255.255.1:5432/x", { connectionTimeoutMs: 300 });
    const t0 = performance.now();
    await expect(dead.query("SELECT 1")).rejects.toThrow();
    expect(performance.now() - t0).toBeLessThan(3_000);
  });
});
