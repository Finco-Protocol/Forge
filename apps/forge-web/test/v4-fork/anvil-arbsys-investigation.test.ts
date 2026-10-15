/**
 * PR #5 Correction A - DIAGNOSTIC (CI only; never a gate, asserts no emulation fidelity).
 *
 * Question: can a LOCAL Anvil fork reproduce the ArbOS behaviour the splitter depends on
 * (ArbSys at 0x64: arbBlockNumber()/arbBlockHash())? This test only RECORDS what Anvil does, on a fork with the
 * remote chain id (4663) and on a fork with a local chain-id override, so the fork-evidence classification in
 * docs/W05-ROBINHOOD-V4-DEPLOYMENT.md rests on observed facts rather than assumptions. Read-only against the RPC;
 * every transaction/state change goes to a LOCAL Anvil. Output: `W05_ANVIL_ARBSYS_PROBE <json>`.
 */
import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { requireForkRpc } from "../../scripts/w05/genuine-v4";
import { rpcCall, spawnAnvil } from "../../scripts/w05/anvil-proc";

const ARB_SYS = "0x0000000000000000000000000000000000000064";
const SEL_BLOCK_NUMBER = "0xa3b1b31d"; // arbBlockNumber()
const NUMBER_PROBE: Hex = "0x60004360005260206000f3"; // returns block.number
const RETURN_42 = "0x602a60005260206000f3";

async function attempt<T>(f: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await f();
  } catch (e) {
    return { error: (e as Error).message.split("\n")[0]!.slice(0, 160) };
  }
}

async function probe(url: string) {
  const out: Record<string, unknown> = {};
  out.chainId = await rpcCall<Hex>(url, "eth_chainId");
  out.rpcBlockNumber = await rpcCall<Hex>(url, "eth_blockNumber");
  out.codeAt0x64 = await rpcCall<Hex>(url, "eth_getCode", [ARB_SYS, "latest"]);
  out.callArbBlockNumber = await attempt(() => rpcCall<Hex>(url, "eth_call", [{ to: ARB_SYS, data: SEL_BLOCK_NUMBER }, "latest"]));
  out.evmBlockNumberViaCall = await attempt(() => rpcCall<Hex>(url, "eth_call", [{ data: NUMBER_PROBE }, "latest"]));
  out.setCode = await attempt(() => rpcCall<unknown>(url, "anvil_setCode", [ARB_SYS, RETURN_42]));
  out.callAfterSetCode = await attempt(() => rpcCall<Hex>(url, "eth_call", [{ to: ARB_SYS, data: SEL_BLOCK_NUMBER }, "latest"]));
  out.codeAfterSetCode = await rpcCall<Hex>(url, "eth_getCode", [ARB_SYS, "latest"]);
  return out;
}

describe("DIAGNOSTIC: what does a local Anvil fork do with ArbSys (0x64)?", () => {
  it("records Anvil behaviour on a 4663 fork and on a chain-id-overridden fork", async () => {
    const forkUrl = requireForkRpc();
    const results: Record<string, unknown> = {};
    for (const [label, extra] of [
      ["fork_remote_chain_id", ["--fork-url", forkUrl]],
      ["fork_chain_id_31337", ["--fork-url", forkUrl, "--chain-id", "31337"]],
    ] as const) {
      const anvil = await spawnAnvil([...extra], { timeoutMs: 120_000 });
      try {
        results[label] = await probe(anvil.url);
      } finally {
        await anvil.stop();
      }
    }
    console.log(`W05_ANVIL_ARBSYS_PROBE ${JSON.stringify(results)}`);
    expect(Object.keys(results)).toHaveLength(2); // diagnostic: records facts, asserts none about fidelity
  });
});
