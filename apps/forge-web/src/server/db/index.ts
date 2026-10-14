/**
 * Minimal database port. Production: PostgreSQL via node-postgres
 * (DATABASE_URL). Local sandbox and tests: PGlite (real Postgres compiled to
 * WASM) running the SAME SQL — there is no second, permissive store.
 */
import pg from "pg";

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class PgDb implements Db {
  private pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 10 });
  }
  async query<T>(sql: string, params: unknown[] = []) {
    const r = await this.pool.query(sql, params as unknown[]);
    return { rows: r.rows as T[] };
  }
  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const q: Queryable = {
        query: async <R>(sql: string, params: unknown[] = []) => ({ rows: (await client.query(sql, params as unknown[])).rows as R[] }),
      };
      const out = await fn(q);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
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
  async exec(sql: string) {
    await this.serialize(() => this.db.exec(sql));
  }
  async close() {
    await this.db.close();
  }
}

export async function openDb(cfg: { url?: string; pgliteDir?: string }): Promise<Db> {
  if (cfg.url) return new PgDb(cfg.url);
  return PgliteDb.open(cfg.pgliteDir);
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
