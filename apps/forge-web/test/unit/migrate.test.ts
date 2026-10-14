import { describe, expect, it } from "vitest";
import { PgliteDb } from "@/server/db";
import { migrate } from "@/server/db/migrate";

describe("migrations", () => {
  it("apply on real Postgres (PGlite) and enforce immutability triggers", async () => {
    const db = await PgliteDb.open();
    expect(await migrate(db)).toEqual(["001_init.sql"]);
    expect(await migrate(db)).toEqual([]);
    await db.query("INSERT INTO audit_events(actor, action) VALUES ('t','x')");
    await expect(db.query("DELETE FROM audit_events")).rejects.toThrow(/append-only/);
    await db.close();
  });
});
