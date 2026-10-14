/**
 * Read-only verification of the genuine Uniswap V4 deployment on Robinhood
 * Chain (4663) recorded in config/networks/robinhood-4663.json. No keys, no
 * writes. Requires FORGE_FORK_RPC_URL; without it the suite fails loudly
 * (a skipped check is not evidence).
 */
import { describe, expect, it } from "vitest";
import { createPublicClient, getAddress, http, parseAbi, type Address } from "viem";
import manifest from "../../config/networks/robinhood-4663.json";

const rpc = process.env.FORGE_FORK_RPC_URL;
const client = rpc ? createPublicClient({ transport: http(rpc, { retryCount: 4, timeout: 20_000 }) }) : null;

describe("Robinhood Chain 4663 — Uniswap V4 wiring (read-only)", () => {
  it("has an RPC configured", () => {
    expect(rpc, "FORGE_FORK_RPC_URL is required for the read-only Robinhood checks").toBeTruthy();
  });

  it("chain id is 4663", async () => {
    expect(await client!.getChainId()).toBe(4663);
  });

  it("PoolManager, PositionManager and Permit2 have code of the recorded size", async () => {
    for (const k of ["poolManager", "positionManager", "permit2"] as const) {
      const entry = manifest.uniswapV4[k];
      const code = await client!.getCode({ address: entry.address as Address });
      expect(code && code !== "0x", `${k} has code`).toBe(true);
      expect((code!.length - 2) / 2, `${k} code size`).toBe(entry.codeSize);
    }
  });

  it("PositionManager is wired to the recorded PoolManager and Permit2", async () => {
    const abi = parseAbi(["function poolManager() view returns (address)", "function permit2() view returns (address)"]);
    const pm = manifest.uniswapV4.positionManager.address as Address;
    expect(getAddress(await client!.readContract({ address: pm, abi, functionName: "poolManager" }))).toBe(getAddress(manifest.uniswapV4.poolManager.address));
    expect(getAddress(await client!.readContract({ address: pm, abi, functionName: "permit2" }))).toBe(getAddress(manifest.uniswapV4.permit2.address));
  });

  it("the deployed PONS hook satisfies the 0x2044 permission mask the W02 hook requires", async () => {
    const abi = parseAbi(["function memeHook() view returns (address)", "function poolManager() view returns (address)"]);
    const factory = manifest.originalPonsFactory.address as Address;
    const hook = await client!.readContract({ address: factory, abi, functionName: "memeHook" });
    expect(BigInt(hook) & 0x3fffn).toBe(BigInt(manifest.hookRequirements.permissionMask));
    expect(getAddress(await client!.readContract({ address: factory, abi, functionName: "poolManager" }))).toBe(getAddress(manifest.uniswapV4.poolManager.address));
  });

  it("applies the standard EIP-170 code-size limit (24,576 B), probed read-only via eth_estimateGas", async () => {
    // Init code returning N zero bytes: PUSH2 N, PUSH1 0, RETURN. Nothing is broadcast.
    const at = await client!.estimateGas({ account: "0x000000000000000000000000000000000000dEaD", data: "0x6160006000f3" });
    expect(at > 0n).toBe(true);
    await expect(client!.estimateGas({ account: "0x000000000000000000000000000000000000dEaD", data: "0x6160016000f3" })).rejects.toThrow();
  });

  it("no Forge factory is configured for production (PRODUCTION_BLOCKED)", () => {
    expect(manifest.forge.factory).toBeNull();
    expect(manifest.productionStatus).toBe("PRODUCTION_BLOCKED");
  });
});
