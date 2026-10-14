import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Db, Queryable } from "./index";

const DIR = path.resolve(process.cwd(), "src", "server", "db", "migrations");

/** Advisory lock name serializing migrators across processes (web + worker + CLI). */
export const MIGRATION_LOCK = "schema-migrations";
/** Oldest supported server (server_version_num). */
export const MIN_SERVER_VERSION_NUM = 140000;

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

/** sha256 of the file with line endings normalised (a CRLF checkout is not drift). */
export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

export function readMigrations(dir = DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => {
      const sql = readFileSync(path.join(dir, name), "utf8");
      return { name, sql, checksum: migrationChecksum(sql) };
    });
}

export class MigrationError extends Error {
  constructor(
    readonly code: "MIGRATION_DRIFT" | "MIGRATION_UNKNOWN" | "MIGRATION_LOCK_TIMEOUT",
    detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

interface AppliedRow {
  name: string;
  checksum: string | null;
}

async function ensureTable(q: Queryable) {
  await q.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  await q.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text");
  await q.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum_adopted_at timestamptz");
}

export interface MigrationStatus {
  /** Files in the code, in order. */
  expected: string[];
  applied: string[];
  pending: string[];
  /** Applied migrations whose file content changed since they were applied. */
  drift: Array<{ name: string; applied: string; file: string }>;
  /** Applied migrations the code does not know (DB is newer than the code: downgrade). */
  unknown: string[];
  /** Latest applied migration name (schema version). */
  version: string | null;
}

export function compareMigrations(files: MigrationFile[], applied: AppliedRow[]): MigrationStatus {
  const byName = new Map(files.map((f) => [f.name, f]));
  const appliedNames = new Set(applied.map((r) => r.name));
  const drift = applied
    .filter((r) => r.checksum !== null && byName.has(r.name) && byName.get(r.name)!.checksum !== r.checksum)
    .map((r) => ({ name: r.name, applied: r.checksum!, file: byName.get(r.name)!.checksum }));
  const sortedApplied = [...appliedNames].sort();
  return {
    expected: files.map((f) => f.name),
    applied: sortedApplied,
    pending: files.filter((f) => !appliedNames.has(f.name)).map((f) => f.name),
    drift,
    unknown: sortedApplied.filter((n) => !byName.has(n)),
    version: sortedApplied.length ? sortedApplied[sortedApplied.length - 1]! : null,
  };
}

export async function migrationStatus(db: Queryable, dir = DIR): Promise<MigrationStatus> {
  const exists = (await db.query<{ t: string | null }>("SELECT to_regclass('schema_migrations')::text AS t")).rows[0]?.t;
  const files = readMigrations(dir);
  if (!exists) return compareMigrations(files, []);
  const hasChecksum = (await db.query<{ n: string }>("SELECT count(*)::text AS n FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'schema_migrations' AND column_name = 'checksum'")).rows[0]!.n !== "0";
  const rows = (await db.query<AppliedRow>(hasChecksum ? "SELECT name, checksum FROM schema_migrations" : "SELECT name, NULL::text AS checksum FROM schema_migrations")).rows;
  return compareMigrations(files, rows);
}

function assertNoDriftOrDowngrade(st: MigrationStatus) {
  if (st.unknown.length) {
    throw new MigrationError("MIGRATION_UNKNOWN", `database has migrations unknown to this code (${st.unknown.join(", ")}): refusing to run an older build against a newer schema (no down migrations; see docs/W05-DATABASE-LEDGER.md §3).`);
  }
  if (st.drift.length) {
    throw new MigrationError("MIGRATION_DRIFT", `applied migration file(s) changed: ${st.drift.map((d) => `${d.name} (db ${d.applied.slice(0, 12)} ≠ file ${d.file.slice(0, 12)})`).join(", ")}. Applied migrations are immutable; add a new forward migration instead.`);
  }
}

/**
 * Applies pending SQL migrations in lexical order, each in its own
 * transaction, under a cluster-wide advisory lock so concurrent web/worker
 * startups never race. Refuses (before applying anything) when an applied
 * migration's file changed (drift) or the DB knows a migration the code does
 * not (downgrade). Rows recorded before W05 (no checksum) adopt the current
 * file checksum once (trust on first use) and are verified from then on.
 */
export async function migrate(db: Db, dir = DIR, opts: { lockTimeoutMs?: number } = {}): Promise<string[]> {
  const files = readMigrations(dir);
  const res = await db.withSessionLock(
    MIGRATION_LOCK,
    async () => {
      await db.tx(ensureTable);
      const rows = (await db.query<AppliedRow>("SELECT name, checksum FROM schema_migrations")).rows;
      const st = compareMigrations(files, rows);
      assertNoDriftOrDowngrade(st);
      const adopt = rows.filter((r) => r.checksum === null && files.some((f) => f.name === r.name));
      for (const r of adopt) {
        await db.query("UPDATE schema_migrations SET checksum = $2, checksum_adopted_at = now() WHERE name = $1 AND checksum IS NULL", [r.name, files.find((f) => f.name === r.name)!.checksum]);
      }
      const done: string[] = [];
      for (const f of files) {
        if (!st.pending.includes(f.name)) continue;
        await db.tx(async (q) => {
          // Migrations may legitimately exceed the per-statement timeout of request traffic.
          await q.query("SET LOCAL statement_timeout = 0");
          // Statements are split on a blank-line-free ';' boundary outside $$ blocks.
          for (const stmt of splitSql(f.sql)) await q.query(stmt);
          await q.query("INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)", [f.name, f.checksum]);
        });
        done.push(f.name);
      }
      return done;
    },
    { wait: true, timeoutMs: opts.lockTimeoutMs ?? 120_000 },
  ).catch((e: unknown) => {
    if ((e as { code?: string }).code === "57014") throw new MigrationError("MIGRATION_LOCK_TIMEOUT", "another process held the migration lock too long");
    throw e;
  });
  if (!res.acquired) throw new MigrationError("MIGRATION_LOCK_TIMEOUT", "migration lock not acquired");
  return res.value;
}

export interface DatabaseReport {
  serverVersionNum: number;
  serverVersion: string;
  timeZone: string;
  extensions: string[];
  migrations: MigrationStatus;
}

/**
 * Fail-closed startup checks: server >= 14, session TimeZone UTC, plpgsql
 * available (the only extension the schema needs: append-only/immutability
 * triggers), and the schema exactly at the code's migration version (no
 * pending, drifted or unknown migrations). Throws one error listing every
 * failed check.
 */
export async function assertDatabaseReady(db: Queryable, dir = DIR): Promise<DatabaseReport> {
  const v = (await db.query<{ num: string; ver: string; tz: string }>("SELECT current_setting('server_version_num') AS num, current_setting('server_version') AS ver, current_setting('TimeZone') AS tz")).rows[0]!;
  const extensions = (await db.query<{ extname: string }>("SELECT extname FROM pg_extension ORDER BY extname")).rows.map((r) => r.extname);
  const migrations = await migrationStatus(db, dir);
  const report: DatabaseReport = { serverVersionNum: Number(v.num), serverVersion: v.ver, timeZone: v.tz, extensions, migrations };
  const failures: string[] = [];
  if (!(report.serverVersionNum >= MIN_SERVER_VERSION_NUM)) failures.push(`PostgreSQL ${v.ver} is older than 14`);
  if (!["UTC", "Etc/UTC", "Etc/UCT", "UCT"].includes(v.tz)) failures.push(`session TimeZone is ${v.tz}, expected UTC`);
  if (!extensions.includes("plpgsql")) failures.push("required extension plpgsql is missing");
  if (migrations.unknown.length) failures.push(`unknown migrations in database: ${migrations.unknown.join(", ")}`);
  if (migrations.drift.length) failures.push(`migration drift: ${migrations.drift.map((d) => d.name).join(", ")}`);
  if (migrations.pending.length) failures.push(`schema not at expected version: pending ${migrations.pending.join(", ")}`);
  if (failures.length) throw new Error(`DB_STARTUP_CHECK_FAILED: ${failures.join("; ")}`);
  return report;
}

export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inDollar = false;
  for (const line of sql.split("\n")) {
    const trimmed = line.trim();
    if (!inDollar && (trimmed.startsWith("--") || trimmed === "")) continue;
    cur += line + "\n";
    const dollars = (line.match(/\$\$/g) ?? []).length;
    if (dollars % 2 === 1) inDollar = !inDollar;
    if (!inDollar && trimmed.endsWith(";")) {
      out.push(cur.trim());
      cur = "";
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
