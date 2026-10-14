import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Db } from "./index";

const DIR = path.resolve(process.cwd(), "src", "server", "db", "migrations");

/** Applies pending SQL migrations in lexical order, each in its own transaction. */
export async function migrate(db: Db, dir = DIR): Promise<string[]> {
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const applied = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const done: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(path.join(dir, f), "utf8");
    await db.tx(async (q) => {
      // Statements are split on a blank-line-free ';' boundary outside $$ blocks.
      for (const stmt of splitSql(sql)) await q.query(stmt);
      await q.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
    });
    done.push(f);
  }
  return done;
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
