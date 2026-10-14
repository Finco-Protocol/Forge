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

  it("measures the chain's contract code-size limit read-only (eth_estimateGas) — no chain-specific exception is ASSUMED", async () => {
    // Init code returning N zero bytes: PUSH3 N, PUSH1 0, RETURN. Nothing is broadcast.
    const initFor = (n: number) => `0x62${n.toString(16).padStart(6, "0")}6000f3` as const;
    const accepts = (n: number) =>
      client!.estimateGas({ account: "0x000000000000000000000000000000000000dEaD", data: initFor(n) }).then(
        () => true,
        () => false,
      );
    // The Forge factory is gated at the STANDARD limit regardless (pnpm size:check); the chain must accept that.
    expect(await accepts(24_576)).toBe(true);
    // Binary-search the largest accepted runtime up to 128 KiB (bounded by the RPC's gas cap; reported as observed).
    let lo = 24_576;
    let hi = 131_072;
    if (await accepts(hi)) lo = hi;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (await accepts(mid)) lo = mid;
      else hi = mid;
    }
    console.log(`ROBINHOOD_4663_OBSERVED_MAX_RUNTIME_BYTES=${lo} (standard EIP-170 = 24576)`);
    expect(lo).toBeGreaterThanOrEqual(24_576);
  });

  it("no Forge factory is configured for production (PRODUCTION_BLOCKED)", () => {
    expect(manifest.forge.factory).toBeNull();
    expect(manifest.productionStatus).toBe("PRODUCTION_BLOCKED");
  });
});
