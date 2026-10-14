import type { Queryable } from "./db";
import { ForgeError } from "./errors";

/** Fixed-window limiter persisted in Postgres (survives restarts, shared across instances). */
export async function rateLimit(db: Queryable, key: string, limit: number, windowSeconds: number, now = Date.now()) {
  const windowStart = Math.floor(now / 1000 / windowSeconds) * windowSeconds;
  const { rows } = await db.query<{ count: number }>(
    `INSERT INTO rate_limits(key, window_start, count) VALUES ($1,$2,1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [key, windowStart],
  );
  if ((rows[0]?.count ?? 0) > limit) {
    throw new ForgeError("RATE_LIMITED", "Too many requests; try again later.", 429, { retryAfterSeconds: windowStart + windowSeconds - Math.floor(now / 1000) });
  }
}
