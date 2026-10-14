/**
 * W05 hook CREATE2 mining — pure unit tests (no artifacts, no chain).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getContractAddress, keccak256, numberToHex, type Address, type Hex } from "viem";
import {
  ALL_HOOK_MASK,
  CREATE2_PROXY,
  HOOK_FLAGS,
  buildHookEvidence,
  create2Address,
  hookInitCode,
  hookMaskOk,
  mineHookSalt,
  verifyHookEvidence,
  type BuildSettings,
} from "../../scripts/w05/hook-mine-lib";
import { parseFoundryProfile, tomlBuildSettings } from "../../scripts/w05/build-info";

const CREATION: Hex = "0x6080604052348015600f57600080fd5b50603f80601d6000396000f3fe"; // synthetic creation code
const ARGS = {
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951" as Address,
  feeEscrow: "0x1111111111111111111111111111111111111111" as Address,
  protocolFeeRecipient: "0x2222222222222222222222222222222222222222" as Address,
  // Chosen so the deterministic search ends early (keeps the unit project light; mining cost is not under test).
  owner: "0x0000000000000000000000000000000000000005" as Address,
};
const SETTINGS: BuildSettings = { solcVersion: "0.8.35", optimizer: true, optimizerRuns: 200, viaIR: true, evmVersion: "cancun", bytecodeHash: "ipfs" };
const META: BuildSettings = { ...SETTINGS, solcVersion: "0.8.35+commit.47b9dedd" };
const initHash = keccak256(hookInitCode(CREATION, ARGS));

describe("W05 hook salt mining", () => {
  it("is deterministic and returns the FIRST salt from 0 whose address has exactly mask 0x2044", () => {
    const a = mineHookSalt(CREATE2_PROXY, initHash);
    const b = mineHookSalt(CREATE2_PROXY, initHash);
    expect(a).toEqual(b);
    expect(hookMaskOk(a.address)).toBe(true);
    expect(BigInt(a.address) & ALL_HOOK_MASK).toBe(HOOK_FLAGS);
    expect(a.address).toBe(getContractAddress({ opcode: "CREATE2", from: CREATE2_PROXY, salt: a.salt, bytecodeHash: initHash }));
    // No smaller salt matches: the same search bounded to [0, saltIndex) is exhausted.
    if (a.saltIndex > 0n) expect(() => mineHookSalt(CREATE2_PROXY, initHash, { maxIterations: a.saltIndex })).toThrow(/HOOK_MINE_EXHAUSTED/);
    expect(hookMaskOk(create2Address(CREATE2_PROXY, numberToHex(a.saltIndex, { size: 32 }), initHash))).toBe(true);
    expect(a.iterations).toBe(a.saltIndex + 1n);
  });

  it("depends on deployer and init code (different inputs, different evidence)", () => {
    const a = mineHookSalt(CREATE2_PROXY, initHash);
    const other = keccak256(hookInitCode(CREATION, { ...ARGS, owner: "0x0000000000000000000000000000000000000006" }));
    expect(mineHookSalt(CREATE2_PROXY, other).address).not.toBe(a.address);
    expect(mineHookSalt("0x0000000000000000000000000000000000005002", initHash).address).not.toBe(a.address);
  });

  it("fails closed: exhausted bound throws, flags beyond 14 bits throw, never a non-matching salt", () => {
    expect(() => mineHookSalt(CREATE2_PROXY, initHash, { maxIterations: 1n, start: 0n, flags: 0x3fffn })).toThrow(/HOOK_MINE_EXHAUSTED/);
    expect(() => mineHookSalt(CREATE2_PROXY, initHash, { flags: 0x4000n })).toThrow(/exceed/);
  });

  it("evidence records build settings, init-code hash, salt, address, mask and target chain", () => {
    const e = buildHookEvidence({ chainIdTarget: 4663, artifact: "x", creationCode: CREATION, args: ARGS, foundryProfile: "forge", toml: SETTINGS, artifactMetadata: META });
    expect(e).toMatchObject({ chainIdTarget: 4663, initCodeHash: initHash, deployer: "0x4e59b44847b379578588920cA78FbF26c0B4956C", maskOk: true, requiredFlags: "0x2044", permissionBits: "0x2044" });
    expect(e.build.consistent).toBe(true);
    expect(verifyHookEvidence(e, CREATION)).toEqual([]);
  });

  it("refuses a pre-chosen salt with the wrong mask, a tampered address, changed code and inconsistent build settings", () => {
    const good = buildHookEvidence({ chainIdTarget: 4663, artifact: "x", creationCode: CREATION, args: ARGS, foundryProfile: "forge", toml: SETTINGS, artifactMetadata: META });
    let bad = 0n;
    while (hookMaskOk(create2Address(CREATE2_PROXY, numberToHex(bad, { size: 32 }), initHash))) bad++;
    const wrong = buildHookEvidence({ chainIdTarget: 4663, artifact: "x", creationCode: CREATION, args: ARGS, foundryProfile: "forge", toml: SETTINGS, artifactMetadata: META, salt: numberToHex(bad, { size: 32 }) });
    expect(wrong.maskOk).toBe(false);
    expect(verifyHookEvidence(wrong).join()).toMatch(/HOOK_MASK_MISMATCH/);
    expect(verifyHookEvidence({ ...good, computedAddress: ARGS.feeEscrow }).join()).toMatch(/computed address/);
    expect(verifyHookEvidence(good, "0x6001").join()).toMatch(/creation code differs/);
    const inconsistent = buildHookEvidence({ chainIdTarget: 4663, artifact: "x", creationCode: CREATION, args: ARGS, foundryProfile: "forge", toml: SETTINGS, artifactMetadata: { ...META, optimizerRuns: 300 } });
    expect(verifyHookEvidence(inconsistent).join()).toMatch(/build settings/);
  });
});

describe("W05 foundry.toml profile reader", () => {
  it("reads scalars of one profile only", () => {
    const t = '[profile.default]\nsolc = "0.8.30"\n[profile.forge]\nsolc = "0.8.35" # c\noptimizer = true\noptimizer_runs = 200\nvia_ir = true\nevm_version = "cancun"\nremappings = [\n "a=b",\n]\n';
    expect(parseFoundryProfile(t, "forge")).toEqual({ solc: "0.8.35", optimizer: true, optimizer_runs: 200, via_ir: true, evm_version: "cancun" });
    expect(() => parseFoundryProfile(t, "nope")).toThrow();
  });

  it("the repository's [profile.forge] is solc 0.8.35 / optimizer 200 / via_ir / cancun / ipfs", () => {
    const toml = readFileSync(path.resolve(import.meta.dirname, "../../../../foundry.toml"), "utf8");
    expect(tomlBuildSettings("forge", toml)).toEqual({ solcVersion: "0.8.35", optimizer: true, optimizerRuns: 200, viaIR: true, evmVersion: "cancun", bytecodeHash: "ipfs" });
  });
});
