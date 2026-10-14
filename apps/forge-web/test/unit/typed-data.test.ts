import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256 } from "viem";
import { canonicalExemptionHash, decodeAttestationPayload, encodeAttestationPayload, effectiveMetadataHash, ZERO_ADDRESS } from "@/shared/forge-typed-data";

describe("forge typed-data helpers", () => {
  it("empty exemption list hashes to the factory's _EMPTY_EXEMPTION_HASH preimage", () => {
    expect(canonicalExemptionHash([])).toBe(keccak256(encodeAbiParameters([{ type: "address[]" }], [[]])));
  });
  it("canonical exemption hash sorts by uint160, keeps duplicates, rejects zero and >32", () => {
    const a = "0x00000000000000000000000000000000000000Aa";
    const b = "0x0000000000000000000000000000000000000100";
    expect(canonicalExemptionHash([b, a])).toBe(canonicalExemptionHash([a, b]));
    expect(canonicalExemptionHash([a, a])).not.toBe(canonicalExemptionHash([a]));
    expect(() => canonicalExemptionHash([ZERO_ADDRESS])).toThrow("INVALID_EXEMPTION_ADDRESS");
    expect(() => canonicalExemptionHash(Array.from({ length: 33 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`))).toThrow("EXEMPTION_LIST_TOO_LONG");
  });
  it("attestation payload is exactly 81 bytes and round-trips", () => {
    const sig = `0x${"ab".repeat(64)}1b` as const;
    const p = encodeAttestationPayload(100n, 200n, sig);
    expect((p.length - 2) / 2).toBe(81);
    expect(decodeAttestationPayload(p)).toEqual({ issuedAt: 100n, expiresAt: 200n, signature: sig });
    expect(() => encodeAttestationPayload(1n, 2n, "0x1234")).toThrow();
  });
  it("effective metadata hash binds fee recipient, buyback flag and creator tax", () => {
    const raw = keccak256("0x01");
    const base = effectiveMetadataHash(raw, ZERO_ADDRESS, false, 0);
    expect(effectiveMetadataHash(raw, ZERO_ADDRESS, true, 0)).not.toBe(base);
    expect(effectiveMetadataHash(raw, ZERO_ADDRESS, false, 1)).not.toBe(base);
  });
});
