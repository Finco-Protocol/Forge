/**
 * W05 hook-mine CLI against the EXACT compiled PonsV2MemeHook (out/forge):
 * deterministic evidence, agreement with the sandbox deployment, and a
 * fail-closed exit code on a wrong salt.
 */
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { numberToHex } from "viem";
import { create2Address, hookMaskOk, type HookEvidence } from "../../scripts/w05/hook-mine-lib";

const run = promisify(execFile);
const APP = path.resolve(import.meta.dirname, "../..");
const ARGS = ["--pool-manager", "0x8366a39cc670b4001a1121b8f6a443a643e40951", "--escrow", "0x1111111111111111111111111111111111111111", "--recipient", "0x2222222222222222222222222222222222222222", "--owner", "0x3333333333333333333333333333333333333333"];
const mine = (extra: string[] = []) => run("npx", ["tsx", "scripts/w05/hook-mine.ts", ...ARGS, ...extra], { cwd: APP });

describe("W05 hook-mine CLI (real artifact)", () => {
  it("emits deterministic evidence from the compiled artifact with consistent build settings", async () => {
    const a = JSON.parse((await mine()).stdout) as HookEvidence & { failures: string[] };
    const b = JSON.parse((await mine()).stdout) as HookEvidence;
    expect(a.failures).toEqual([]);
    expect(b.salt).toBe(a.salt);
    expect(a.maskOk).toBe(true);
    expect(a.chainIdTarget).toBe(4663);
    expect(a.deployer.toLowerCase()).toBe("0x4e59b44847b379578588920ca78fbf26c0b4956c");
    expect(a.artifact).toBe("out/forge/PonsV2MemeHook.sol/PonsV2MemeHook.json");
    expect(a.build.consistent).toBe(true);
    expect(a.build.artifactMetadata).toMatchObject({ solcVersion: "0.8.35+commit.47b9dedd", optimizer: true, optimizerRuns: 200, viaIR: true, evmVersion: "cancun" });
    expect(create2Address(a.deployer, a.salt, a.initCodeHash)).toBe(a.computedAddress);
    console.log(`W05_HOOK_MINE_EXAMPLE ${JSON.stringify({ salt: a.salt, address: a.computedAddress, initCodeHash: a.initCodeHash, iterations: a.iterations })}`);
  });

  it("verifying a chosen salt that misses the mask exits non-zero (fail closed)", async () => {
    const a = JSON.parse((await mine()).stdout) as HookEvidence;
    let s = 0n;
    while (hookMaskOk(create2Address(a.deployer, numberToHex(s, { size: 32 }), a.initCodeHash))) s++;
    const e = await mine(["--salt", numberToHex(s, { size: 32 })]).then(() => null, (x: { code: number; stderr: string }) => x);
    expect(e?.code).toBe(1);
    expect(e?.stderr).toContain("HOOK_MASK_MISMATCH");
    const ok = JSON.parse((await mine(["--salt", a.salt])).stdout) as HookEvidence;
    expect(ok.computedAddress).toBe(a.computedAddress);
  });

  it("missing constructor args exit 2", async () => {
    const e = await run("npx", ["tsx", "scripts/w05/hook-mine.ts", "--pool-manager", "0x8366a39cc670b4001a1121b8f6a443a643e40951"], { cwd: APP }).then(() => null, (x: { code: number }) => x);
    expect(e?.code).toBe(2);
  });
});
