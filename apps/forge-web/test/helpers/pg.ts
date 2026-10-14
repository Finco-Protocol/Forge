/**
 * W05 real-PostgreSQL test support (opt-in).
 *
 *   FORGE_TEST_DATABASE_URL  admin URL of a PostgreSQL >= 14 server (CI: a
 *                            postgres:16 service). Each test file creates and
 *                            drops its own scratch databases on it.
 *   FORGE_TEST_REQUIRE_PG    "1"/"true": the pg suites MUST run — a missing URL
 *                            or an unreachable server FAILS (never skips).
 *
 * With neither set the suites are skipped (local default; PGlite covers the
 * same SQL in the unit/integration projects). With the URL set, an
 * unreachable server fails the suite loudly in beforeAll.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { describe, it } from "vitest";
import { createAppContext, type AppContext } from "@/server/context";
import { deploySandbox, type SandboxDeployment } from "../../scripts/sandbox-lib";
import { startAnvil, type Anvil } from "./anvil";
import { FakeGithub } from "./fake-github";
import { sandboxEnv } from "./env";

export const PG_URL = process.env.FORGE_TEST_DATABASE_URL || undefined;
export const PG_REQUIRED = ["1", "true"].includes((process.env.FORGE_TEST_REQUIRE_PG ?? "").toLowerCase()) || PG_URL !== undefined;

/** describe() that runs when PG is configured/required, fails when required but unconfigured, else skips with a note. */
export function describePg(name: string, fn: () => void) {
  if (PG_URL) return describe(name, fn);
  if (PG_REQUIRED) {
    return describe(name, () => {
      it("requires FORGE_TEST_DATABASE_URL", () => {
        throw new Error("FORGE_TEST_REQUIRE_PG is set but FORGE_TEST_DATABASE_URL is not: the PostgreSQL suite must run.");
      });
    });
  }
  console.warn(`[pg] skipping "${name}": set FORGE_TEST_DATABASE_URL to run against real PostgreSQL`);
  return describe.skip(name, fn);
}

export function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/** Creates a fresh database on the server; throws (fails the test) when the server is unreachable. */
export async function scratchDb(prefix = "forge_w05"): Promise<{ url: string; name: string; drop(): Promise<void> }> {
  if (!PG_URL) throw new Error("FORGE_TEST_DATABASE_URL not set");
  const name = `${prefix}_${randomBytes(5).toString("hex")}`;
  const admin = new pg.Client({ connectionString: PG_URL, connectionTimeoutMillis: 5_000 });
  await admin.connect().catch((e: Error) => {
    throw new Error(`FORGE_TEST_DATABASE_URL is set but PostgreSQL is unreachable: ${e.message}`);
  });
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  return {
    url: withDatabase(PG_URL, name),
    name,
    drop: async () => {
      const a = new pg.Client({ connectionString: PG_URL });
      await a.connect();
      try {
        await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await a.end();
      }
    },
  };
}

export async function adminQuery<T = Record<string, unknown>>(url: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.end();
  }
}

export interface PgSandbox {
  anvil: Anvil;
  deployment: SandboxDeployment;
  github: FakeGithub;
  env: Record<string, string>;
  db: { url: string; name: string; drop(): Promise<void> };
  /** A new process-like context: own pool, own application_name. */
  context(role?: "web" | "worker" | "cli", extra?: Record<string, string>): Promise<AppContext>;
  stop(): Promise<void>;
}

/** The integration sandbox (anvil + real contracts + fake GitHub) on a real PostgreSQL scratch database. */
export async function startPgSandbox(extraEnv: Record<string, string> = {}): Promise<PgSandbox> {
  const db = await scratchDb();
  const anvil = await startAnvil();
  const deployment = await deploySandbox(anvil.url);
  const dir = mkdtempSync(path.join(tmpdir(), "forge-w05-pg-"));
  const deploymentFile = path.join(dir, "deployment.json");
  writeFileSync(deploymentFile, JSON.stringify(deployment));
  const github = new FakeGithub();
  await github.start();
  const env = sandboxEnv(deployment, github, anvil.url, deploymentFile, { DATABASE_URL: db.url, FORGE_DB_POOL_MAX: "5", ...extraEnv });
  const contexts: AppContext[] = [];
  return {
    anvil,
    deployment,
    github,
    env,
    db,
    context: async (role = "web", extra = {}) => {
      const ctx = await createAppContext({ ...env, FORGE_PROCESS_ROLE: role, ...extra });
      contexts.push(ctx);
      return ctx;
    },
    stop: async () => {
      for (const c of contexts) await c.db.close().catch(() => undefined);
      await github.stop();
      await anvil.stop();
      await db.drop();
    },
  };
}
