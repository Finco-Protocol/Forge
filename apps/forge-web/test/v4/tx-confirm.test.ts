/**
 * Transaction submission/confirmation semantics on a REAL local Anvil (no mocks of the node): automining, pending due to
 * mining configuration, nonce gap, underpricing, receipt unavailable, revert, node exit, wrong chain, and the dry-run
 * report's failure context. All writes are loopback-only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createWalletClient, defineChain, getAddress, http, toHex, type Hex } from "viem";
import { rpcCall, spawnAnvil, type AnvilProc } from "../../scripts/w05/anvil-proc";
import { sendAndConfirm, TxConfirmError, assertLocalAutomine, type SendCtx } from "../../scripts/w05/tx-confirm";

const CHAIN_ID = 31337;
const SENDER = getAddress("0x00000000000000000000000000000000000f1234");
const SINK = getAddress("0x00000000000000000000000000000000000f5678");
const REVERTER = getAddress("0x00000000000000000000000000000000000f9999");

let a: AnvilProc;
const chainOf = (url: string) => defineChain({ id: CHAIN_ID, name: "t", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [url] } } });
const wallet = (url: string) => createWalletClient({ chain: chainOf(url), transport: http(url), account: SENDER });
const ctx = (url: string, o: Partial<SendCtx> = {}): SendCtx => ({ rpcUrl: url, expectedChainId: CHAIN_ID, proc: a.proc, logs: a.logs, timeoutMs: 3_000, pollMs: 50, ...o });
const info = (n = 1) => ({ n, op: "call", contract: "test", fn: "transfer" });
const transfer = (url: string, extra: Record<string, unknown> = {}) => () => wallet(url).sendTransaction({ to: SINK, value: 1n, account: SENDER, chain: chainOf(url), ...extra } as never);

async function setup(node: AnvilProc) {
  await rpcCall(node.url, "anvil_impersonateAccount", [SENDER]);
  await rpcCall(node.url, "anvil_setBalance", [SENDER, "0x56BC75E2D63100000"]);
}

beforeAll(async () => {
  a = await spawnAnvil(["--chain-id", String(CHAIN_ID)], { captureLogs: true });
  await setup(a);
});
afterAll(async () => a?.stop());

describe("normal local Anvil automining (A)", () => {
  it("confirms the exact hash, records nonce/fees/blocks, and verifies automine", async () => {
    expect((await assertLocalAutomine(a.url)).automine).toBe(true);
    const before = Number(BigInt(await rpcCall<string>(a.url, "eth_blockNumber")));
    const { record, receipt } = await sendAndConfirm(ctx(a.url), info(), { from: SENDER, to: SINK }, transfer(a.url));
    expect(record.outcome).toBe("CONFIRMED");
    expect(record.txHash).toBe(receipt.transactionHash);
    expect(record.txNonce).toBe(record.expectedNonce);
    expect(record.visibleByHash).toBe(true);
    expect(record.blockAtConfirm).toBeGreaterThan(before); // derived from the live node, never a constant
    expect(BigInt(record.gas!)).toBeGreaterThan(0n);
    expect(receipt.status).toBe("success");
  });
});

describe("failures carry exact step context and a deterministic classification", () => {
  it("C: pending because automine is off -> PENDING_AUTOMINE_DISABLED (and the guard refuses to start)", async () => {
    await rpcCall(a.url, "anvil_setAutomine", [false]);
    try {
      await expect(assertLocalAutomine(a.url)).rejects.toThrow(/not auto-mining/);
      const err = await sendAndConfirm(ctx(a.url, { timeoutMs: 1_500 }), info(7), { from: SENDER, to: SINK }, transfer(a.url)).catch((e) => e);
      expect(err).toBeInstanceOf(TxConfirmError);
      expect(err.classification).toBe("PENDING_AUTOMINE_DISABLED");
      expect(err.record.n).toBe(7);
      expect(err.record.pendingAtFailure).toBe(true);
      expect(err.record.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(err.snapshot.automine).toBe(false);
      expect(err.snapshot.txpool.pending).toBeGreaterThanOrEqual(1);
      expect(err.message).toMatch(/step 7/);
    } finally {
      await rpcCall(a.url, "anvil_setAutomine", [true]);
      await rpcCall(a.url, "evm_mine", []); // flush: this is the test's own cleanup on its own local node
    }
  });

  it("D: a nonce gap is accepted but never mined -> PENDING_NONCE_GAP (or rejected as a nonce error)", async () => {
    const latest = Number(BigInt(await rpcCall<string>(a.url, "eth_getTransactionCount", [SENDER, "latest"])));
    const err = await sendAndConfirm(ctx(a.url, { timeoutMs: 1_500 }), info(2), { from: SENDER, to: SINK }, transfer(a.url, { nonce: latest + 5 })).catch((e) => e);
    expect(err).toBeInstanceOf(TxConfirmError);
    expect(err.classification).toBe("PENDING_NONCE_GAP");
    expect(err.record.n).toBe(2);
  });

  it("E: an underpriced transaction is never reported as confirmed", async () => {
    const err = await sendAndConfirm(ctx(a.url, { timeoutMs: 1_500 }), info(3), { from: SENDER, to: SINK }, transfer(a.url, { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })).catch((e) => e);
    expect(err).toBeInstanceOf(TxConfirmError);
    expect(err.classification).toBe("UNDERPRICED");
  });

  it("G: a mined revert is a CONFIRMED_REVERT failure with the receipt status recorded", async () => {
    await rpcCall(a.url, "anvil_setCode", [REVERTER, "0x60006000fd"]); // PUSH0 PUSH0 REVERT-ish: always reverts
    const err = await sendAndConfirm(ctx(a.url), info(4), { from: SENDER, to: REVERTER }, transfer(a.url, { to: REVERTER, gas: 100_000n, value: 0n, data: "0x12345678" as Hex })).catch((e) => e);
    expect(err).toBeInstanceOf(TxConfirmError);
    expect(err.classification).toBe("CONFIRMED_REVERT");
    expect(err.record.receiptStatus).toBe("reverted");
  });

  it("I: a wrong-chain RPC is refused before anything is sent", async () => {
    let sent = false;
    const err = await sendAndConfirm(ctx(a.url, { expectedChainId: 4663 }), info(5), { from: SENDER, to: SINK }, async () => {
      sent = true;
      return "0x" as Hex;
    }).catch((e) => e);
    expect(err.classification).toBe("WRONG_CHAIN");
    expect(sent).toBe(false);
  });

  it("a receipt for the wrong target is a RECEIPT_MISMATCH", async () => {
    const err = await sendAndConfirm(ctx(a.url), info(6), { from: SENDER, to: getAddress("0x00000000000000000000000000000000000f0001") }, transfer(a.url)).catch((e) => e);
    expect(err.classification).toBe("RECEIPT_MISMATCH");
  });
});

describe("F: RPC accepted the transaction but the receipt is unavailable", () => {
  let proxy: Server;
  let proxyUrl: string;
  beforeAll(async () => {
    proxy = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", async () => {
        const q = JSON.parse(b);
        const hide = q.method === "eth_getTransactionReceipt";
        const out = hide ? { jsonrpc: "2.0", id: q.id, result: null } : await fetch(a.url, { method: "POST", headers: { "content-type": "application/json" }, body: b }).then((r) => r.json());
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(out));
      });
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  });
  afterAll(() => proxy?.close());
  it("mined per getTransactionByHash but no receipt -> RPC_RECEIPT_UNAVAILABLE", async () => {
    const err = await sendAndConfirm(ctx(proxyUrl, { timeoutMs: 1_200 }), info(8), { from: SENDER, to: SINK }, transfer(proxyUrl)).catch((e) => e);
    expect(err).toBeInstanceOf(TxConfirmError);
    expect(err.classification).toBe("RPC_RECEIPT_UNAVAILABLE");
    expect(err.record.visibleByHash).toBe(true);
  });
});

describe("H: the local Anvil exits while the receipt is being polled", () => {
  it("-> ANVIL_EXITED, and stop() leaves no process behind", async () => {
    const b = await spawnAnvil(["--chain-id", String(CHAIN_ID), "--no-mining"], { captureLogs: true });
    await setup(b);
    const killer = setTimeout(() => b.proc.kill("SIGKILL"), 400);
    const err = await sendAndConfirm({ ...ctx(b.url, { timeoutMs: 5_000 }), proc: b.proc, logs: b.logs }, info(9), { from: SENDER, to: SINK }, transfer(b.url)).catch((e) => e);
    clearTimeout(killer);
    expect(err).toBeInstanceOf(TxConfirmError);
    expect(err.classification).toBe("ANVIL_EXITED");
    await b.stop();
    expect(b.proc.exitCode !== null || b.proc.signalCode !== null).toBe(true);
  });
  it("stop() terminates a healthy node and resolves only after it is gone", async () => {
    const c = await spawnAnvil([], { captureLogs: true });
    await c.stop();
    expect(c.proc.exitCode !== null || c.proc.signalCode !== null).toBe(true);
  });
});

describe("no genuine broadcast is possible", () => {
  it("a non-loopback RPC is refused before the submit callback runs", async () => {
    let sent = false;
    const err = await sendAndConfirm({ rpcUrl: "https://rpc.mainnet.chain.robinhood.com", expectedChainId: 4663 }, info(10), { from: SENDER }, async () => {
      sent = true;
      return toHex(0, { size: 32 });
    }).catch((e) => e);
    expect(String(err.message)).toMatch(/refusing to send/);
    expect(sent).toBe(false);
  });
});
