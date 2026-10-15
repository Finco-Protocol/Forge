import { describe, expect, it } from "vitest";
import { createDatabaseSql, dropDatabaseSql, quoteIdent } from "../../scripts/w05/sql-ident";

describe("DDL identifier helper", () => {
  it("quotes valid generated names", () => {
    expect(createDatabaseSql("forge_bench_1_123")).toBe('CREATE DATABASE "forge_bench_1_123"');
    expect(dropDatabaseSql("forge_x", true)).toBe('DROP DATABASE IF EXISTS "forge_x" WITH (FORCE)');
  });
  it.each(["x; DROP DATABASE postgres", 'a"b', "Upper", "1abc", "", "a b", "x".repeat(64), "a--b"])("rejects %j", (bad) => {
    expect(() => quoteIdent(bad)).toThrow(/unsafe SQL identifier/);
  });
});
