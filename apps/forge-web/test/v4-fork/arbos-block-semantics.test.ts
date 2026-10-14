/**
 * W05 (CI only, READ-ONLY against the real 4663 RPC): block-number semantics
 * the splitter's evidence check depends on.
 *
 * MEASURED FINDING (CI run on PR #5): on Robinhood Chain, EVM `block.number`
 * inside eth_call is the PARENT-chain block number, NOT the RPC's L2 block
 * number (e.g. EVM 26,193,299 vs RPC 88,673,151). The original splitter check
 * (`block.number` / `blockhash`) therefore reverted StaleEvidence for every
 * attestation (finding W05-05). The splitter now reads the L2 head and hashes
 * through the ArbSys precompile (0x64) when it answers.
 *
 * This probe asserts the property the fix relies on, via eth_call only
 * (nothing is broadcast): ArbSys.arbBlockNumber() at block N equals N and
 * ArbSys.arbBlockHash(N-1) equals the RPC hash of block N-1. It also records
 * (informationally) how far block.number diverges, to keep the finding visible.
 */
import { describe, expect, it } from "vitest";
import { createPublicClient, encodeFunctionData, http, numberToHex, parseAbi, type Hex } from "viem";
import { requireForkRpc } from "../../scripts/w05/genuine-v4";

// NUMBER PUSH1 0 MSTORE  PUSH1 1 NUMBER SUB BLOCKHASH PUSH1 0x20 MSTORE  PUSH1 0x40 PUSH1 0 RETURN
const ARB_ABI = parseAbi(["function arbBlockNumber() view returns (uint256)", "function arbBlockHash(uint256) view returns (bytes32)"]);
const PROBE: Hex = "0x43600052600143034060205260406000f3";
const ARB_SYS = "0x0000000000000000000000000000000000000064" as const;
const forkUrl = requireForkRpc();

describe("Robinhood 4663: ArbSys L2 block number/hash vs RPC blocks (read-only eth_call)", () => {
  it("ArbSys.arbBlockNumber() at block N equals N and ArbSys.arbBlockHash(N-1) equals the RPC hash of N-1", async () => {
    const real = createPublicClient({ transport: http(forkUrl, { retryCount: 4, timeout: 20_000 }) });
    expect(await real.getChainId()).toBe(4663);
    const n = (await real.getBlockNumber()) - 2n;
    const at = numberToHex(n);
    const prev = await real.getBlock({ blockNumber: n - 1n });

    const raw = await real.request({ method: "eth_call", params: [{ data: PROBE }, at] });
    const evmNumber = BigInt(`0x${raw.slice(2, 66)}`);
    const evmPrevHash = `0x${raw.slice(66, 130)}` as Hex;

    const arbNum = await real.request({ method: "eth_call", params: [{ to: ARB_SYS, data: encodeFunctionData({ abi: ARB_ABI, functionName: "arbBlockNumber" }) }, at] });
    const arbHash = await real.request({ method: "eth_call", params: [{ to: ARB_SYS, data: encodeFunctionData({ abi: ARB_ABI, functionName: "arbBlockHash", args: [n - 1n] }) }, at] });
    console.log(
      `W05_ARBOS_BLOCK_SEMANTICS rpcBlock=${n} evmBlockNumber=${evmNumber} arbBlockNumber=${BigInt(arbNum)} rpcPrevHash=${prev.hash} evmBlockhashPrev=${evmPrevHash} arbBlockHashPrev=${arbHash}`,
    );
    expect(BigInt(arbNum), "ArbSys.arbBlockNumber() vs RPC block number (splitter evidence head)").toBe(n);
    expect(arbHash, "ArbSys.arbBlockHash(N-1) vs RPC hash of N-1 (splitter evidence hash)").toBe(prev.hash);
  });
});
