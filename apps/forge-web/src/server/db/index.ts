/**
 * Minimal database port. Production: PostgreSQL via node-postgres
 * (DATABASE_URL). Local sandbox and tests: PGlite (real Postgres compiled to
 * WASM) running the SAME SQL — there is no second, permissive store.
 *
 * W05 production mode (PgDb):
 *  - bounded pool (max / idle / connect timeouts) and per-session guards
 *    (statement_timeout, idle_in_transaction_session_timeout, TimeZone=UTC),
 *    all configurable with safe defaults (see DbPoolConfig);
 *  - application_name per process role (forge-web, forge-worker, …) so
 *    pg_stat_activity attributes every connection;
 *  - session-level advisory locks on a DEDICATED connection (migrations,
 *    indexer leadership, attestation) — see withSessionLock.
 */
import { createHash } from "node:crypto";
import pg from "pg";

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface PoolStats {
  driver: "pg" | "pglite";
  applicationName: string | null;
  max: number | null;
  total: number | null;
  idle: number | null;
  waiting: number | null;
}

export type LockResult<T> = { acquired: true; value: T } | { acquired: false };

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /**
   * Runs `fn` while holding the session-level advisory lock `name` on a
   * dedicated connection (passed to `fn`). wait=false: returns
   * {acquired:false} immediately when another session holds it.
   */
  withSessionLock<T>(name: string, fn: (q: Queryable) => Promise<T>, opts: { wait: boolean; timeoutMs?: number }): Promise<LockResult<T>>;
  stats(): PoolStats;
  close(): Promise<void>;
}

export interface DbPoolConfig {
  /** Max pooled connections per process (default 10). */
  max: number;
  /** Idle connection reap time (default 30s). */
  idleTimeoutMs: number;
  /** Max wait for a new connection (default 5s); 0 = wait forever (not recommended). */
  connectionTimeoutMs: number;
  /** Per-statement server-side timeout (default 30s). Migrations lift it locally. */
  statementTimeoutMs: number;
  /** Server kills sessions idle inside an open transaction (default 60s). */
  idleInTransactionTimeoutMs: number;
  /** pg_stat_activity application_name (forge-web / forge-worker / forge-cli). */
  applicationName: string;
}

export const DEFAULT_POOL: DbPoolConfig = {
  max: 10,
  idleTimeoutMs: 30_000,
  connectionTimeoutMs: 5_000,
  statementTimeoutMs: 30_000,
  idleInTransactionTimeoutMs: 60_000,
  applicationName: "forge-web",
};

/** Stable 64-bit advisory lock key for a name (first 8 bytes of sha256, signed). */
export function advisoryKey(name: string): string {
  return BigInt.asIntN(64, BigInt(`0x${createHash("sha256").update(`forge-lock:${name}`).digest("hex").slice(0, 16)}`)).toString();
}

const clientQueryable = (client: pg.PoolClient | pg.Client): Queryable => ({
  query: async <R>(sql: string, params: unknown[] = []) => ({ rows: (await client.query(sql, params as unknown[])).rows as R[] }),
});

export class PgDb implements Db {
  private pool: pg.Pool;
  readonly poolCfg: DbPoolConfig;
  constructor(url: string, cfg: Partial<DbPoolConfig> = {}) {
    this.poolCfg = { ...DEFAULT_POOL, ...cfg };
    const c = this.poolCfg;
    this.pool = new pg.Pool({
      connectionString: url,
      max: c.max,
      idleTimeoutMillis: c.idleTimeoutMs,
      connectionTimeoutMillis: c.connectionTimeoutMs,
      statement_timeout: c.statementTimeoutMs,
      idle_in_transaction_session_timeout: c.idleInTransactionTimeoutMs,
      application_name: c.applicationName,
      // Session TimeZone pinned to UTC; verified at startup (assertDatabaseReady).
      options: "-c TimeZone=UTC",
    });
    // An idle client erroring (server restart, network) must not crash the process.
    this.pool.on("error", (err) => console.error("[forge-db] idle client error:", err.message));
  }
  async query<T>(sql: string, params: unknown[] = []) {
    const r = await this.pool.query(sql, params as unknown[]);
    return { rows: r.rows as T[] };
  }
  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(clientQueryable(client));
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  async withSessionLock<T>(name: string, fn: (q: Queryable) => Promise<T>, opts: { wait: boolean; timeoutMs?: number }): Promise<LockResult<T>> {
    const client = await this.pool.connect();
    const k = advisoryKey(name);
    let held = false;
    let broken = false;
    try {
      if (opts.wait) {
        await client.query(`SET statement_timeout = ${Math.max(0, Math.floor(opts.timeoutMs ?? 120_000))}`);
        await client.query("SELECT pg_advisory_lock($1::bigint)", [k]);
        await client.query(`SET statement_timeout = ${this.poolCfg.statementTimeoutMs}`);
        held = true;
      } else {
        held = (await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS ok", [k])).rows[0]!.ok;
        if (!held) return { acquired: false };
      }
      return { acquired: true, value: await fn(clientQueryable(client)) };
    } catch (err) {
      broken = true;
      throw err;
    } finally {
      if (held) {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [k]).catch(() => {
          broken = true;
        });
      }
      // A connection in an unknown lock/tx state is destroyed, never reused.
      client.release(broken ? true : undefined);
    }
  }
  stats(): PoolStats {
    return {
      driver: "pg",
      applicationName: this.poolCfg.applicationName,
      max: this.poolCfg.max,
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }
  async close() {
    await this.pool.end();
  }
}

export class PgliteDb implements Db {
  // Lazily imported so production bundles never load the WASM build.
  private constructor(private readonly db: import("@electric-sql/pglite").PGlite) {}
  /** PGlite is single-connection: transactions are serialized through a queue. */
  private chain: Promise<unknown> = Promise.resolve();

  static async open(dataDir?: string): Promise<PgliteDb> {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = dataDir ? new PGlite(dataDir) : new PGlite();
    await db.waitReady;
    await db.exec("SET TimeZone = 'UTC'");
    return new PgliteDb(db);
  }
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
  query<T>(sql: string, params: unknown[] = []) {
    return this.serialize(async () => ({ rows: (await this.db.query<T>(sql, params as unknown[])).rows }));
  }
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.serialize(() =>
      this.db.transaction(async (t) =>
        fn({ query: async <R>(sql: string, params: unknown[] = []) => ({ rows: (await t.query<R>(sql, params as unknown[])).rows }) }),
      ),
    );
  }
  /** Single process, single connection: there is no other session to exclude. */
  async withSessionLock<T>(_name: string, fn: (q: Queryable) => Promise<T>): Promise<LockResult<T>> {
    return { acquired: true, value: await fn(this) };
  }
  stats(): PoolStats {
    return { driver: "pglite", applicationName: null, max: 1, total: 1, idle: null, waiting: null };
  }
  async exec(sql: string) {
    await this.serialize(() => this.db.exec(sql));
  }
  async close() {
    await this.db.close();
  }
}

export async function openDb(cfg: { url?: string; pgliteDir?: string; pool?: Partial<DbPoolConfig> }): Promise<Db> {
  if (cfg.url) return new PgDb(cfg.url, cfg.pool);
  return PgliteDb.open(cfg.pgliteDir);
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
