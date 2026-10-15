/**
 * B: a transaction on the LOCAL Anvil fork of Robinhood 4663 is confirmed through the instrumented path.
 * The fork source is read-only; every write goes to the loopback Anvil. Runs only where FORGE_FORK_RPC_URL is set (CI).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWalletClient, defineChain, getAddress, http } from "viem";
import { rpcCall } from "../../scripts/w05/anvil-proc";
import { startGenuineChain, ROBINHOOD_CHAIN_ID, type GenuineChain } from "../../scripts/w05/genuine-v4";
import { isLocalAnvilFork } from "../../scripts/sandbox-lib";
import { assertLocalAutomine, assertLoopbackRpc, sendAndConfirm } from "../../scripts/w05/tx-confirm";

const SENDER = getAddress("0x00000000000000000000000000000000000f4663");
const SINK = getAddress("0x00000000000000000000000000000000000f4664");
let chain: GenuineChain;

beforeAll(async () => {
  chain = await startGenuineChain("fork");
});
afterAll(async () => chain?.stop());

describe("Robinhood 4663 local fork: transaction confirmation", () => {
  it("is a local Anvil fork, auto-mining, and refuses nothing but non-loopback endpoints", async () => {
    expect(await isLocalAnvilFork(chain.anvil.url)).toBe(true);
    expect(() => assertLoopbackRpc(chain.anvil.url)).not.toThrow();
    expect((await assertLocalAutomine(chain.anvil.url)).automine).toBe(true);
    expect(Number(BigInt(await rpcCall<string>(chain.anvil.url, "eth_chainId")))).toBe(ROBINHOOD_CHAIN_ID);
  });

  it("an impersonated transfer confirms with the exact hash, nonce and a block derived from the live fork head", async () => {
    const url = chain.anvil.url;
    await rpcCall(url, "anvil_impersonateAccount", [SENDER]);
    await rpcCall(url, "anvil_setBalance", [SENDER, "0x56BC75E2D63100000"]);
    const head = Number(BigInt(await rpcCall<string>(url, "eth_blockNumber")));
    expect(head).toBeGreaterThan(1_000_000); // a real forked height, never a constant in the test or the harness
    const c = defineChain({ id: ROBINHOOD_CHAIN_ID, name: "fork", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [url] } } });
    const w = createWalletClient({ chain: c, transport: http(url), account: SENDER });
    const { record, receipt } = await sendAndConfirm({ rpcUrl: url, expectedChainId: ROBINHOOD_CHAIN_ID, proc: chain.anvil.proc, logs: chain.anvil.logs }, { n: 1, op: "call", contract: "fork-test", fn: "transfer" }, { from: SENDER, to: SINK }, () =>
      w.sendTransaction({ to: SINK, value: 1n, account: SENDER, chain: c } as never),
    );
    expect(receipt.status).toBe("success");
    expect(record.txHash).toBe(receipt.transactionHash);
    expect(record.txNonce).toBe(record.expectedNonce);
    expect(record.blockAtConfirm).toBeGreaterThan(head);
    expect(record.visibleByHash).toBe(true);
  });
});
