/**
 * W06 staging operations library: versioned build/deployment manifest,
 * database digest, backup / restore and rollback planning. Pure Node + the
 * existing server modules; no cloud SDK, no network writes.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { PgDb } from "../../src/server/db";
import { migrationStatus, readMigrations } from "../../src/server/db/migrate";
import { buildConfig } from "../../src/server/config";
import { ledgerDigest } from "../../src/server/finance/ledger-fold";
import { ledgerContextFor, loadMaterializedLedger, loadReferenceLedger } from "../../src/server/finance/materialized";
import { checkpointName } from "../../src/server/indexer/indexer";
import { createDatabaseSql, dropDatabaseSql, quoteIdent } from "../w05/sql-ident";

export const APP_ROOT = path.resolve(import.meta.dirname, "..", "..");
export const REPO_ROOT = path.resolve(APP_ROOT, "..", "..");
export const MANIFEST_VERSION = 1;

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const fileSha = (p: string) => (existsSync(p) ? sha256(readFileSync(p)) : null);

export interface StagingManifest {
  manifestVersion: number;
  kind: "forge-staging-build";
  app: { name: string; version: string };
  git: { sha: string | null; dirty: boolean | null };
  runtime: { node: string };
  migrations: Array<{ name: string; checksum: string }>;
  inputs: { lockfileSha256: string | null; authorityMatrixSha256: string | null; readinessManifestSha256: string | null; securityBaselineSha256: string | null; composeSha256: string | null };
  flags: { PRODUCTION_BLOCKED: true; FINCO_BURN_ENABLED: false; FORGE_FEE_POLICY_AUTHORITY_UNPROVEN: true; PRODUCTION_SIGNING_ENABLED: false; REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED: false; DEPLOY_WRITE_ENABLED: false };
  /** sha256 over everything above (stable JSON). Tamper-evident, not a signature. */
  digest: string;
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
}

export function buildManifest(opts: { gitSha?: string | null; migrationsDir?: string } = {}): StagingManifest {
  const pkg = JSON.parse(readFileSync(path.join(APP_ROOT, "package.json"), "utf8")) as { name: string; version: string };
  const sha = opts.gitSha !== undefined ? opts.gitSha : (process.env.GITHUB_SHA ?? git(["rev-parse", "HEAD"]));
  const dirtyOut = git(["status", "--porcelain", "--", "."]);
  const body = {
    manifestVersion: MANIFEST_VERSION,
    kind: "forge-staging-build" as const,
    app: { name: pkg.name, version: pkg.version },
    git: { sha: sha ?? null, dirty: dirtyOut === null ? null : dirtyOut.length > 0 },
    runtime: { node: process.version },
    migrations: readMigrations(opts.migrationsDir).map((m) => ({ name: m.name, checksum: m.checksum })),
    inputs: {
      lockfileSha256: fileSha(path.join(APP_ROOT, "pnpm-lock.yaml")),
      authorityMatrixSha256: fileSha(path.join(APP_ROOT, "config", "authority-matrix.json")),
      readinessManifestSha256: fileSha(path.join(REPO_ROOT, "release", "readiness-manifest.json")),
      securityBaselineSha256: fileSha(path.join(REPO_ROOT, "security", "baseline.json")),
      composeSha256: fileSha(path.join(REPO_ROOT, "ops", "staging", "docker-compose.staging.yml")),
    },
    flags: { PRODUCTION_BLOCKED: true as const, FINCO_BURN_ENABLED: false as const, FORGE_FEE_POLICY_AUTHORITY_UNPROVEN: true as const, PRODUCTION_SIGNING_ENABLED: false as const, REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED: false as const, DEPLOY_WRITE_ENABLED: false as const },
  };
  return { ...body, digest: sha256(stable(body)) };
}

/** Problems (empty = consistent). Re-derives the digest and compares the migrations/inputs with the working tree. */
export function verifyManifest(m: StagingManifest, opts: { migrationsDir?: string; checkInputs?: boolean } = {}): string[] {
  const problems: string[] = [];
  const { digest, ...body } = m;
  if (sha256(stable(body)) !== digest) problems.push("MANIFEST_DIGEST_MISMATCH: the manifest was edited after it was generated");
  if (m.manifestVersion !== MANIFEST_VERSION || m.kind !== "forge-staging-build") problems.push("MANIFEST_VERSION_UNSUPPORTED");
  const f = m.flags;
  if (!(f?.PRODUCTION_BLOCKED === true && f.FINCO_BURN_ENABLED === false && f.FORGE_FEE_POLICY_AUTHORITY_UNPROVEN === true && f.PRODUCTION_SIGNING_ENABLED === false && f.REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED === false && f.DEPLOY_WRITE_ENABLED === false)) {
    problems.push("MANIFEST_FLAG_DRIFT: a safety flag in the manifest is not at its frozen value");
  }
  if (opts.checkInputs !== false) {
    const now = readMigrations(opts.migrationsDir).map((x) => `${x.name}:${x.checksum}`);
    const was = m.migrations.map((x) => `${x.name}:${x.checksum}`);
    if (now.join("|") !== was.join("|")) problems.push("MANIFEST_MIGRATIONS_DRIFT: the migration files differ from the manifest");
    const lock = fileSha(path.join(APP_ROOT, "pnpm-lock.yaml"));
    if (lock !== m.inputs.lockfileSha256) problems.push("MANIFEST_LOCKFILE_DRIFT");
  }
  return problems;
}

export interface RollbackPlan {
  safe: boolean;
  /** code-only: the older build understands every applied migration; restore-required: the database is newer than the target build. */
  action: "code-only" | "restore-snapshot-required";
  unknownToTarget: string[];
  pendingForTarget: string[];
}

/** Which rollback is possible from the live schema to a previous build (there are NO down migrations; see W05-DATABASE-LEDGER §3). */
export async function rollbackPlan(db: PgDb, target: StagingManifest): Promise<RollbackPlan> {
  const st = await migrationStatus(db);
  const known = new Set(target.migrations.map((m) => m.name));
  const unknownToTarget = st.applied.filter((n) => !known.has(n));
  const pendingForTarget = target.migrations.map((m) => m.name).filter((n) => !st.applied.includes(n));
  return { safe: unknownToTarget.length === 0, action: unknownToTarget.length === 0 ? "code-only" : "restore-snapshot-required", unknownToTarget, pendingForTarget };
}

export interface DbDigest {
  ledgerDigest: string;
  materializedDigest: string;
  counts: Record<string, number>;
  migrations: Array<{ name: string; checksum: string | null }>;
}

/** Row counts, migration checksums and the deterministic ledger digests (reference recompute AND materialized). */
export async function digestDatabase(url: string, env: Record<string, string | undefined>): Promise<DbDigest> {
  const cfg = buildConfig(env);
  const db = new PgDb(url, { max: 4, applicationName: "forge-cli" });
  try {
    const c = ledgerContextFor(cfg.addresses);
    const tables = (await db.query<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).rows.map((r) => r.t);
    const counts: Record<string, number> = {};
    for (const t of tables) counts[t] = Number((await db.query<{ n: string }>(["SELECT count(*)::text AS n FROM", quoteIdent(t)].join(" "))).rows[0]!.n);
    const name = checkpointName({ cfg } as Parameters<typeof checkpointName>[0]);
    const ref = ledgerDigest((await loadReferenceLedger(db, cfg.chainId, c, name)).ledger);
    const mat = ledgerDigest((await loadMaterializedLedger(db, cfg.chainId, c, name)).ledger);
    const migrations = (await db.query<{ name: string; checksum: string | null }>("SELECT name, checksum FROM schema_migrations ORDER BY name")).rows;
    return { ledgerDigest: ref, materializedDigest: mat, counts, migrations };
  } finally {
    await db.close();
  }
}

export function withDb(adminUrl: string, db: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${db}`;
  return u.toString();
}

export function pgBin(): string {
  return process.env.PG_BIN ?? "/usr/lib/postgresql/16/bin";
}

/** Splits the password out of a connection URL: it travels in PGPASSWORD, never on a command line (visible in `ps`). */
function pgConn(url: string): { conn: string; env: NodeJS.ProcessEnv } {
  const u = new URL(url);
  const pw = decodeURIComponent(u.password);
  u.password = "";
  return { conn: u.toString(), env: { ...process.env, ...(pw ? { PGPASSWORD: pw } : {}) } };
}

export function backupDatabase(url: string, file: string): void {
  const { conn, env } = pgConn(url);
  execFileSync(path.join(pgBin(), "pg_dump"), ["--format=custom", "--no-owner", `--file=${file}`, conn], { env });
}

/** Restores into a NEW database (never over an existing one). */
export async function restoreDatabase(adminUrl: string, file: string, target: string): Promise<string> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(createDatabaseSql(target));
  } finally {
    await admin.end();
  }
  const { conn, env } = pgConn(withDb(adminUrl, target));
  execFileSync(path.join(pgBin(), "pg_restore"), ["--no-owner", "--exit-on-error", `--dbname=${conn}`, file], { env });
  return withDb(adminUrl, target);
}

export async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(dropDatabaseSql(name, true));
  } finally {
    await admin.end();
  }
}
