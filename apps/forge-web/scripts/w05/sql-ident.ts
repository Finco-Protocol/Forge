/**
 * DDL cannot take bind parameters (CREATE/DROP DATABASE <identifier>). Identifiers used by the harness scripts are
 * generated locally (pid / random suffix), never user input; this helper still validates them strictly and quotes them,
 * so the SQL text is assembled WITHOUT string interpolation inside `.query(...)` and a bad identifier throws.
 */
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export function quoteIdent(name: string): string {
  if (!IDENT.test(name)) throw new Error(`unsafe SQL identifier: ${JSON.stringify(name)}`);
  return `"${name}"`;
}

export const createDatabaseSql = (name: string): string => ["CREATE DATABASE", quoteIdent(name)].join(" ");
export const dropDatabaseSql = (name: string, ifExists = false): string =>
  ["DROP DATABASE", ...(ifExists ? ["IF EXISTS"] : []), quoteIdent(name), "WITH (FORCE)"].join(" ");
