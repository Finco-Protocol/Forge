/**
 * W05 deployment tooling — pure manifest logic (no filesystem, no network).
 *
 * A deployment manifest is a complete, content-hashed description of one
 * Forge-stack deployment: environment, exact build provenance, the ordered
 * dependency plan with constructor arguments and PREDICTED addresses, the
 * CREATE2 hook evidence, roles/owners, treasury configuration, runtime and
 * role checks, smoke tests, the Ownable2Step hand-over, emergency references
 * and the operator sign-off checklist.
 *
 * WRITE (broadcast) mode is HARD-DISABLED in this PR: `DEPLOY_WRITE_ENABLED`
 * is a compile-time `false`, chain 4663 is refused regardless, and an exact
 * operator confirmation token bound to the manifest hash is required. There
 * is deliberately no override parameter.
 */
import { getAddress, getContractAddress, isAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { buildHookEvidence, verifyHookEvidence, CREATE2_PROXY, type BuildSettings, type HookEvidence } from "./hook-mine-lib";

/** Broadcasting a deployment is disabled in this PR. Do not change without governance sign-off. */
export const DEPLOY_WRITE_ENABLED = false as const;
export const ROBINHOOD_CHAIN_ID = 4663;
export const NATIVE: Address = "0x0000000000000000000000000000000000000000";

export type Environment = "local-genuine" | "fork-4663" | "robinhood-4663";
export type RoleKey = "deployer" | "governance" | "treasury" | "revenueAttestor" | "eligibilityAuthority" | "feeSweepOperator";
export type ContractKey =
  | "feeEscrow"
  | "revenueSplitter"
  | "memeHook"
  | "buybackVault"
  | "locker"
  | "registry"
  | "authorizer"
  | "factory"
  | "launchDeployer"
  | "graduationExecutor";
export type NetworkKey = "poolManager" | "positionManager" | "permit2" | "create2Deployer";

export const CONTRACT_NAMES: Record<ContractKey, string> = {
  feeEscrow: "PonsV2FeeEscrow",
  revenueSplitter: "ForgeProtocolRevenueSplitter",
  memeHook: "PonsV2MemeHook",
  buybackVault: "PonsV2BuybackVault",
  locker: "PonsV2LaunchLocker",
  registry: "ForgeBindingRegistry",
  authorizer: "ForgeLaunchAuthorizer",
  factory: "PonsV2LaunchFactory",
  launchDeployer: "PonsV2LaunchDeployer",
  graduationExecutor: "PonsV2GraduationExecutor",
};
/** Ownable2Step contracts handed to governance. */
export const OWNED: ContractKey[] = ["registry", "authorizer", "factory", "memeHook", "buybackVault", "locker", "revenueSplitter"];

export type Arg = { name: string; ref?: ContractKey | RoleKey | NetworkKey; value: string };

export interface PlanStep {
  n: number;
  phase: "deploy" | "wire" | "handover" | "go-live";
  kind: "create" | "create2" | "call";
  from: RoleKey;
  /** Deployer nonce consumed by this step (deployer steps only). */
  nonce: number | null;
  contract: ContractKey;
  fn: string | null;
  args: Arg[];
  predicted: Address | null;
  requiresSignOff: boolean;
}

export interface LaunchConfigSpec {
  supply: string;
  curveFeeBps: string;
  phantomQuote: string;
  graduationThreshold: string;
  poolFee: number;
  tickSpacing: number;
  enabled: boolean;
}

export interface PlanInput {
  environment: Environment;
  chainId: number;
  sourceCommit: string | null;
  network: Record<"poolManager" | "positionManager" | "permit2", Address> & { create2Deployer?: Address };
  networkEvidence: Record<string, string>;
  roles: Record<RoleKey, Address>;
  /** Roles that are placeholders (not real custody) — a manifest with any is NOT_EXECUTABLE on a real chain. */
  placeholderRoles: RoleKey[];
  deployerStartNonce: number;
  quoteAssets: Array<{ symbol: string; address: Address; decimals: number; evidence: string }>;
  launchConfig: LaunchConfigSpec;
  /** Optional pre-chosen hook salt (verified, never trusted). */
  hookSalt?: Hex;
}

export interface BuildProvider {
  foundryProfile: string;
  toml: BuildSettings;
  /** Per contract: settings recorded in its artifact metadata + bytecode digests. */
  record(contract: string): { artifact: string; source: string; settings: BuildSettings; creationCodeKeccak: Hex; runtimeCodeKeccak: Hex; runtimeBytes: number };
  hookCreationCode(): Hex;
  hookArtifactPath(): string;
}

export interface DeployManifest {
  kind: "FINCO_FORGE_DEPLOYMENT_MANIFEST";
  version: 1;
  environment: Environment;
  chainId: number;
  status: "DRY_RUN_ONLY" | "NOT_EXECUTABLE";
  statusReasons: string[];
  generatedBy: string;
  sourceCommit: string | null;
  flags: Record<string, boolean>;
  build: { foundryProfile: string; toml: BuildSettings; consistent: boolean; mismatches: string[]; contracts: Array<ReturnType<BuildProvider["record"]> & { contract: string }> };
  network: { poolManager: Address; positionManager: Address; permit2: Address; create2Deployer: Address; evidence: Record<string, string> };
  roles: Record<RoleKey, Address>;
  placeholderRoles: RoleKey[];
  roleSeparation: { ok: boolean; rule: string };
  quoteAssets: PlanInput["quoteAssets"];
  launchConfig: LaunchConfigSpec;
  deployerStartNonce: number;
  addresses: Record<ContractKey, Address>;
  hook: HookEvidence;
  steps: PlanStep[];
  expectedRoles: Array<{ contract: ContractKey; getter: string; expected: Address | string; note?: string }>;
  treasuryChecks: Array<{ contract: ContractKey; getter: string; args?: string[]; expected: string }>;
  runtimeChecks: Array<{ contract: ContractKey; artifact: string; rule: string }>;
  smokeTests: Array<{ id: string; description: string }>;
  ownershipTransfer: Array<{ contract: ContractKey; from: Address; to: Address; steps: string[] }>;
  emergency: Array<{ ref: string; what: string }>;
  signOff: Array<{ id: string; item: string; signedBy: null }>;
  contentHash: Hex;
}

// ── canonical hashing ────────────────────────────────────────────────────

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export function manifestHash(m: Omit<DeployManifest, "contentHash"> | DeployManifest): Hex {
  const { contentHash: _omit, ...rest } = m as DeployManifest;
  return keccak256(toHex(canonicalJson(rest)));
}

// ── validation ───────────────────────────────────────────────────────────

export class PlanRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

/** Every role must be a distinct, non-zero address (governance ≠ treasury ≠ attestor ≠ deployer …). */
export function roleSeparationViolations(roles: Record<RoleKey, Address>): string[] {
  const out: string[] = [];
  const entries = Object.entries(roles) as Array<[RoleKey, Address]>;
  for (const [k, a] of entries) {
    if (!isAddress(a, { strict: false })) out.push(`${k} is not an address`);
    else if (BigInt(a) === 0n) out.push(`${k} is the zero address`);
  }
  for (let i = 0; i < entries.length; i++)
    for (let j = i + 1; j < entries.length; j++) {
      const [ka, a] = entries[i]!;
      const [kb, b] = entries[j]!;
      if (isAddress(a, { strict: false }) && isAddress(b, { strict: false }) && getAddress(a) === getAddress(b)) out.push(`${ka} == ${kb} (${getAddress(a)})`);
    }
  return out;
}

// ── plan construction ────────────────────────────────────────────────────

const SMOKE_TESTS: DeployManifest["smokeTests"] = [
  { id: "S01", description: "Every planned address has code; every Forge runtime equals its compiled artifact (immutables masked)." },
  { id: "S02", description: "Hook address carries exactly the 0x2044 permission mask; hook.poolManager == network PoolManager." },
  { id: "S03", description: "hook.protocolFeeRecipient == ForgeProtocolRevenueSplitter (fee recipient = splitter)." },
  { id: "S04", description: "Factory wiring: poolManager, positionManager, permit2, locker, memeHook, feeEscrow, buybackVault, launchAuthorizer, launchDeployer, graduationExecutor." },
  { id: "S05", description: "Executor/locker/vault/authorizer/splitter point at the factory; registry & authorizer use the eligibility authority." },
  { id: "S06", description: "All Ownable2Step contracts owned by governance with no pending owner; the deployer holds no role." },
  { id: "S07", description: "Treasury: splitter treasuryRecipient, revenueAttestor, feeEscrow, forgeFactory, approvedAsset(NATIVE), FINCO_BURN_ENABLED=false, pullsPaused=false." },
  { id: "S08", description: "previewLaunchEconomics(0, NATIVE) succeeds; launch config 0 matches the manifest." },
  { id: "S09", description: "An unauthorized launch (no binding, no signatures) reverts at the factory (M-ELIG gate, eth_call only)." },
  { id: "S10", description: "The hook refuses pool initialization by anyone but the factory (genuine PoolManager.initialize via eth_call)." },
];

const EMERGENCY: DeployManifest["emergency"] = [
  { ref: "docs/W03-SECURITY-RUNBOOK.md", what: "Incident response, key compromise, PRODUCTION_BLOCKED gates" },
  { ref: "docs/W04-ECONOMICS-ARCHITECTURE.md", what: "Splitter pause (setPullsPaused), attestor revocation (revokeRevenueAttestor), timelocked recipient rotation" },
  { ref: "docs/W05-ROBINHOOD-V4-DEPLOYMENT.md#rollback-and-emergency", what: "Rollback: factory.setLaunchEnabled(false); a deployment cannot be 'undone' on chain — abandon and redeploy from a new manifest" },
];

const SIGN_OFF = [
  "Independent security review of the exact build in `build.contracts` (creation/runtime keccak) completed",
  "Governance address is a real multisig/timelock (not a placeholder) and its signers confirmed",
  "Treasury recipient, revenue attestor, eligibility authority and fee-sweep operator custody approved (W05 key custody)",
  "Deterministic-deployment proxy presence on the target chain verified read-only (CI fork job)",
  "Genuine V4 runtime identity on the target chain verified (CI fork job: test:v4:fork)",
  "DRY_RUN of THIS manifest hash passed on a fork of the target chain (smoke + role checks)",
  "PRODUCTION_BLOCKED lifted by governance decision recorded in docs (not by this tool)",
  "DEPLOY_WRITE_ENABLED changed in a reviewed PR (not in this PR)",
];

export function buildDeployManifest(input: PlanInput, build: BuildProvider): DeployManifest {
  const roles = Object.fromEntries(Object.entries(input.roles).map(([k, v]) => [k, isAddress(v, { strict: false }) ? getAddress(v) : v])) as Record<RoleKey, Address>;
  const violations = roleSeparationViolations(roles);
  if (violations.length) throw new PlanRefusal("ROLES_NOT_SEPARATED", violations.join("; "));
  const net = {
    poolManager: getAddress(input.network.poolManager),
    positionManager: getAddress(input.network.positionManager),
    permit2: getAddress(input.network.permit2),
    create2Deployer: getAddress(input.network.create2Deployer ?? CREATE2_PROXY),
  };
  const deployer = roles.deployer;
  let nonce = input.deployerStartNonce;
  const addresses = {} as Record<ContractKey, Address>;
  const steps: PlanStep[] = [];
  const val = (ref: ContractKey | RoleKey | NetworkKey): string => {
    if (ref in addresses) return addresses[ref as ContractKey];
    if (ref in roles) return roles[ref as RoleKey];
    if (ref in net) return net[ref as NetworkKey];
    throw new Error(`unresolved ref ${ref}`);
  };
  const arg = (name: string, ref: ContractKey | RoleKey | NetworkKey): Arg => ({ name, ref, value: val(ref) });
  const lit = (name: string, value: string): Arg => ({ name, value });
  const push = (s: Omit<PlanStep, "n">) => steps.push({ n: steps.length + 1, ...s });
  const create = (contract: ContractKey, args: Arg[]) => {
    const predicted = getContractAddress({ from: deployer, nonce: BigInt(nonce) });
    addresses[contract] = predicted;
    push({ phase: "deploy", kind: "create", from: "deployer", nonce: nonce++, contract, fn: null, args, predicted, requiresSignOff: false });
  };
  const call = (phase: PlanStep["phase"], from: RoleKey, contract: ContractKey, fn: string, args: Arg[], requiresSignOff = false) =>
    push({ phase, kind: "call", from, nonce: from === "deployer" ? nonce++ : null, contract, fn, args, predicted: null, requiresSignOff });

  create("feeEscrow", []);
  create("revenueSplitter", [arg("feeEscrow_", "feeEscrow"), arg("owner_", "deployer"), arg("treasuryRecipient_", "treasury"), arg("revenueAttestor_", "revenueAttestor")]);
  // Hook: CREATE2 through the deterministic-deployment proxy; owner = deployer until the hand-over.
  const toml = build.toml;
  const hookRec = build.record("PonsV2MemeHook");
  const hook = buildHookEvidence({
    chainIdTarget: input.chainId,
    artifact: build.hookArtifactPath(),
    creationCode: build.hookCreationCode(),
    args: { poolManager: net.poolManager, feeEscrow: addresses.feeEscrow, protocolFeeRecipient: addresses.revenueSplitter, owner: deployer },
    deployer: net.create2Deployer,
    foundryProfile: build.foundryProfile,
    toml,
    artifactMetadata: hookRec.settings,
    salt: input.hookSalt,
  });
  if (!hook.maskOk) throw new PlanRefusal("HOOK_MASK_MISMATCH", `${hook.computedAddress} has permission bits ${hook.permissionBits}, required 0x2044`);
  addresses.memeHook = hook.computedAddress;
  push({
    phase: "deploy",
    kind: "create2",
    from: "deployer",
    nonce: nonce++,
    contract: "memeHook",
    fn: null,
    args: [arg("poolManager_", "poolManager"), arg("feeEscrow_", "feeEscrow"), arg("protocolFeeRecipient_", "revenueSplitter"), arg("initialOwner_", "deployer"), lit("salt", hook.salt), arg("create2Deployer", "create2Deployer")],
    predicted: hook.computedAddress,
    requiresSignOff: false,
  });
  create("buybackVault", [arg("initialOwner", "deployer"), arg("feePolicy_", "memeHook"), arg("feeEscrow_", "feeEscrow")]);
  create("locker", [arg("initialOwner", "deployer"), arg("positionManager_", "positionManager")]);
  create("registry", [arg("authority_", "eligibilityAuthority")]);
  create("authorizer", [arg("registry_", "registry"), arg("eligibilityAuthority_", "eligibilityAuthority")]);
  create("factory", [
    arg("initialOwner", "deployer"),
    arg("poolManager_", "poolManager"),
    arg("positionManager_", "positionManager"),
    arg("permit2_", "permit2"),
    arg("locker_", "locker"),
    arg("memeHook_", "memeHook"),
    arg("feeEscrow_", "feeEscrow"),
    arg("buybackVault_", "buybackVault"),
    arg("launchAuthorizer_", "authorizer"),
    lit("initialLaunchFee", "0"),
  ]);
  create("launchDeployer", [arg("factory_", "factory")]);
  create("graduationExecutor", [arg("positionManager_", "positionManager"), arg("permit2_", "permit2"), arg("locker_", "locker"), arg("factory_", "factory")]);

  call("wire", "deployer", "authorizer", "setForgeFactory", [arg("factory", "factory")]);
  call("wire", "deployer", "memeHook", "setFactory", [arg("factory", "factory")]);
  call("wire", "deployer", "memeHook", "setBuybackVault", [arg("vault", "buybackVault")]);
  call("wire", "deployer", "buybackVault", "setFactory", [arg("factory", "factory")]);
  call("wire", "deployer", "locker", "setFactory", [arg("factory", "factory")]);
  call("wire", "deployer", "factory", "setLaunchDeployer", [arg("deployer", "launchDeployer")]);
  call("wire", "deployer", "factory", "setGraduationExecutor", [arg("executor", "graduationExecutor")]);
  call("wire", "deployer", "revenueSplitter", "setForgeFactory", [arg("factory", "factory")]);
  call("wire", "deployer", "memeHook", "setFeeSweepOperator", [arg("operator", "feeSweepOperator")]);
  call("wire", "deployer", "factory", "addLaunchConfig", [lit("config", canonicalJson(input.launchConfig))]);
  for (const c of OWNED) call("handover", "deployer", c, "transferOwnership", [arg("newOwner", "governance")]);
  for (const c of OWNED) call("handover", "governance", c, "acceptOwnership", []);
  call("go-live", "governance", "factory", "setLaunchEnabled", [lit("enabled", "true")], true);

  const contracts = (Object.values(CONTRACT_NAMES) as string[]).map((c) => ({ contract: c, ...build.record(c) }));
  const mismatches: string[] = [];
  for (const c of contracts) {
    const s = c.settings;
    if (!s.solcVersion.startsWith(toml.solcVersion) || s.optimizerRuns !== toml.optimizerRuns || s.viaIR !== toml.viaIR || s.evmVersion !== toml.evmVersion || s.optimizer !== toml.optimizer)
      mismatches.push(`${c.contract}: artifact settings ${JSON.stringify(s)} ≠ foundry.toml ${JSON.stringify(toml)}`);
  }

  const statusReasons: string[] = ["DEPLOY_WRITE_ENABLED=false (this PR)", "PRODUCTION_BLOCKED=true"];
  if (input.placeholderRoles.length) statusReasons.push(`placeholder roles: ${input.placeholderRoles.join(", ")}`);
  if (mismatches.length) statusReasons.push("build settings mismatch");
  // No manifest is executable against a real chain in this PR; local/fork manifests are DRY_RUN material only.
  const status: DeployManifest["status"] = input.environment === "robinhood-4663" ? "NOT_EXECUTABLE" : "DRY_RUN_ONLY";

  const m: Omit<DeployManifest, "contentHash"> = {
    kind: "FINCO_FORGE_DEPLOYMENT_MANIFEST",
    version: 1,
    environment: input.environment,
    chainId: input.chainId,
    status,
    statusReasons,
    generatedBy: "apps/forge-web/scripts/w05/deploy-plan.ts",
    sourceCommit: input.sourceCommit,
    flags: { DEPLOY_WRITE_ENABLED, PRODUCTION_BLOCKED: true, FINCO_BURN_ENABLED: false, FORGE_FEE_POLICY_AUTHORITY_UNPROVEN: true, REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED: false },
    build: { foundryProfile: build.foundryProfile, toml, consistent: mismatches.length === 0, mismatches, contracts },
    network: { ...net, evidence: input.networkEvidence },
    roles,
    placeholderRoles: [...input.placeholderRoles].sort(),
    roleSeparation: { ok: true, rule: "deployer, governance, treasury, revenueAttestor, eligibilityAuthority and feeSweepOperator are pairwise distinct non-zero addresses" },
    quoteAssets: input.quoteAssets,
    launchConfig: input.launchConfig,
    deployerStartNonce: input.deployerStartNonce,
    addresses,
    hook,
    steps,
    expectedRoles: [
      ...OWNED.map((c) => ({ contract: c, getter: "owner", expected: roles.governance })),
      ...OWNED.map((c) => ({ contract: c, getter: "pendingOwner", expected: NATIVE, note: "no pending hand-over" })),
      { contract: "memeHook", getter: "feeSweepOperator", expected: roles.feeSweepOperator },
      { contract: "registry", getter: "eligibilityAuthority", expected: roles.eligibilityAuthority },
      { contract: "authorizer", getter: "eligibilityAuthority", expected: roles.eligibilityAuthority },
      { contract: "authorizer", getter: "forgeFactory", expected: addresses.factory },
      { contract: "memeHook", getter: "factory", expected: addresses.factory },
      { contract: "buybackVault", getter: "factory", expected: addresses.factory },
      { contract: "locker", getter: "factory", expected: addresses.factory },
      { contract: "graduationExecutor", getter: "factory", expected: addresses.factory },
      { contract: "launchDeployer", getter: "factory", expected: addresses.factory },
      { contract: "factory", getter: "launchDeployer", expected: addresses.launchDeployer },
      { contract: "factory", getter: "graduationExecutor", expected: addresses.graduationExecutor },
      { contract: "factory", getter: "launchAuthorizer", expected: addresses.authorizer },
      { contract: "factory", getter: "memeHook", expected: addresses.memeHook },
      { contract: "factory", getter: "feeEscrow", expected: addresses.feeEscrow },
      { contract: "factory", getter: "buybackVault", expected: addresses.buybackVault },
      { contract: "factory", getter: "locker", expected: addresses.locker },
      { contract: "factory", getter: "poolManager", expected: net.poolManager },
      { contract: "factory", getter: "positionManager", expected: net.positionManager },
      { contract: "factory", getter: "permit2", expected: net.permit2 },
      { contract: "memeHook", getter: "poolManager", expected: net.poolManager },
      { contract: "graduationExecutor", getter: "positionManager", expected: net.positionManager },
      { contract: "graduationExecutor", getter: "permit2", expected: net.permit2 },
      { contract: "locker", getter: "positionManager", expected: net.positionManager },
    ],
    treasuryChecks: [
      { contract: "memeHook", getter: "protocolFeeRecipient", expected: addresses.revenueSplitter },
      { contract: "memeHook", getter: "feeEscrow", expected: addresses.feeEscrow },
      { contract: "memeHook", getter: "protocolFeeShareBps", expected: "3000" },
      { contract: "revenueSplitter", getter: "treasuryRecipient", expected: roles.treasury },
      { contract: "revenueSplitter", getter: "revenueAttestor", expected: roles.revenueAttestor },
      { contract: "revenueSplitter", getter: "feeEscrow", expected: addresses.feeEscrow },
      { contract: "revenueSplitter", getter: "forgeFactory", expected: addresses.factory },
      { contract: "revenueSplitter", getter: "FINCO_BURN_ENABLED", expected: "false" },
      { contract: "revenueSplitter", getter: "pullsPaused", expected: "false" },
      { contract: "revenueSplitter", getter: "RECIPIENT_TIMELOCK", expected: String(3 * 86_400) },
      ...input.quoteAssets.map((q) => ({ contract: "revenueSplitter" as const, getter: "approvedAsset", args: [q.address], expected: "true" })),
    ],
    runtimeChecks: (Object.keys(CONTRACT_NAMES) as ContractKey[]).map((c) => ({ contract: c, artifact: `out/forge/${CONTRACT_NAMES[c]}.sol/${CONTRACT_NAMES[c]}.json`, rule: "eth_getCode == artifact deployedBytecode with immutableReferences masked" })),
    smokeTests: SMOKE_TESTS,
    ownershipTransfer: OWNED.map((c) => ({ contract: c, from: deployer, to: roles.governance, steps: [`${CONTRACT_NAMES[c]}.transferOwnership(governance) — by deployer`, `${CONTRACT_NAMES[c]}.acceptOwnership() — by governance (Ownable2Step)`] })),
    emergency: EMERGENCY,
    signOff: SIGN_OFF.map((item, i) => ({ id: `O${String(i + 1).padStart(2, "0")}`, item, signedBy: null })),
  };
  return { ...m, contentHash: manifestHash(m) };
}

/**
 * Integrity check: recomputes the content hash and re-derives everything
 * derivable (predicted CREATE addresses, hook CREATE2 address + mask, role
 * separation). Returns failures (empty = valid). Optional `build` re-checks
 * the recorded build against the current artifacts (drift = failure).
 */
export function verifyManifest(m: DeployManifest, build?: BuildProvider): string[] {
  const out: string[] = [];
  if (m.kind !== "FINCO_FORGE_DEPLOYMENT_MANIFEST" || m.version !== 1) out.push("not a v1 Forge deployment manifest");
  const h = manifestHash(m);
  if (h !== m.contentHash) out.push(`CONTENT_HASH_MISMATCH: recomputed ${h}, manifest says ${m.contentHash}`);
  const v = roleSeparationViolations(m.roles);
  if (v.length) out.push(`ROLES_NOT_SEPARATED: ${v.join("; ")}`);
  if (m.flags.DEPLOY_WRITE_ENABLED !== false || m.flags.PRODUCTION_BLOCKED !== true || m.flags.FINCO_BURN_ENABLED !== false) out.push("safety flags altered");
  for (const s of m.steps) {
    if (s.kind === "create") {
      const p = getContractAddress({ from: m.roles.deployer, nonce: BigInt(s.nonce!) });
      if (p !== s.predicted || m.addresses[s.contract] !== p) out.push(`step ${s.n}: predicted ${s.predicted} ≠ CREATE(deployer, ${s.nonce}) ${p}`);
    }
    for (const a of s.args) {
      if (!a.ref) continue;
      const exp = (m.addresses as Record<string, string>)[a.ref] ?? (m.roles as Record<string, string>)[a.ref] ?? (m.network as unknown as Record<string, string>)[a.ref];
      if (exp !== a.value) out.push(`step ${s.n}: arg ${a.name} = ${a.value} but ${a.ref} = ${exp}`);
    }
  }
  if (m.hook.constructorArgs.owner !== m.roles.deployer || m.hook.constructorArgs.protocolFeeRecipient !== m.addresses.revenueSplitter || m.hook.constructorArgs.feeEscrow !== m.addresses.feeEscrow || m.hook.constructorArgs.poolManager !== m.network.poolManager)
    out.push("hook constructor args do not match the plan");
  if (m.hook.computedAddress !== m.addresses.memeHook) out.push("hook address ≠ planned memeHook address");
  out.push(...verifyHookEvidence(m.hook, build?.hookCreationCode()));
  if (build) {
    for (const c of m.build.contracts) {
      const cur = build.record(c.contract);
      if (cur.creationCodeKeccak !== c.creationCodeKeccak || cur.runtimeCodeKeccak !== c.runtimeCodeKeccak) out.push(`ARTIFACT_DRIFT: ${c.contract} bytecode differs from the manifest build`);
    }
  }
  return out;
}

// ── WRITE refusal ────────────────────────────────────────────────────────

/** The exact operator confirmation token for a manifest (bound to chain + content hash). */
export function confirmationTokenFor(m: Pick<DeployManifest, "chainId" | "contentHash">): string {
  return `DEPLOY-FINCO-FORGE-CHAIN-${m.chainId}-${m.contentHash.slice(2, 18)}`;
}

/**
 * Every reason WRITE is refused (non-short-circuit, so each gate is testable
 * on its own). In this PR the list is never empty: DEPLOY_WRITE_ENABLED is false.
 */
export function writeRefusals(req: { manifest: DeployManifest; rpcChainId: number; confirmation?: string | null }): string[] {
  const out: string[] = [];
  if (!DEPLOY_WRITE_ENABLED) out.push("WRITE_DISABLED: DEPLOY_WRITE_ENABLED=false in this PR");
  if (req.rpcChainId === ROBINHOOD_CHAIN_ID || req.manifest.chainId === ROBINHOOD_CHAIN_ID) out.push("CHAIN_4663_REFUSED: broadcasting to Robinhood Chain is refused regardless of any other setting");
  if (req.rpcChainId !== req.manifest.chainId) out.push(`CHAIN_MISMATCH: RPC chain ${req.rpcChainId} ≠ manifest chain ${req.manifest.chainId}`);
  if (!req.confirmation || req.confirmation !== confirmationTokenFor(req.manifest)) out.push("CONFIRMATION_REQUIRED: the exact operator confirmation token for this manifest hash was not supplied");
  const integrity = verifyManifest(req.manifest);
  if (integrity.length) out.push(`MANIFEST_INVALID: ${integrity.join("; ")}`);
  if (req.manifest.placeholderRoles.length) out.push(`PLACEHOLDER_ROLES: ${req.manifest.placeholderRoles.join(", ")}`);
  out.push("PRODUCTION_BLOCKED: governance has not lifted the production block");
  return out;
}

/** Throws unless every WRITE gate passes — which cannot happen in this PR. */
export function assertWriteAllowed(req: Parameters<typeof writeRefusals>[0]): never | void {
  const r = writeRefusals(req);
  if (r.length) throw new PlanRefusal("WRITE_REFUSED", r.join(" | "));
}
