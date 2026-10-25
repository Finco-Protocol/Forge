import { describe, expect, it } from "vitest";
import { PgliteDb } from "@/server/db";
import { migrate } from "@/server/db/migrate";

describe("migrations", () => {
  it("apply on real Postgres (PGlite) and enforce immutability triggers", async () => {
    const db = await PgliteDb.open();
    expect(await migrate(db)).toEqual(["001_init.sql", "002_revocation_queue.sql", "003_finance.sql", "004_signer_audit.sql", "005_ledger_materialization.sql", "006_ops.sql", "007_webhook_delivery_lifecycle.sql", "008_webhook_retry_indexes.sql"]);
    expect(await migrate(db)).toEqual([]);
    await db.query("INSERT INTO audit_events(actor, action) VALUES ('t','x')");
    await expect(db.query("DELETE FROM audit_events")).rejects.toThrow(/append-only/);
    await db.close();
  }, 60_000); // PGlite WASM start-up is slow when several DB-backed unit files run in parallel
});
