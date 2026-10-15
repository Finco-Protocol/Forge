/**
 * W05 deployment tooling CLI (DRY_RUN only in this PR).
 *
 *   pnpm w05:deploy-plan plan    --env robinhood-4663 [--out manifest.json]   offline manifest (status NOT_EXECUTABLE)
 *   pnpm w05:deploy-plan verify  --manifest manifest.json                     content hash + derivations + artifact drift; exit 1 on tamper
 *   pnpm w05:deploy-plan dry-run [--env local-genuine|fork-4663] [--out report.json]
 *        local-genuine: fresh Anvil + genuine V4, build the manifest, EXECUTE it step by step, then run
 *                       runtime/role/treasury checks and smoke tests against the result.
 *        fork-4663:     same on a LOCAL Anvil fork of 4663 (CI only; FORGE_FORK_RPC_URL required).
 *   pnpm w05:deploy-plan write   --manifest m.json --rpc URL --confirm TOKEN  ALWAYS REFUSED in this PR (exit 3)
 *
 * DEPLOY_MODE=WRITE is equivalent to the `write` command and is refused the same way.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  concat,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  toFunctionSelector,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import manifest4663 from "../../config/networks/robinhood-4663.json";
import { loadArtifact, REPO_ROOT } from "../artifacts";
import { isLocalAnvilFork } from "../sandbox-lib";
import { acceptS09, acceptS10, rawEthCall } from "./smoke-accept";
import { rpcCall } from "./anvil-proc";
import { assertLocalAutomine, assertLoopbackRpc, probeForkLatency, sendAndConfirm, TxConfirmError, type SendCtx, type StepRecord, type TxClass, type TxSnapshot } from "./tx-confirm";
import { contractBuildRecord, forgeArtifactPath, readRawArtifact, tomlBuildSettings } from "./build-info";
import { compareRuntime } from "./uniswap-artifacts";
import { hookInitCode, hookMaskOk } from "./hook-mine-lib";
import { startGenuineChain, type GenuineChain } from "./genuine-v4";
import {
  buildDeployManifest,
  verifyManifest,
  writeRefusals,
  CONTRACT_NAMES,
  NATIVE,
  ROBINHOOD_CHAIN_ID,
  type BuildProvider,
  type ContractKey,
  type DeployManifest,
  type Environment,
  type PlanInput,
  type RoleKey,
} from "./deploy-plan-lib";

/** Clearly-labelled placeholder addresses (keccak of a label; nobody holds their keys). */
export function placeholder(label: string): Address {
  return getAddress(`0x${keccak256(toHex(`FINCO_FORGE_W05_PLACEHOLDER:${label}`)).slice(-40)}`);
}

export const PLACEHOLDER_ROLES: Record<RoleKey, Address> = {
  deployer: placeholder("deployer"),
  governance: placeholder("governance"),
  treasury: placeholder("treasury"),
  revenueAttestor: placeholder("revenueAttestor"),
  eligibilityAuthority: placeholder("eligibilityAuthority"),
  feeSweepOperator: placeholder("feeSweepOperator"),
};

export const DEFAULT_LAUNCH_CONFIG = {
  supply: (1_000_000n * 10n ** 18n).toString(),
  curveFeeBps: "100",
  phantomQuote: (30n * 10n ** 18n).toString(),
  graduationThreshold: (30n * 10n ** 18n).toString(),
  poolFee: 0,
  tickSpacing: 10,
  enabled: true,
};

export function forgeBuildProvider(): BuildProvider {
  return {
    foundryProfile: "forge",
    toml: tomlBuildSettings("forge"),
    record: (c) => {
      const r = contractBuildRecord(c);
      return { artifact: r.artifact, source: r.source, settings: r.settings, creationCodeKeccak: r.creationCodeKeccak, runtimeCodeKeccak: r.runtimeCodeKeccak, runtimeBytes: r.runtimeBytes };
    },
    hookCreationCode: () => readRawArtifact(forgeArtifactPath("PonsV2MemeHook")).bytecode.object,
    hookArtifactPath: () => path.relative(REPO_ROOT, forgeArtifactPath("PonsV2MemeHook")),
  };
}

function gitCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export function planInputFor(env: Environment, network?: PlanInput["network"]): PlanInput {
  const u = manifest4663.uniswapV4;
  const chainId = env === "local-genuine" ? 31337 : ROBINHOOD_CHAIN_ID;
  const net = network ?? { poolManager: getAddress(u.poolManager.address), positionManager: getAddress(u.positionManager.address), permit2: getAddress(u.permit2.address) };
  return {
    environment: env,
    chainId,
    sourceCommit: gitCommit(),
    network: net,
    networkEvidence:
      env === "local-genuine"
        ? { source: "local Anvil, genuine @uniswap/v4-core@1.0.2 + @uniswap/v4-periphery@1.0.3 artifacts (scripts/w05/genuine-v4.ts)" }
        : {
            source: "config/networks/robinhood-4663.json",
            poolManager: u.poolManager.evidence,
            positionManager: u.positionManager.evidence,
            permit2: u.permit2.evidence,
            create2Deployer: "UNVERIFIED from the dev container; verified read-only by the CI fork job (test/v4-fork/fork-runtime.test.ts)",
          },
    roles: PLACEHOLDER_ROLES,
    placeholderRoles: Object.keys(PLACEHOLDER_ROLES) as RoleKey[],
    deployerStartNonce: 0,
    quoteAssets: manifest4663.quoteAssets.map((q) => ({ symbol: q.symbol, address: getAddress(q.address), decimals: q.decimals, evidence: q.evidence })),
    launchConfig: DEFAULT_LAUNCH_CONFIG,
  };
}

// ── DRY_RUN executor ─────────────────────────────────────────────────────

export interface DryRunReport {
  manifestHash: Hex;
  environment: Environment;
  rpcChainId: number;
  executedSteps: number;
  checks: Array<{ id: string; ok: boolean; detail: string }>;
  ok: boolean;
  /** COMPLETE only when every manifest step confirmed and every check ran; anything else is FAILED (never a partial "success") */
  status: "COMPLETE" | "FAILED";
  /** one record per attempted deployment step (nonce, hash, fees, blocks, receipt, elapsed) */
  stepHistory: StepRecord[];
  /** present on a transaction-confirmation failure: classification, step, and the node snapshot */
  failure?: { step: number; classification: TxClass; message: string; snapshot: TxSnapshot | null };
  /** local Anvil mining configuration observed before the first step */
  mining?: { automine: boolean; intervalMining: number | null };
  /** fork only: cold-state read latency of the Anvil fork backend measured before the first step */
  forkBackend?: { samplesMs: number[]; maxMs: number };
}

function argValue(v: string): unknown {
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) return getAddress(v);
  if (/^\d+$/.test(v)) return BigInt(v);
  if (v === "true" || v === "false") return v === "true";
  return v;
}

/** Executes a manifest on a LOCAL chain (fresh Anvil or local Anvil fork) by impersonating its role addresses. */
/** OpenZeppelin ECDSAInvalidSignatureLength(0): the authorizer rejects the empty creator signature of an unauthorized launch. */
const S09_EXPECTED_REVERT = concat(["0xfce698f7", toHex(0n, { size: 32 })]);
/** IHooks.beforeInitialize(address,PoolKey,uint160) */
const BEFORE_INITIALIZE = toFunctionSelector("function beforeInitialize(address,(address,address,uint24,int24,address),uint160)");

export async function executeDryRun(m: DeployManifest, rpcUrl: string, node: Pick<SendCtx, "proc" | "logs" | "timeoutMs"> = {}): Promise<DryRunReport> {
  assertLoopbackRpc(rpcUrl); // before ANY request: a real RPC can never be a dry-run target
  const integrity = verifyManifest(m);
  if (integrity.length) throw new Error(`refusing to dry-run an invalid manifest: ${integrity.join("; ")}`);
  const rpcChainId = Number(await rpcCall<Hex>(rpcUrl, "eth_chainId"));
  if (rpcChainId !== m.chainId) throw new Error(`RPC chain ${rpcChainId} ≠ manifest chain ${m.chainId}`);
  const localDev = rpcChainId === 31337 || rpcChainId === 1337;
  if (!localDev && !(await isLocalAnvilFork(rpcUrl))) throw new Error(`DRY_RUN only runs on a local dev chain or a LOCAL anvil fork (chain ${rpcChainId})`);
  const chain = defineChain({ id: rpcChainId, name: "dry-run", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const pub = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 100 });
  const wallets = new Map<RoleKey, ReturnType<typeof createWalletClient>>();
  for (const [k, a] of Object.entries(m.roles) as Array<[RoleKey, Address]>) {
    await rpcCall(rpcUrl, "anvil_impersonateAccount", [a]);
    await rpcCall(rpcUrl, "anvil_setBalance", [a, "0x56BC75E2D63100000"]);
    wallets.set(k, createWalletClient({ chain, transport: http(rpcUrl), account: a }));
  }
  await rpcCall(rpcUrl, "anvil_setNonce", [m.roles.deployer, toHex(m.deployerStartNonce)]);
  const mining = await assertLocalAutomine(rpcUrl);
  const forkBackend = localDev ? undefined : await probeForkLatency(rpcUrl);
  const startNonce = Number(BigInt(await rpcCall<Hex>(rpcUrl, "eth_getTransactionCount", [m.roles.deployer, "pending"])));
  if (startNonce !== m.deployerStartNonce) throw new Error(`deployer nonce is ${startNonce}, manifest predicts CREATE addresses from ${m.deployerStartNonce}`);

  const checks: DryRunReport["checks"] = [];
  const check = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });
  const abiOf = (c: ContractKey) => loadArtifact(CONTRACT_NAMES[c]).abi;
  const stepHistory: StepRecord[] = [];
  const sendCtx: SendCtx = { rpcUrl, expectedChainId: rpcChainId, ...node };
  const failed = (e: TxConfirmError): DryRunReport => {
    stepHistory.push(e.record);
    check(`STEP:${e.record.n}`, false, `${e.classification}: ${e.record.detail ?? e.message}`);
    return {
      manifestHash: m.contentHash, environment: m.environment, rpcChainId, executedSteps: stepHistory.filter((r) => r.outcome === "CONFIRMED").length,
      checks, ok: false, status: "FAILED", stepHistory, mining, forkBackend,
      failure: { step: e.record.n, classification: e.classification, message: e.message, snapshot: e.snapshot },
    };
  };
  let executed = 0;
  for (const s of m.steps) {
    const w = wallets.get(s.from)!;
    const from = m.roles[s.from];
    const info = { n: s.n, op: s.kind, contract: s.contract, fn: s.fn ?? null };
    try {
      let target: Address | null;
      let submit: () => Promise<Hex>;
      if (s.kind === "create") {
        const a = loadArtifact(CONTRACT_NAMES[s.contract]);
        target = null;
        submit = () => w.deployContract({ abi: a.abi, bytecode: a.bytecode, args: s.args.map((x) => argValue(x.value)), account: from, chain } as never);
      } else if (s.kind === "create2") {
        const init = hookInitCode(loadArtifact("PonsV2MemeHook").bytecode, m.hook.constructorArgs);
        if (keccak256(init) !== m.hook.initCodeHash) throw new Error("hook init code differs from the manifest (artifact drift)");
        target = m.network.create2Deployer;
        submit = () => w.sendTransaction({ to: m.network.create2Deployer, data: concat([m.hook.salt, init]), account: from, chain } as never);
      } else {
        const args = s.fn === "addLaunchConfig" ? [(() => { const c = JSON.parse(s.args[0]!.value) as Record<string, unknown>; return { ...c, supply: BigInt(c.supply as string), curveFeeBps: BigInt(c.curveFeeBps as string), phantomQuote: BigInt(c.phantomQuote as string), graduationThreshold: BigInt(c.graduationThreshold as string) }; })()] : s.args.map((x) => argValue(x.value));
        target = m.addresses[s.contract];
        submit = () => w.sendTransaction({ to: target!, data: encodeFunctionData({ abi: abiOf(s.contract), functionName: s.fn!, args } as never), account: from, chain } as never);
      }
      const { record, receipt: r } = await sendAndConfirm(sendCtx, info, { from, to: target }, submit);
      stepHistory.push(record);
      if (s.kind === "create" && getAddress(r.contractAddress!) !== s.predicted) throw new Error(`step ${s.n}: deployed at ${r.contractAddress}, manifest predicted ${s.predicted}`);
    } catch (e) {
      if (e instanceof TxConfirmError) return failed(e);
      throw e;
    }
    executed++;
  }
  for (const a of Object.values(m.roles)) await rpcCall(rpcUrl, "anvil_stopImpersonatingAccount", [a]);

  // S01 code + runtime identity
  for (const c of Object.keys(CONTRACT_NAMES) as ContractKey[]) {
    const raw = readRawArtifact(forgeArtifactPath(CONTRACT_NAMES[c]));
    const code = (await pub.getCode({ address: m.addresses[c] })) ?? "0x";
    const cmp = compareRuntime(raw.deployedBytecode.object, code, Object.values(raw.deployedBytecode.immutableReferences ?? {}).flat());
    check(`S01:${c}`, code !== "0x" && cmp.equalAfterMasking, `${CONTRACT_NAMES[c]} @ ${m.addresses[c]}: ${cmp.remoteBytes} B, equalAfterMasking=${cmp.equalAfterMasking}`);
  }
  const read = (c: ContractKey, fn: string, args: unknown[] = []) => pub.readContract({ address: m.addresses[c], abi: abiOf(c), functionName: fn, args } as never) as Promise<unknown>;
  const norm = (v: unknown) => (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? getAddress(v) : String(v));
  // S02 hook mask
  check("S02", hookMaskOk(m.addresses.memeHook) && norm(await read("memeHook", "poolManager")) === m.network.poolManager, `hook ${m.addresses.memeHook} mask ok + poolManager`);
  // S03..S07 expected roles + treasury config
  for (const e of [...m.expectedRoles, ...m.treasuryChecks]) {
    const got = norm(await read(e.contract, e.getter, "args" in e && e.args ? e.args.map(argValue) : []));
    const id = m.treasuryChecks.includes(e as never) ? "S07" : e.getter === "owner" || e.getter === "pendingOwner" ? "S06" : "S04/S05";
    check(`${id}:${e.contract}.${e.getter}`, got === norm(e.expected), `got ${got}, expected ${norm(e.expected)}`);
  }
  check("S03", norm(await read("memeHook", "protocolFeeRecipient")) === m.addresses.revenueSplitter, "fee recipient = splitter");
  const deployerHoldsRole = (await Promise.all(Object.keys(CONTRACT_NAMES).map(async (c) => {
    try {
      return norm(await read(c as ContractKey, "owner")) === m.roles.deployer;
    } catch {
      return false;
    }
  }))).some(Boolean) || norm(await read("memeHook", "feeSweepOperator")) === m.roles.deployer;
  check("S06:deployer-has-no-role", !deployerHoldsRole, "deployer owns nothing and is not the fee-sweep operator");
  // S08 economics preview + config
  try {
    await read("factory", "previewLaunchEconomics", [0n, NATIVE]);
    const n = (await read("factory", "launchConfigCount")) as bigint;
    check("S08", n === 1n && (await read("factory", "launchEnabled")) === true, `launchConfigCount=${n}`);
  } catch (e) {
    check("S08", false, (e as Error).message.slice(0, 200));
  }
  // S09 unauthorized launch reverts (eth_call only)
  const stranger = "0x000000000000000000000000000000000000dEaD" as Address;
  const params = {
    name: "X", symbol: "X", logo: "", description: "",
    socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" },
    creatorFeeRecipient: NATIVE, creatorTaxBps: 0, buybackEnabled: false,
    expectedEconomics: `0x${"00".repeat(32)}`, salt: `0x${"11".repeat(32)}`, githubRepoId: 999_999_999n,
    authorizationExpiresAt: 2n ** 40n, authorizationNonce: 0n, creatorSignature: "0x", attestationPayload: "0x",
  };
  const data = encodeFunctionData({ abi: abiOf("factory") as Abi, functionName: "launchToken", args: [params, 0n, NATIVE] } as never);
  const s09Call = { from: stranger, to: m.addresses.factory, data };
  // The factory forwards the authorizer's ECDSA length check on the empty creator signature: exact data, from the factory call.
  const s09 = acceptS09(s09Call, { from: stranger, to: m.addresses.factory, data }, await rawEthCall(rpcUrl, s09Call), S09_EXPECTED_REVERT);
  check("S09", s09.ok, s09.detail);
  // S10 hook refuses initialize from a non-factory sender (genuine PoolManager.initialize, eth_call)
  const initAbi = [{ type: "function", name: "initialize", stateMutability: "nonpayable", inputs: [{ name: "key", type: "tuple", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] }, { name: "sqrtPriceX96", type: "uint160" }], outputs: [{ type: "int24" }] }] as const;
  const initData = encodeFunctionData({ abi: initAbi, functionName: "initialize", args: [{ currency0: NATIVE, currency1: "0x0000000000000000000000000000000000000001", fee: 0, tickSpacing: 10, hooks: m.addresses.memeHook }, 2n ** 96n] });
  const s10Call = { from: stranger, to: m.network.poolManager, data: initData };
  const s10 = acceptS10(s10Call, { from: stranger, to: m.network.poolManager, data: initData }, await rawEthCall(rpcUrl, s10Call), {
    poolManager: m.network.poolManager,
    hook: m.addresses.memeHook,
    hookCallbackSelector: BEFORE_INITIALIZE,
    hookErrorSelector: toFunctionSelector("function NotFactory()"),
  });
  check("S10", s10.ok, `PoolManager.initialize with the Forge hook from a stranger: ${s10.detail}`);
  const allOk = checks.every((c) => c.ok);
  return { manifestHash: m.contentHash, environment: m.environment, rpcChainId, executedSteps: executed, checks, ok: allOk, status: allOk ? "COMPLETE" : "FAILED", stepHistory, mining, forkBackend };
}

let dryRunLogTail = (): string => "";

/** local-genuine / fork-4663 DRY_RUN: start the chain, build the manifest against it, execute, check. */
export async function dryRun(env: "local-genuine" | "fork-4663", given?: DeployManifest): Promise<{ manifest: DeployManifest; report: DryRunReport; chain: GenuineChain }> {
  const chain = await startGenuineChain(env === "local-genuine" ? "local-genuine" : "fork");
  try {
    const m =
      given ??
      buildDeployManifest(planInputFor(env, { poolManager: chain.v4.poolManager, positionManager: chain.v4.positionManager, permit2: chain.v4.permit2 }), forgeBuildProvider());
    const report = await executeDryRun(m, chain.anvil.url, { proc: chain.anvil.proc, logs: chain.anvil.logs });
    return { manifest: m, report, chain };
  } catch (e) {
    dryRunLogTail = (() => { const t = chain.anvil.logs().slice(-4000); return () => t; })();
    await chain.stop();
    throw e;
  }
}

function arg(argv: string[], k: string): string | undefined {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function out(file: string | undefined, v: unknown) {
  const json = JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);
  if (file) {
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    writeFileSync(file, json + "\n");
    console.error(`wrote ${file}`);
  }
  console.log(json);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = process.env.DEPLOY_MODE === "WRITE" ? "write" : (argv[0] ?? "dry-run");
  if (cmd === "plan") {
    const env = (arg(argv, "env") ?? "robinhood-4663") as Environment;
    if (env === "local-genuine") throw new Error("a local-genuine manifest needs a live chain: use `dry-run --env local-genuine`");
    out(arg(argv, "out"), buildDeployManifest(planInputFor(env), forgeBuildProvider()));
    return;
  }
  if (cmd === "verify") {
    const file = arg(argv, "manifest");
    if (!file) throw new Error("--manifest required");
    const m = JSON.parse(readFileSync(file, "utf8")) as DeployManifest;
    const failures = verifyManifest(m, forgeBuildProvider());
    out(undefined, { manifest: file, contentHash: m.contentHash, ok: failures.length === 0, failures });
    if (failures.length) process.exit(1);
    return;
  }
  if (cmd === "write") {
    const file = arg(argv, "manifest");
    const m = file ? (JSON.parse(readFileSync(file, "utf8")) as DeployManifest) : buildDeployManifest(planInputFor("robinhood-4663"), forgeBuildProvider());
    let rpcChainId = m.chainId;
    const rpc = arg(argv, "rpc");
    if (rpc) {
      const p = createPublicClient({ transport: http(rpc) });
      rpcChainId = await p.getChainId(); // read-only
    }
    const reasons = writeRefusals({ manifest: m, rpcChainId, confirmation: arg(argv, "confirm") ?? null });
    console.error(`WRITE REFUSED:\n  - ${reasons.join("\n  - ")}`);
    process.exit(3);
  }
  if (cmd === "dry-run") {
    const env = (arg(argv, "env") ?? "local-genuine") as "local-genuine" | "fork-4663";
    const given = arg(argv, "manifest") ? (JSON.parse(readFileSync(arg(argv, "manifest")!, "utf8")) as DeployManifest) : undefined;
    let started: Awaited<ReturnType<typeof dryRun>>;
    try {
      started = await dryRun(env, given);
    } catch (e) {
      // Preserve a FAILED artifact (same --out convention) so CI uploads evidence even when the harness itself throws.
      out(arg(argv, "out"), { status: "FAILED", environment: env, error: e instanceof Error ? e.message : String(e), anvilLogTail: dryRunLogTail() });
      throw e;
    }
    const { manifest, report, chain } = started;
    dryRunLogTail = () => chain.anvil.logs().slice(-4000);
    await chain.stop();
    out(arg(argv, "out"), { manifest, report });
    if (!report.ok) {
      console.error(`DRY_RUN FAILED: ${report.failure ? report.failure.message : report.checks.filter((c) => !c.ok).map((c) => c.id).join(", ")}`);
      process.exit(1);
    }
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  });
}

