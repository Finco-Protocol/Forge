import { describe, expect, it } from "vitest";
import { encrypt, decrypt } from "@/server/crypto";

const SECRET = "x".repeat(40);

describe("AES-256-GCM helper (Semgrep gcm-no-tag-length fix)", () => {
  it("round-trips and keeps the 16-byte tag format", () => {
    const blob = encrypt(SECRET, "t", "hello");
    const [iv, tag] = blob.split(".").map((s) => Buffer.from(s, "base64url"));
    expect(iv!.length).toBe(12);
    expect(tag!.length).toBe(16);
    expect(decrypt(SECRET, "t", blob)).toBe("hello");
  });

  it("refuses truncated authentication tags (the forgery Semgrep warns about)", () => {
    const [iv, tag, ct] = encrypt(SECRET, "t", "hello").split(".");
    for (const n of [4, 8, 12, 15]) {
      const shortTag = Buffer.from(tag!, "base64url").subarray(0, n).toString("base64url");
      expect(() => decrypt(SECRET, "t", [iv, shortTag, ct].join("."))).toThrow(/bad ciphertext/);
    }
  });

  it("refuses a tampered ciphertext, a wrong purpose and a wrong IV length", () => {
    const [iv, tag, ct] = encrypt(SECRET, "t", "hello").split(".");
    const flipped = Buffer.from(ct!, "base64url");
    flipped[0]! ^= 1;
    expect(() => decrypt(SECRET, "t", [iv, tag, flipped.toString("base64url")].join("."))).toThrow();
    expect(() => decrypt(SECRET, "other", [iv, tag, ct].join("."))).toThrow();
    expect(() => decrypt(SECRET, "t", [Buffer.alloc(8).toString("base64url"), tag, ct].join("."))).toThrow(/bad ciphertext/);
  });
});
