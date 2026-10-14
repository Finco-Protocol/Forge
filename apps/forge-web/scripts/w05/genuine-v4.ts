/**
 * W05 genuine Uniswap V4 stack harness.
 *
 * Modes
 *   local-genuine  fresh Anvil (chain 31337) + the GENUINE Uniswap artifacts
 *                  (PoolManager, PositionManager, PositionDescriptor, WETH9,
 *                  StateView; Permit2 runtime at its canonical address), then
 *                  the Forge stack wired to THOSE (no mini mocks anywhere).
 *   fork           Anvil `--fork-url $FORGE_FORK_RPC_URL` (CI only: the
 *                  Robinhood RPC is unreachable from the dev container). Uses
 *                  the real 4663 addresses from config/networks/robinhood-4663.json.
 *                  Every transaction goes to the LOCAL fork; the real RPC is
 *                  only ever read (by Anvil's lazy state fetch).
 *
 * CLI:  pnpm w05:genuine-v4 [--mode local-genuine|fork] [--out file] [--keep]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, pad, parseAbi, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import manifest from "../../config/networks/robinhood-4663.json";
import { ANVIL_KEYS, deploySandbox, isLocalAnvilFork, type SandboxDeployment } from "../sandbox-lib";
import { spawnAnvil, rpcCall, type AnvilProc } from "./anvil-proc";
import {
  GENUINE,
  PERMIT2_CANONICAL,
  compareRuntime,
  immutableRanges,
  permit2ImmutableLayout,
  permit2RuntimeFromDeployPermit2,
  rebindPermit2Immutables,
  type CodeComparison,
  type GenuineArtifact,
} from "./uniswap-artifacts";

export type GenuineMode = "local-genuine" | "fork";
export const ROBINHOOD_CHAIN_ID = 4663;
/** Uniswap's own deployments use 300k for PositionManager's unsubscribe gas limit. Local only; fork reads the real one. */
export const LOCAL_UNSUBSCRIBE_GAS_LIMIT = 300_000n;

export interface GenuineV4 {
  mode: GenuineMode;
  chainId: number;
  poolManager: Address;
  positionManager: Address;
  permit2: Address;
  weth9: Address | null;
  positionDescriptor: Address | null;
  stateView: Address | null;
  provenance: Array<{ contract: string; artifact: string; package: string; compiler: string; optimizerRuns: number | null; viaIR: boolean; evmVersion: string; address: Address; runtimeCheck: CodeComparison }>;
}

const chainFor = (id: number, url: string) => defineChain({ id, name: `local-${id}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } });

export function clientsFor(url: string, chainId: number, key: Hex = ANVIL_KEYS[0]) {
  const chain = chainFor(chainId, url);
  const account = privateKeyToAccount(key);
  return {
    account,
    pub: createPublicClient({ chain, transport: http(url), pollingInterval: 100 }),
    wallet: createWalletClient({ chain, transport: http(url), account, pollingInterval: 100 }),
  };
}

async function getCode(url: string, a: Address): Promise<Hex> {
  return rpcCall<Hex>(url, "eth_getCode", [a, "latest"]);
}

/** Genuine artifact runtime vs code at `address`, immutables masked. */
export async function checkRuntime(url: string, a: GenuineArtifact, address: Address): Promise<CodeComparison> {
  return compareRuntime(a.deployedBytecode, await getCode(url, address), immutableRanges(a));
}

export async function checkPermit2Runtime(url: string, address: Address = PERMIT2_CANONICAL): Promise<CodeComparison & { remoteCachedChainId: number | null }> {
  const genuine = permit2RuntimeFromDeployPermit2().runtime;
  const layout = permit2ImmutableLayout(genuine);
  const remote = await getCode(url, address);
  const cmp = compareRuntime(genuine, remote, layout.ranges);
  let remoteCachedChainId: number | null = null;
  try {
    remoteCachedChainId = permit2ImmutableLayout(remote).cachedChainId;
  } catch {
    /* not Permit2-shaped */
  }
  return { ...cmp, remoteCachedChainId };
}

/** Deploys the genuine V4 stack on a LOCAL dev chain (31337/1337 only). */
export async function deployGenuineV4Local(url: string, key: Hex = ANVIL_KEYS[0]): Promise<GenuineV4> {
  const chainId = Number(await rpcCall<Hex>(url, "eth_chainId"));
  if (chainId !== 31337 && chainId !== 1337) throw new Error(`deployGenuineV4Local refuses chain ${chainId} (local dev chains only)`);
  const { pub, wallet, account } = clientsFor(url, chainId, key);
  const deploy = async (a: GenuineArtifact, args: unknown[] = []): Promise<Address> => {
    const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy ${a.name} failed`);
    return r.contractAddress;
  };
  const A = {
    poolManager: GENUINE.poolManager(),
    positionManager: GENUINE.positionManager(),
    positionDescriptor: GENUINE.positionDescriptor(),
    weth: GENUINE.weth(),
    stateView: GENUINE.stateView(),
  };
  const weth9 = await deploy(A.weth);
  const poolManager = await deploy(A.poolManager, [account.address]);
  // Permit2: the genuine runtime (as Uniswap's DeployPermit2 etches it) at the
  // canonical address, with its two constructor-time immutables re-bound to
  // this chain + address (exactly what its constructor would compute here).
  const p2 = permit2RuntimeFromDeployPermit2();
  await rpcCall(url, "anvil_setCode", [PERMIT2_CANONICAL, rebindPermit2Immutables(p2.runtime, chainId, PERMIT2_CANONICAL)]);
  const positionDescriptor = await deploy(A.positionDescriptor, [poolManager, weth9, pad(toHex("ETH"), { dir: "right", size: 32 })]);
  const positionManager = await deploy(A.positionManager, [poolManager, PERMIT2_CANONICAL, LOCAL_UNSUBSCRIBE_GAS_LIMIT, positionDescriptor, weth9]);
  const stateView = await deploy(A.stateView, [poolManager]);

  const wiring = parseAbi(["function poolManager() view returns (address)", "function permit2() view returns (address)", "function WETH9() view returns (address)"]);
  if (getAddress(await pub.readContract({ address: positionManager, abi: wiring, functionName: "poolManager" })) !== getAddress(poolManager)) throw new Error("PositionManager.poolManager mismatch");
  if (getAddress(await pub.readContract({ address: positionManager, abi: wiring, functionName: "permit2" })) !== getAddress(PERMIT2_CANONICAL)) throw new Error("PositionManager.permit2 mismatch");

  const provenance: GenuineV4["provenance"] = [];
  const rec = async (contract: string, a: GenuineArtifact, address: Address) => {
    const runtimeCheck = await checkRuntime(url, a, address);
    if (!runtimeCheck.equalAfterMasking) throw new Error(`${contract} deployed runtime differs from the genuine artifact at byte ${runtimeCheck.firstDiffOffset}`);
    provenance.push({ contract, artifact: a.file, package: a.package, compiler: a.compiler, optimizerRuns: a.optimizerRuns, viaIR: a.viaIR, evmVersion: a.evmVersion, address, runtimeCheck });
  };
  await rec("PoolManager", A.poolManager, poolManager);
  await rec("PositionManager", A.positionManager, positionManager);
  await rec("PositionDescriptor", A.positionDescriptor, positionDescriptor);
  await rec("WETH9", A.weth, weth9);
  await rec("StateView", A.stateView, stateView);
  const dp2 = GENUINE.deployPermit2();
  const permit2Check = await checkPermit2Runtime(url);
  if (!permit2Check.equalAfterMasking) throw new Error("Permit2 runtime mismatch");
  provenance.push({ contract: "Permit2", artifact: `${dp2.file} (embedded runtime @${p2.offset}+${p2.length})`, package: dp2.package, compiler: "permit2 runtime as captured by Uniswap (DeployPermit2 literal)", optimizerRuns: null, viaIR: false, evmVersion: "n/a", address: PERMIT2_CANONICAL, runtimeCheck: permit2Check });

  return { mode: "local-genuine", chainId, poolManager, positionManager, permit2: PERMIT2_CANONICAL, weth9, positionDescriptor, stateView, provenance };
}

/** The real 4663 V4 addresses, verified on the LOCAL fork (code present + genuine runtime). */
export async function genuineV4OnFork(url: string): Promise<GenuineV4> {
  const chainId = Number(await rpcCall<Hex>(url, "eth_chainId"));
  if (chainId !== ROBINHOOD_CHAIN_ID) throw new Error(`fork chain id is ${chainId}, expected ${ROBINHOOD_CHAIN_ID}`);
  if (!(await isLocalAnvilFork(url))) throw new Error("fork mode requires a LOCAL anvil fork (anvil_nodeInfo.forkConfig.forkUrl), never the real RPC");
  const u = manifest.uniswapV4;
  const poolManager = getAddress(u.poolManager.address);
  const positionManager = getAddress(u.positionManager.address);
  const permit2 = getAddress(u.permit2.address);
  const provenance: GenuineV4["provenance"] = [];
  for (const [contract, a, address] of [
    ["PoolManager", GENUINE.poolManager(), poolManager],
    ["PositionManager", GENUINE.positionManager(), positionManager],
  ] as const) {
    provenance.push({ contract, artifact: a.file, package: a.package, compiler: a.compiler, optimizerRuns: a.optimizerRuns, viaIR: a.viaIR, evmVersion: a.evmVersion, address, runtimeCheck: await checkRuntime(url, a, address) });
  }
  const dp2 = GENUINE.deployPermit2();
  provenance.push({ contract: "Permit2", artifact: dp2.file, package: dp2.package, compiler: "permit2 runtime literal", optimizerRuns: null, viaIR: false, evmVersion: "n/a", address: permit2, runtimeCheck: await checkPermit2Runtime(url, permit2) });
  return { mode: "fork", chainId, poolManager, positionManager, permit2, weth9: null, positionDescriptor: null, stateView: null, provenance };
}

export interface GenuineChain {
  mode: GenuineMode;
  anvil: AnvilProc;
  v4: GenuineV4;
  stop(): Promise<void>;
}

/** Fork mode refuses (throws) without FORGE_FORK_RPC_URL — never a silent skip. */
export function requireForkRpc(env: Record<string, string | undefined> = process.env): string {
  const u = env.FORGE_FORK_RPC_URL;
  if (!u) throw new Error("FORGE_FORK_RPC_URL is required for fork mode (CI only; the Robinhood RPC is unreachable from the dev container). Refusing to run.");
  return u;
}

export async function startGenuineChain(mode: GenuineMode): Promise<GenuineChain> {
  if (mode === "local-genuine") {
    const anvil = await spawnAnvil(["--chain-id", "31337"]);
    try {
      const v4 = await deployGenuineV4Local(anvil.url);
      return { mode, anvil, v4, stop: () => anvil.stop() };
    } catch (e) {
      await anvil.stop();
      throw e;
    }
  }
  const forkUrl = requireForkRpc();
  const extra = ["--fork-url", forkUrl];
  if (process.env.FORGE_FORK_BLOCK_NUMBER) extra.push("--fork-block-number", process.env.FORGE_FORK_BLOCK_NUMBER);
  const anvil = await spawnAnvil(extra, { timeoutMs: 120_000 });
  try {
    const v4 = await genuineV4OnFork(anvil.url);
    return { mode, anvil, v4, stop: () => anvil.stop() };
  } catch (e) {
    await anvil.stop();
    throw e;
  }
}

/** The Forge stack wired to the genuine V4 legs; hook CREATE2'd via the 0x4e59 proxy. */
export async function deployForgeOnGenuine(chain: GenuineChain): Promise<SandboxDeployment> {
  return deploySandbox(chain.anvil.url, {
    v4: { poolManager: chain.v4.poolManager, positionManager: chain.v4.positionManager, permit2: chain.v4.permit2 },
    hookVia: "create2-proxy",
    allowLocalForkOf: [ROBINHOOD_CHAIN_ID],
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const mode = (argv[argv.indexOf("--mode") + 1] ?? "local-genuine") as GenuineMode;
  if (argv.includes("--mode") && !["local-genuine", "fork"].includes(mode)) throw new Error(`unknown mode ${mode}`);
  const chain = await startGenuineChain(argv.includes("--mode") ? mode : "local-genuine");
  try {
    const forge = await deployForgeOnGenuine(chain);
    const out = { mode: chain.mode, rpcUrl: chain.anvil.url, v4: chain.v4, forge };
    const json = JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
    const file = argv.includes("--out") ? argv[argv.indexOf("--out") + 1]! : path.resolve(".sandbox", `w05-${chain.mode}-deployment.json`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, json + "\n");
    console.log(json);
    console.error(`wrote ${file}`);
    if (argv.includes("--keep")) {
      console.error(`anvil kept running at ${chain.anvil.url} (Ctrl-C to stop)`);
      return;
    }
  } finally {
    if (!argv.includes("--keep")) await chain.stop();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
