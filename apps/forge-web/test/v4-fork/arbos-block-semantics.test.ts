/**
 * W05 (CI only, READ-ONLY against the real 4663 RPC): does the EVM on
 * Robinhood Chain see the same `block.number` / `blockhash` as the RPC's
 * block numbers and hashes?
 *
 * Why: ForgeProtocolRevenueSplitter.authorizeEligibleRevenue
 * (contractsV2-forge/src/v2/forge/ForgeProtocolRevenueSplitter.sol:283-290)
 * requires `evidenceBlock < block.number`, `block.number - evidenceBlock <= 256`
 * and `blockhash(evidenceBlock) == evidenceBlockHash`, and the attestor
 * (src/server/finance/attestor.ts:153-175) fills those from the RPC's
 * `eth_getBlock`. On Arbitrum-Orbit chains `block.number` / `blockhash` are
 * documented by Arbitrum to differ from L2 RPC block numbers/hashes — if so on
 * 4663, every attestation would revert `StaleEvidence` there. A local Anvil
 * fork CANNOT show this (Anvil applies Ethereum semantics), so this probe
 * asks the real chain with `eth_call` of creation code (nothing is broadcast).
 *
 * The assertion encodes the splitter's assumption; a failure here is the
 * evidence of a production blocker, not a flaky test.
 */
import { describe, expect, it } from "vitest";
import { createPublicClient, http, numberToHex, type Hex } from "viem";
import { requireForkRpc } from "../../scripts/w05/genuine-v4";

// NUMBER PUSH1 0 MSTORE  PUSH1 1 NUMBER SUB BLOCKHASH PUSH1 0x20 MSTORE  PUSH1 0x40 PUSH1 0 RETURN
const PROBE: Hex = "0x43600052600143034060205260406000f3";
const forkUrl = requireForkRpc();

describe("Robinhood 4663: EVM block.number / blockhash vs RPC blocks (read-only eth_call)", () => {
  it("block.number inside eth_call at block N equals N, and blockhash(N-1) equals the RPC hash of block N-1", async () => {
    const real = createPublicClient({ transport: http(forkUrl, { retryCount: 4, timeout: 20_000 }) });
    expect(await real.getChainId()).toBe(4663);
    const n = (await real.getBlockNumber()) - 2n;
    const raw = await real.request({ method: "eth_call", params: [{ data: PROBE }, numberToHex(n)] });
    const evmNumber = BigInt(`0x${raw.slice(2, 66)}`);
    const evmPrevHash = `0x${raw.slice(66, 130)}` as Hex;
    const prev = await real.getBlock({ blockNumber: n - 1n });
    console.log(`W05_ARBOS_BLOCK_SEMANTICS rpcBlock=${n} evmBlockNumber=${evmNumber} rpcPrevHash=${prev.hash} evmBlockhashPrev=${evmPrevHash}`);
    expect(evmNumber, "EVM block.number vs RPC block number (splitter evidence-block assumption)").toBe(n);
    expect(evmPrevHash, "EVM blockhash(N-1) vs RPC hash of N-1 (splitter evidence-hash assumption)").toBe(prev.hash);
  });
});
