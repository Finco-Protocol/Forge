/**
 * W05 deployment tooling — pure unit tests with a fixture build provider
 * (no artifacts, no chain): manifest integrity/tamper detection, WRITE
 * refusals (hard-disabled, 4663, confirmation), wrong-mask refusal and
 * role-separation refusal.
 */
import { describe, expect, it } from "vitest";
import { getAddress, keccak256, numberToHex, toHex, type Address, type Hex } from "viem";
import {
  DEPLOY_WRITE_ENABLED,
  PlanRefusal,
  assertWriteAllowed,
  buildDeployManifest,
  confirmationTokenFor,
  manifestHash,
  verifyManifest,
  writeRefusals,
  type BuildProvider,
  type DeployManifest,
  type PlanInput,
  type RoleKey,
} from "../../scripts/w05/deploy-plan-lib";
import { create2Address, hookInitCode, hookMaskOk, type BuildSettings } from "../../scripts/w05/hook-mine-lib";

const SETTINGS: BuildSettings = { solcVersion: "0.8.35", optimizer: true, optimizerRuns: 200, viaIR: true, evmVersion: "cancun", bytecodeHash: "ipfs" };
const HOOK_CODE: Hex = "0x6080604052348015600f57600080fd5b50603f80601d6000396000f3fe";
const fixtureBuild = (hookCode: Hex = HOOK_CODE, settings: BuildSettings = { ...SETTINGS, solcVersion: "0.8.35+commit.47b9dedd" }): BuildProvider => ({
  foundryProfile: "forge",
  toml: SETTINGS,
  record: (c) => ({ artifact: `out/forge/${c}.sol/${c}.json`, source: `contractsV2-forge/src/v2/${c}.sol`, settings, creationCodeKeccak: keccak256(toHex(`creation:${c}`)), runtimeCodeKeccak: keccak256(toHex(`runtime:${c}`)), runtimeBytes: 1000 }),
  hookCreationCode: () => hookCode,
  hookArtifactPath: () => "out/forge/PonsV2MemeHook.sol/PonsV2MemeHook.json",
});
const addr = (label: string) => getAddress(`0x${keccak256(toHex(label)).slice(-40)}`) as Address;
const ROLES: Record<RoleKey, Address> = {
  deployer: addr("deployer"),
  governance: addr("governance"),
  treasury: addr("treasury"),
  revenueAttestor: addr("attestor"),
  eligibilityAuthority: addr("authority"),
  feeSweepOperator: addr("operator"),
};
const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  environment: "local-genuine",
  chainId: 31337,
  sourceCommit: "test",
  network: { poolManager: addr("pm"), positionManager: addr("posm"), permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" },
  networkEvidence: { source: "fixture" },
  roles: ROLES,
  placeholderRoles: [],
  deployerStartNonce: 0,
  quoteAssets: [{ symbol: "ETH", address: "0x0000000000000000000000000000000000000000", decimals: 18, evidence: "SOURCE_PROVEN" }],
  launchConfig: { supply: "1000000000000000000000000", curveFeeBps: "100", phantomQuote: "30000000000000000000", graduationThreshold: "30000000000000000000", poolFee: 0, tickSpacing: 10, enabled: true },
  hookSalt: MINED_SALT,
  ...over,
});
// Mine once (deterministic) and reuse the salt; every build still re-verifies it.
// eslint-disable-next-line prefer-const -- assigned after input() (which reads it) is defined
let MINED_SALT: Hex | undefined;
MINED_SALT = buildDeployManifest(input(), fixtureBuild()).hook.salt;
const clone = (m: DeployManifest) => JSON.parse(JSON.stringify(m)) as DeployManifest;

describe("W05 deployment manifest", () => {
  const m = buildDeployManifest(input(), fixtureBuild());

  it("is complete: dependency order, constructor args, predicted addresses, hook evidence, roles, checks, hand-over, sign-off", () => {
    expect(m.status).toBe("DRY_RUN_ONLY");
    expect(m.steps.filter((s) => s.phase === "deploy").map((s) => s.contract)).toEqual([
      "feeEscrow", "revenueSplitter", "memeHook", "buybackVault", "locker", "registry", "authorizer", "factory", "launchDeployer", "graduationExecutor",
    ]);
    expect(m.steps.filter((s) => s.from === "deployer").map((s) => s.nonce)).toEqual(m.steps.filter((s) => s.from === "deployer").map((_s, i) => i));
    expect(hookMaskOk(m.addresses.memeHook)).toBe(true);
    expect(m.hook.constructorArgs).toEqual({ poolManager: m.network.poolManager, feeEscrow: m.addresses.feeEscrow, protocolFeeRecipient: m.addresses.revenueSplitter, owner: ROLES.deployer });
    expect(m.treasuryChecks).toContainEqual({ contract: "memeHook", getter: "protocolFeeRecipient", expected: m.addresses.revenueSplitter });
    expect(m.ownershipTransfer.map((o) => o.contract).sort()).toEqual(["authorizer", "buybackVault", "factory", "locker", "memeHook", "registry", "revenueSplitter"]);
    expect(m.steps.filter((s) => s.fn === "acceptOwnership").every((s) => s.from === "governance")).toBe(true);
    expect(m.steps.at(-1)).toMatchObject({ phase: "go-live", fn: "setLaunchEnabled", requiresSignOff: true });
    expect(m.signOff.length).toBeGreaterThanOrEqual(8);
    expect(m.signOff.every((s) => s.signedBy === null)).toBe(true);
    expect(m.flags).toMatchObject({ DEPLOY_WRITE_ENABLED: false, PRODUCTION_BLOCKED: true, FINCO_BURN_ENABLED: false });
    expect(m.build.consistent).toBe(true);
    expect(m.contentHash).toBe(manifestHash(m));
    expect(verifyManifest(m, fixtureBuild())).toEqual([]);
  });

  it("is deterministic (same inputs → same manifest hash)", () => {
    expect(buildDeployManifest(input(), fixtureBuild()).contentHash).toBe(m.contentHash);
  });

  it("detects tampering: any changed field breaks the content hash", () => {
    for (const mutate of [
      (x: DeployManifest) => (x.roles.treasury = addr("evil")),
      (x: DeployManifest) => (x.launchConfig.curveFeeBps = "101"),
      (x: DeployManifest) => (x.steps[1]!.args[2]!.value = addr("evil")),
      (x: DeployManifest) => (x.signOff[0]!.item = "skip review"),
      (x: DeployManifest) => (x.flags.DEPLOY_WRITE_ENABLED = true),
    ]) {
      const t = clone(m);
      mutate(t);
      expect(verifyManifest(t).join()).toMatch(/CONTENT_HASH_MISMATCH/);
    }
  });

  it("detects consistent-looking tampering even when the attacker recomputes the hash", () => {
    const t = clone(m);
    t.steps[1]!.args[2]!.value = addr("evil"); // treasuryRecipient_ arg no longer matches roles.treasury
    t.contentHash = manifestHash(t);
    expect(verifyManifest(t).join()).toMatch(/arg treasuryRecipient_/);
    const u = clone(m);
    u.addresses.factory = addr("evil");
    u.contentHash = manifestHash(u);
    expect(verifyManifest(u).join()).toMatch(/predicted/);
    const h = clone(m);
    h.hook.salt = numberToHex(BigInt(h.hook.salt) + 1n, { size: 32 });
    h.contentHash = manifestHash(h);
    expect(verifyManifest(h).length).toBeGreaterThan(0);
  });

  it("detects artifact drift against the build it was planned with", () => {
    const drifted: BuildProvider = { ...fixtureBuild(), record: (c) => ({ ...fixtureBuild().record(c), runtimeCodeKeccak: keccak256(toHex(`changed:${c}`)) }) };
    expect(verifyManifest(m, drifted).join()).toMatch(/ARTIFACT_DRIFT/);
    expect(verifyManifest(m, fixtureBuild("0x6001")).join()).toMatch(/creation code differs/);
  });
});

describe("W05 deployment refusals", () => {
  const m = buildDeployManifest(input(), fixtureBuild());

  it("WRITE is hard-disabled: DEPLOY_WRITE_ENABLED is false and even a perfect local request is refused", () => {
    expect(DEPLOY_WRITE_ENABLED).toBe(false);
    const r = writeRefusals({ manifest: m, rpcChainId: 31337, confirmation: confirmationTokenFor(m) });
    expect(r.some((x) => x.startsWith("WRITE_DISABLED"))).toBe(true);
    expect(r.some((x) => x.startsWith("CHAIN_4663_REFUSED"))).toBe(false);
    expect(r.some((x) => x.startsWith("CONFIRMATION_REQUIRED"))).toBe(false);
    expect(() => assertWriteAllowed({ manifest: m, rpcChainId: 31337, confirmation: confirmationTokenFor(m) })).toThrow(/WRITE_REFUSED/);
  });

  it("chain 4663 is refused regardless (RPC chain or manifest chain)", () => {
    const m4663 = buildDeployManifest(input({ environment: "robinhood-4663", chainId: 4663, placeholderRoles: ["governance"] }), fixtureBuild());
    expect(m4663.status).toBe("NOT_EXECUTABLE");
    const r = writeRefusals({ manifest: m4663, rpcChainId: 4663, confirmation: confirmationTokenFor(m4663) });
    expect(r.some((x) => x.startsWith("CHAIN_4663_REFUSED"))).toBe(true);
    expect(r.some((x) => x.startsWith("PLACEHOLDER_ROLES"))).toBe(true);
    expect(writeRefusals({ manifest: m, rpcChainId: 4663, confirmation: confirmationTokenFor(m) }).some((x) => x.startsWith("CHAIN_4663_REFUSED"))).toBe(true);
  });

  it("an explicit operator confirmation token bound to the manifest hash is required", () => {
    for (const confirmation of [null, "", "yes", confirmationTokenFor({ chainId: 31337, contentHash: keccak256("0x01") })]) {
      expect(writeRefusals({ manifest: m, rpcChainId: 31337, confirmation }).some((x) => x.startsWith("CONFIRMATION_REQUIRED"))).toBe(true);
    }
    const t = clone(m);
    t.roles.treasury = addr("evil");
    expect(writeRefusals({ manifest: t, rpcChainId: 31337, confirmation: confirmationTokenFor(t) }).some((x) => x.startsWith("MANIFEST_INVALID"))).toBe(true);
  });

  it("refuses a hook salt whose address does not carry mask 0x2044", () => {
    const initHash = keccak256(hookInitCode(HOOK_CODE, m.hook.constructorArgs));
    let s = 0n;
    while (hookMaskOk(create2Address(m.network.create2Deployer, numberToHex(s, { size: 32 }), initHash))) s++;
    expect(() => buildDeployManifest(input({ hookSalt: numberToHex(s, { size: 32 }) }), fixtureBuild())).toThrow(PlanRefusal);
    expect(() => buildDeployManifest(input({ hookSalt: numberToHex(s, { size: 32 }) }), fixtureBuild())).toThrow(/HOOK_MASK_MISMATCH/);
    // the mined salt itself is accepted when supplied explicitly
    expect(buildDeployManifest(input({ hookSalt: m.hook.salt }), fixtureBuild()).hook.computedAddress).toBe(m.hook.computedAddress);
  });

  it("refuses missing role separation (governance == treasury, attestor == governance, deployer == governance, zero address)", () => {
    for (const [a, b] of [["governance", "treasury"], ["revenueAttestor", "governance"], ["deployer", "governance"], ["treasury", "revenueAttestor"], ["eligibilityAuthority", "feeSweepOperator"]] as Array<[RoleKey, RoleKey]>) {
      expect(() => buildDeployManifest(input({ roles: { ...ROLES, [a]: ROLES[b] } }), fixtureBuild())).toThrow(/ROLES_NOT_SEPARATED/);
    }
    expect(() => buildDeployManifest(input({ roles: { ...ROLES, treasury: "0x0000000000000000000000000000000000000000" } }), fixtureBuild())).toThrow(/zero address/);
    const t = clone(m);
    t.roles.treasury = t.roles.governance;
    t.contentHash = manifestHash(t);
    expect(verifyManifest(t).join()).toMatch(/ROLES_NOT_SEPARATED/);
  });

  it("flags a build whose artifact settings differ from foundry.toml", () => {
    const bad = buildDeployManifest(input(), fixtureBuild(HOOK_CODE, { ...SETTINGS, optimizerRuns: 300 }));
    expect(bad.build.consistent).toBe(false);
    expect(bad.statusReasons).toContain("build settings mismatch");
    expect(verifyManifest(bad).join()).toMatch(/build settings/);
  });
});
