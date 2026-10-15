/**
 * W05 fork mode (CI only): proves the local genuine stack runs the SAME code
 * as Robinhood Chain 4663 — genuine artifact runtime vs the code deployed on
 * 4663 (read through a LOCAL Anvil fork), with immutables masked and the
 * masked values themselves checked where their meaning is known. Also reads
 * (read-only) the deterministic-deployment proxy on 4663.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, getAddress, http, pad, type Address, type Hex } from "viem";
import manifest from "../../config/networks/robinhood-4663.json";
import { requireForkRpc, startGenuineChain, checkPermit2Runtime, checkRuntime, type GenuineChain } from "../../scripts/w05/genuine-v4";
import { rpcCall } from "../../scripts/w05/anvil-proc";
import { GENUINE, permit2DomainSeparator, PERMIT2_CANONICAL } from "../../scripts/w05/uniswap-artifacts";
import { CREATE2_PROXY } from "../../scripts/w05/hook-mine-lib";

/** Arachnid deterministic-deployment proxy runtime (the code Anvil also ships locally). */
const CREATE2_PROXY_RUNTIME = "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

let chain: GenuineChain;
const forkUrl = requireForkRpc(); // throws at collection time without FORGE_FORK_RPC_URL: never a silent skip

beforeAll(async () => {
  chain = await startGenuineChain("fork");
});
afterAll(async () => chain?.stop());

describe("Robinhood 4663 genuine-V4 runtime identity (local fork)", () => {
  it("the local fork reports chain id 4663 and is a LOCAL anvil fork (transactions never reach the real RPC)", async () => {
    expect(Number(await rpcCall<Hex>(chain.anvil.url, "eth_chainId"))).toBe(4663);
    expect(new URL(chain.anvil.url).hostname).toBe("127.0.0.1");
    expect(chain.anvil.url).not.toBe(forkUrl);
  });

  it("PoolManager on 4663 == @uniswap/v4-core@1.0.2 PoolManager runtime (1 immutable masked = its own address)", async () => {
    const a = GENUINE.poolManager();
    const pm = getAddress(manifest.uniswapV4.poolManager.address);
    const cmp = await checkRuntime(chain.anvil.url, a, pm);
    console.log(`W05_RUNTIME PoolManager ${JSON.stringify(cmp)}`);
    expect(cmp.remoteBytes).toBe(manifest.uniswapV4.poolManager.codeSize);
    expect(cmp.equalAfterMasking).toBe(true);
    for (const r of cmp.maskedRanges) expect(getAddress(`0x${r.remote.slice(-40)}`)).toBe(pm); // NoDelegateCall.original
  });

  it("PositionManager on 4663 == @uniswap/v4-periphery@1.0.3 PositionManager runtime (immutables masked, values reported)", async () => {
    const cmp = await checkRuntime(chain.anvil.url, GENUINE.positionManager(), getAddress(manifest.uniswapV4.positionManager.address));
    console.log(`W05_RUNTIME PositionManager ${JSON.stringify(cmp)}`);
    expect(cmp.remoteBytes).toBe(manifest.uniswapV4.positionManager.codeSize);
    expect(cmp.equalAfterMasking).toBe(true);
    const vals = new Set(cmp.maskedRanges.map((r) => r.remote.toLowerCase()));
    expect(vals.has(pad(manifest.uniswapV4.poolManager.address.toLowerCase() as Address, { size: 32 }))).toBe(true);
    expect(vals.has(pad(PERMIT2_CANONICAL.toLowerCase() as Address, { size: 32 }))).toBe(true);
  });

  it("Permit2 on 4663 == the genuine Permit2 runtime, with immutables bound to chain 4663 at the canonical address", async () => {
    const cmp = await checkPermit2Runtime(chain.anvil.url, getAddress(manifest.uniswapV4.permit2.address));
    console.log(`W05_RUNTIME Permit2 ${JSON.stringify(cmp)}`);
    expect(cmp.remoteBytes).toBe(manifest.uniswapV4.permit2.codeSize);
    expect(cmp.equalAfterMasking).toBe(true);
    expect(cmp.remoteCachedChainId).toBe(4663);
    expect(cmp.maskedRanges[1]!.remote).toBe(permit2DomainSeparator(4663, PERMIT2_CANONICAL));
  });

  it("the deterministic-deployment proxy 0x4e59…956c exists on 4663 (read-only eth_getCode against the real RPC)", async () => {
    const real = createPublicClient({ transport: http(forkUrl, { retryCount: 4, timeout: 20_000 }) });
    expect(await real.getChainId()).toBe(4663);
    const code = await real.getCode({ address: CREATE2_PROXY });
    console.log(`W05_CREATE2_PROXY_4663 ${code ?? "0x"}`);
    expect(code).toBe(CREATE2_PROXY_RUNTIME);
  });
});
