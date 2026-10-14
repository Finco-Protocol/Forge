/**
 * Deploys the REAL W02 Forge-owned stack (factory, registry, authorizer,
 * deployer, executor, hook, vault, locker — compiled by
 * `forge build --profile forge`) to a LOCAL chain. Only the Uniswap V4
 * core/periphery legs are the W02 mini mocks, exactly as in W02's own
 * lifecycle suite. Refuses any chain other than a local dev chain.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getContractAddress,
  http,
  keccak256,
  concat,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadArtifact, loadDeployedSize } from "./artifacts";
import { CREATE2_PROXY, hookInitCode, mineHookSalt } from "./w05/hook-mine-lib";

/** Anvil's default dev mnemonic keys (public, test-only). */
export const ANVIL_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
] as const satisfies readonly Hex[];

export const SANDBOX_ROLES = {
  governance: ANVIL_KEYS[0],
  authority: ANVIL_KEYS[1], // test-only eligibility authority
  relayer: ANVIL_KEYS[2],
  evidence: ANVIL_KEYS[3],
  treasury: ANVIL_KEYS[8], // W04 sandbox treasury recipient (test-only key)
  revenueAttestor: ANVIL_KEYS[4], // W04 Correction A: eligible-revenue attestor (test-only key)
};

export interface SandboxDeployment {
  chainId: number;
  rpcUrl: string;
  deployBlock: string;
  governance: Address;
  authority: Address;
  factory: Address;
  registry: Address;
  authorizer: Address;
  launchDeployer: Address;
  graduationExecutor: Address;
  locker: Address;
  memeHook: Address;
  buybackVault: Address;
  feeEscrow: Address;
  revenueSplitter: Address;
  treasury: Address;
  revenueAttestor: Address;
  poolManager: Address;
  positionManager: Address;
  permit2: Address;
  /** W05: which Uniswap V4 legs the stack is wired to (default: the W02 mini mocks). */
  v4Source?: "W02_MINI_MOCKS" | "GENUINE_UNISWAP_V4";
  /** W05: CREATE2 evidence of the hook (deployer contract, salt, init-code hash). */
  hookCreate2?: { deployer: Address; salt: Hex; initCodeHash: Hex };
  eip170: Array<{ contract: string; runtimeBytes: number; exceeds: boolean }>;
  launchConfig: { supply: string; curveFeeBps: string; phantomQuote: string; graduationThreshold: string; poolFee: number; tickSpacing: number };
}

/** EIP-170 runtime code size limit. */
export const EIP170_LIMIT = 24_576;

/**
 * EIP-170 runtime size report for the Forge-owned stack. W02-SIZE-01 (the
 * factory at 25,963 B) is resolved by W03 Correction A; `pnpm size:check`
 * fails CI on any regression above the limit.
 */
export function eip170Report() {
  const out: Array<{ contract: string; runtimeBytes: number; exceeds: boolean }> = [];
  for (const n of [
    "PonsV2LaunchFactory",
    "PonsV2LaunchDeployer",
    "ForgeBindingRegistry",
    "ForgeLaunchAuthorizer",
    "PonsV2MemeHook",
    "PonsV2GraduationExecutor",
    "PonsV2FeeEscrow",
    "PonsV2BuybackVault",
    "ForgeProtocolRevenueSplitter",
  ]) {
    const bytes = loadDeployedSize(n);
    out.push({ contract: n, runtimeBytes: bytes, exceeds: bytes > EIP170_LIMIT });
  }
  return out;
}

export interface DeploySandboxOptions {
  snipeTaxStartBps?: bigint;
  /**
   * W05: wire the Forge stack to EXTERNAL (genuine) Uniswap V4 contracts
   * instead of deploying the W02 mini mocks. Omitted = unchanged mock path.
   */
  v4?: { poolManager: Address; positionManager: Address; permit2: Address };
  /** W05: CREATE2 the hook through the deterministic-deployment proxy (0x4e59…) instead of the test HookDeployer. */
  hookVia?: "HookDeployer" | "create2-proxy";
  /**
   * W05 fork mode: chain ids (e.g. 4663) that are accepted ONLY when the RPC
   * is a loopback Anvil whose anvil_nodeInfo reports a fork. The real
   * Robinhood RPC can never pass this check.
   */
  allowLocalForkOf?: number[];
}

/** True only for an Anvil on a loopback address that reports it is a fork. */
export async function isLocalAnvilFork(rpcUrl: string): Promise<boolean> {
  const host = new URL(rpcUrl).hostname;
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) return false;
  try {
    const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_nodeInfo", params: [] }) });
    const j = (await r.json()) as { result?: { forkConfig?: { forkUrl?: string | null } } };
    return typeof j.result?.forkConfig?.forkUrl === "string" && j.result.forkConfig.forkUrl.length > 0;
  } catch {
    return false;
  }
}

export async function deploySandbox(rpcUrl: string, opts: DeploySandboxOptions = {}): Promise<SandboxDeployment> {
  const probe = createPublicClient({ transport: http(rpcUrl), pollingInterval: 100 });
  const chainId = await probe.getChainId();
  const localDev = chainId === 31337 || chainId === 1337;
  const localFork = !localDev && (opts.allowLocalForkOf ?? []).includes(chainId) && (await isLocalAnvilFork(rpcUrl));
  if (!localDev && !localFork) throw new Error(`Refusing to deploy the sandbox to chain ${chainId} (local dev chains only).`);
  const chain = defineChain({ id: chainId, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const pub = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 100 });
  const gov = createWalletClient({ chain, transport: http(rpcUrl), account: privateKeyToAccount(SANDBOX_ROLES.governance) });
  const authority = privateKeyToAccount(SANDBOX_ROLES.authority).address;
  const startBlock = await pub.getBlockNumber();

  const deploy = async (file: string, args: unknown[] = [], name?: string): Promise<Address> => {
    const a = loadArtifact(file, name);
    const hash = await gov.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (!r.contractAddress || r.status !== "success") throw new Error(`deploy ${name ?? file} failed`);
    return r.contractAddress;
  };
  const send = async (address: Address, file: string, functionName: string, args: unknown[] = [], name?: string) => {
    const a = loadArtifact(file, name);
    const hash = await gov.writeContract({ address, abi: a.abi, functionName, args });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} failed`);
  };

  let poolManager: Address, permit2: Address, positionManager: Address;
  if (opts.v4) {
    for (const [k, a] of Object.entries(opts.v4)) {
      const code = await pub.getCode({ address: a });
      if (!code || code === "0x") throw new Error(`external V4 ${k} ${a} has no code`);
    }
    ({ poolManager, permit2, positionManager } = opts.v4);
  } else {
    poolManager = await deploy("MiniPoolManagerW02");
    permit2 = await deploy("MockPermit2");
    positionManager = await deploy("MiniPositionManager", [poolManager, permit2]);
  }
  // W04: the CANONICAL PonsV2FeeEscrow (byte-identical to the deploy-time
  // source), not the W02 mock, so escrow events and claim semantics are real.
  const feeEscrow = await deploy("PonsV2FeeEscrow");
  const treasury = privateKeyToAccount(SANDBOX_ROLES.treasury).address;
  // W04 sandbox: the Forge-owned protocol recipient (protocol leg → 2/3
  // treasury, 1/3 FINCO reserve). Named in the hook's policy BEFORE any
  // launch, so every launch snapshot routes its protocol leg here.
  // Correction A: pulls are bounded by attested eligible-revenue ceilings
  // signed by a separate attestor key (not the owner, not the treasury).
  const revenueAttestor = privateKeyToAccount(SANDBOX_ROLES.revenueAttestor).address;
  const revenueSplitter = await deploy("ForgeProtocolRevenueSplitter", [feeEscrow, gov.account.address, treasury, revenueAttestor]);
  const hook = loadArtifact("PonsV2MemeHook");
  const initCode = hookInitCode(hook.bytecode, { poolManager, feeEscrow, protocolFeeRecipient: revenueSplitter, owner: gov.account.address });
  const initHash = keccak256(initCode);
  let hookDeployer: Address;
  if (opts.hookVia === "create2-proxy") {
    hookDeployer = CREATE2_PROXY;
    const code = await pub.getCode({ address: hookDeployer });
    if (!code || code === "0x") throw new Error(`deterministic-deployment proxy ${CREATE2_PROXY} is absent on chain ${chainId}`);
  } else {
    hookDeployer = await deploy("HookDeployer");
  }
  // Deterministic: salts are searched from 0 upward (scripts/w05/hook-mine-lib.ts).
  const { salt: hookSalt, address: memeHook } = mineHookSalt(hookDeployer, initHash);
  if (memeHook !== getContractAddress({ opcode: "CREATE2", from: hookDeployer, salt: hookSalt, bytecodeHash: initHash })) throw new Error("hook CREATE2 address mismatch");
  if (opts.hookVia === "create2-proxy") {
    const hash = await gov.sendTransaction({ to: hookDeployer, data: concat([hookSalt, initCode]) });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error("hook CREATE2 via the deterministic-deployment proxy failed");
    const code = await pub.getCode({ address: memeHook });
    if (!code || code === "0x") throw new Error("hook not deployed at the mined address");
  } else {
    await send(hookDeployer, "HookDeployer", "deploy", [initCode, hookSalt]);
  }

  const buybackVault = await deploy("PonsV2BuybackVault", [gov.account.address, memeHook, feeEscrow]);
  const locker = await deploy("PonsV2LaunchLocker", [gov.account.address, positionManager]);
  const registry = await deploy("ForgeBindingRegistry", [authority]);
  const authorizer = await deploy("ForgeLaunchAuthorizer", [registry, authority]);
  const factory = await deploy("PonsV2LaunchFactory", [gov.account.address, poolManager, positionManager, permit2, locker, memeHook, feeEscrow, buybackVault, authorizer, 0n]);
  const launchDeployer = await deploy("PonsV2LaunchDeployer", [factory]);
  const graduationExecutor = await deploy("PonsV2GraduationExecutor", [positionManager, permit2, locker, factory]);

  await send(authorizer, "ForgeLaunchAuthorizer", "setForgeFactory", [factory]);
  await send(memeHook, "PonsV2MemeHook", "setFactory", [factory]);
  await send(memeHook, "PonsV2MemeHook", "setBuybackVault", [buybackVault]);
  await send(buybackVault, "PonsV2BuybackVault", "setFactory", [factory]);
  await send(locker, "PonsV2LaunchLocker", "setFactory", [factory]);
  await send(factory, "PonsV2LaunchFactory", "setLaunchDeployer", [launchDeployer]);
  await send(factory, "PonsV2LaunchFactory", "setGraduationExecutor", [graduationExecutor]);
  await send(factory, "PonsV2LaunchFactory", "setLaunchFee", [0n]);
  await send(revenueSplitter, "ForgeProtocolRevenueSplitter", "setForgeFactory", [factory]);
  if (opts.snipeTaxStartBps !== undefined) await send(factory, "PonsV2LaunchFactory", "setSnipeTaxStartBps", [opts.snipeTaxStartBps]);
  // Same launch configuration as W02's ForgeLifecycleTest: 1M supply, 1% curve fee, 30 ETH threshold.
  const launchConfig = { supply: 1_000_000n * 10n ** 18n, curveFeeBps: 100n, phantomQuote: 30n * 10n ** 18n, graduationThreshold: 30n * 10n ** 18n, poolFee: 0, tickSpacing: 10 };
  await send(factory, "PonsV2LaunchFactory", "addLaunchConfig", [{ ...launchConfig, enabled: true }]);
  await send(factory, "PonsV2LaunchFactory", "setLaunchEnabled", [true]);

  return {
    chainId,
    rpcUrl,
    deployBlock: (startBlock + 1n).toString(),
    governance: gov.account.address,
    authority,
    factory,
    registry,
    authorizer,
    launchDeployer,
    graduationExecutor,
    locker,
    memeHook,
    buybackVault,
    feeEscrow,
    revenueSplitter,
    treasury,
    revenueAttestor,
    poolManager,
    positionManager,
    permit2,
    v4Source: opts.v4 ? "GENUINE_UNISWAP_V4" : "W02_MINI_MOCKS",
    hookCreate2: { deployer: hookDeployer, salt: hookSalt, initCodeHash: initHash },
    eip170: eip170Report(),
    launchConfig: {
      supply: launchConfig.supply.toString(),
      curveFeeBps: launchConfig.curveFeeBps.toString(),
      phantomQuote: launchConfig.phantomQuote.toString(),
      graduationThreshold: launchConfig.graduationThreshold.toString(),
      poolFee: 0,
      tickSpacing: 10,
    },
  };
}

export function writeDeployment(d: SandboxDeployment, file: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
}
