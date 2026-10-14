/**
 * W05 deployment tooling against the REAL build (out/forge) and GENUINE V4:
 * the manifest is executed step by step on a fresh Anvil (DRY_RUN), every
 * CREATE lands at its predicted address, and the runtime/role/treasury checks
 * and smoke tests pass. The 4663 manifest is built offline and is
 * NOT_EXECUTABLE; WRITE is refused through the CLI with exit code 3.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildDeployManifest, confirmationTokenFor, manifestHash, verifyManifest, writeRefusals, type DeployManifest } from "../../scripts/w05/deploy-plan-lib";
import { dryRun, executeDryRun, forgeBuildProvider, planInputFor, PLACEHOLDER_ROLES } from "../../scripts/w05/deploy-plan";
import type { GenuineChain } from "../../scripts/w05/genuine-v4";

const run = promisify(execFile);
const APP = path.resolve(import.meta.dirname, "../..");
let chain: GenuineChain;
let manifest: DeployManifest;
let report: Awaited<ReturnType<typeof dryRun>>["report"];

beforeAll(async () => {
  ({ chain, manifest, report } = await dryRun("local-genuine"));
});
afterAll(async () => chain?.stop());

describe("W05 deploy-plan DRY_RUN (local-genuine)", () => {
  it("executes every manifest step; every contract lands at its predicted address; all checks pass", () => {
    expect(report.executedSteps).toBe(manifest.steps.length);
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed, JSON.stringify(failed)).toEqual([]);
    for (const id of ["S02", "S03", "S08", "S09", "S10", "S06:deployer-has-no-role"]) expect(report.checks.find((c) => c.id === id)?.ok, id).toBe(true);
    expect(report.checks.filter((c) => c.id.startsWith("S01:")).length).toBe(10);
    expect(report.checks.find((c) => c.id === "S09")!.detail).toContain("0xfce698f7");
    console.log(`W05_DRY_RUN local-genuine manifest=${manifest.contentHash} steps=${report.executedSteps} checks=${report.checks.length} hook=${manifest.hook.computedAddress} salt=${manifest.hook.salt}`);
  });

  it("the manifest verifies against the current artifacts and refuses WRITE", () => {
    expect(verifyManifest(manifest, forgeBuildProvider())).toEqual([]);
    expect(writeRefusals({ manifest, rpcChainId: 31337, confirmation: confirmationTokenFor(manifest) })[0]).toMatch(/^WRITE_DISABLED/);
  });

  it("a tampered manifest is refused before any transaction", async () => {
    const t = JSON.parse(JSON.stringify(manifest)) as DeployManifest;
    t.roles.treasury = t.roles.revenueAttestor;
    t.contentHash = manifestHash(t);
    await expect(executeDryRun(t, chain.anvil.url)).rejects.toThrow(/invalid manifest/);
  });
});

describe("W05 deploy-plan CLI", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "w05-plan-"));
  const file = path.join(dir, "m4663.json");

  it("plan --env robinhood-4663 builds an offline, NOT_EXECUTABLE manifest from the real build", async () => {
    const { stdout } = await run("npx", ["tsx", "scripts/w05/deploy-plan.ts", "plan", "--env", "robinhood-4663", "--out", file], { cwd: APP });
    const m = JSON.parse(stdout) as DeployManifest;
    expect(m.status).toBe("NOT_EXECUTABLE");
    expect(m.chainId).toBe(4663);
    expect(m.network.poolManager.toLowerCase()).toBe("0x8366a39cc670b4001a1121b8f6a443a643e40951");
    expect(m.placeholderRoles.length).toBe(6);
    expect(m.roles.governance).toBe(PLACEHOLDER_ROLES.governance);
    expect(m.build.consistent).toBe(true);
    expect(m.build.contracts.every((c) => c.settings.solcVersion.startsWith("0.8.35") && c.settings.optimizerRuns === 200 && c.settings.viaIR && c.settings.evmVersion === "cancun")).toBe(true);
    expect(m).toEqual(buildDeployManifest({ ...planInputFor("robinhood-4663"), sourceCommit: m.sourceCommit }, forgeBuildProvider()));
  });

  it("verify exits 0 on the untouched manifest and 1 on a tampered one", async () => {
    await run("npx", ["tsx", "scripts/w05/deploy-plan.ts", "verify", "--manifest", file], { cwd: APP });
    const t = JSON.parse(JSON.stringify(await import(file, { with: { type: "json" } }).then((x) => x.default))) as DeployManifest;
    t.launchConfig.curveFeeBps = "101";
    const tf = path.join(dir, "tampered.json");
    writeFileSync(tf, JSON.stringify(t));
    const e = await run("npx", ["tsx", "scripts/w05/deploy-plan.ts", "verify", "--manifest", tf], { cwd: APP }).then(() => null, (x: { code: number; stdout: string }) => x);
    expect(e?.code).toBe(1);
    expect(e?.stdout).toContain("CONTENT_HASH_MISMATCH");
  });

  it("write (and DEPLOY_MODE=WRITE) is refused with exit code 3, naming every gate", async () => {
    for (const env of [{}, { DEPLOY_MODE: "WRITE" }]) {
      const e = await run("npx", ["tsx", "scripts/w05/deploy-plan.ts", "write", "--manifest", file, "--confirm", "x"], { cwd: APP, env: { ...process.env, ...env } }).then(() => null, (x: { code: number; stderr: string }) => x);
      expect(e?.code).toBe(3);
      for (const r of ["WRITE_DISABLED", "CHAIN_4663_REFUSED", "CONFIRMATION_REQUIRED", "PLACEHOLDER_ROLES", "PRODUCTION_BLOCKED"]) expect(e?.stderr).toContain(r);
    }
  });
});
