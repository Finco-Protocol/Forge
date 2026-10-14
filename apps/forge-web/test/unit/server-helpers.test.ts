import { describe, expect, it } from "vitest";
import { canonicalJson, decrypt, encrypt, safeEqual } from "@/server/crypto";
import { splitSql } from "@/server/db/migrate";
import { projectionPhaseMatchesOnchain } from "@/server/indexer/projection";
import { signWebhookBody } from "@/server/github/webhooks";
import { createHmac } from "node:crypto";

describe("server helpers", () => {
  it("AES-GCM token encryption is authenticated and purpose-bound", () => {
    const blob = encrypt("s".repeat(32), "github-user-token", "ghu_secret");
    expect(decrypt("s".repeat(32), "github-user-token", blob)).toBe("ghu_secret");
    expect(() => decrypt("s".repeat(32), "other-purpose", blob)).toThrow();
    expect(() => decrypt("t".repeat(32), "github-user-token", blob)).toThrow();
  });
  it("canonical JSON is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: { d: 2n, c: [3] } })).toBe(canonicalJson({ a: { c: [3], d: 2n }, b: 1 }));
  });
  it("webhook signature matches GitHub's HMAC-SHA256 format", () => {
    expect(signWebhookBody("k", "{}")).toBe(`sha256=${createHmac("sha256", "k").update("{}").digest("hex")}`);
    expect(safeEqual("a", "ab")).toBe(false);
  });
  it("splits SQL outside dollar-quoted bodies only", () => {
    const parts = splitSql("CREATE TABLE a(x int);\nCREATE FUNCTION f() RETURNS trigger AS $$\nBEGIN\n  RAISE EXCEPTION 'x';\nEND $$ LANGUAGE plpgsql;\n");
    expect(parts).toHaveLength(2);
  });
  it("projection phases map onto GraduationPhase", () => {
    expect(projectionPhaseMatchesOnchain("bonding_curve_active", 0)).toBe(true);
    expect(projectionPhaseMatchesOnchain("graduated", 1)).toBe(false);
    expect(projectionPhaseMatchesOnchain("graduated", 2)).toBe(true);
    expect(projectionPhaseMatchesOnchain("blocked", 3)).toBe(true);
  });
});
