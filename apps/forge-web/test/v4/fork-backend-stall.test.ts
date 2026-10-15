/**
 * Fork-backend latency evidence on a real Anvil forking a local JSON-RPC stub (no network, no real RPC): the cold-read
 * latency probe exposes a slow backend, and a failed confirmation carries the step, node snapshot and Anvil log tail.
 * (An ad-hoc experiment showed that with a slow fork backend Anvil returns the tx hash after the first slow read while
 * the receipt stays null during the remaining reads - the same signature as the CI timeout; see docs/W05-ROBINHOOD-V4-DEPLOYMENT.md.)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createWalletClient, defineChain, getAddress, http } from "viem";
import { rpcCall, spawnAnvil, type AnvilProc } from "../../scripts/w05/anvil-proc";
import { probeForkLatency, sendAndConfirm, TxConfirmError } from "../../scripts/w05/tx-confirm";

const CHAIN_ID = 4663;
const SENDER = getAddress("0x00000000000000000000000000000000000f7001");
const SINK = getAddress("0x00000000000000000000000000000000000f7002");

// A minimal "remote chain": answers just enough for Anvil to fork it (block 0x10, empty state), with a switchable delay.
let remote: Server;
let remoteUrl: string;
let delayMs = 0;
let anvil: AnvilProc;

const block = (n: number) => ({
  number: `0x${n.toString(16)}`, hash: `0x${n.toString(16).padStart(64, "0")}`, parentHash: `0x${(n - 1).toString(16).padStart(64, "0")}`, nonce: "0x0000000000000000", sha3Uncles: `0x${"1d".repeat(32)}`,
  logsBloom: `0x${"00".repeat(256)}`, transactionsRoot: `0x${"56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421"}`, stateRoot: `0x${"00".repeat(32)}`, receiptsRoot: `0x${"56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421"}`,
  miner: `0x${"00".repeat(20)}`, difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x200", gasLimit: "0x1c9c380", gasUsed: "0x0", timestamp: "0x6700a000", transactions: [], uncles: [], baseFeePerGas: "0x3b9aca00", mixHash: `0x${"00".repeat(32)}`,
});

beforeAll(async () => {
  remote = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", async () => {
      const handle = (q: { id: number; method: string; params: unknown[] }) => {
        const m = q.method;
        let result: unknown = null;
        if (m === "eth_chainId") result = `0x${CHAIN_ID.toString(16)}`;
        else if (m === "eth_blockNumber") result = "0x10";
        else if (m === "eth_getBlockByNumber" || m === "eth_getBlockByHash") result = block(16);
        else if (m === "eth_getBalance" || m === "eth_getTransactionCount") result = "0x0";
        else if (m === "eth_getCode") result = "0x";
        else if (m === "eth_getStorageAt") result = `0x${"00".repeat(32)}`;
        else if (m === "eth_gasPrice") result = "0x3b9aca00";
        else if (m === "eth_getProof") result = { address: q.params[0], balance: "0x0", codeHash: `0x${"c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"}`, nonce: "0x0", storageHash: `0x${"56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421"}`, accountProof: [], storageProof: [] };
        return { jsonrpc: "2.0", id: q.id, result };
      };
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const q = JSON.parse(b);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(q) ? q.map(handle) : handle(q)));
    });
  });
  await new Promise<void>((r) => remote.listen(0, "127.0.0.1", r));
  remoteUrl = `http://127.0.0.1:${(remote.address() as AddressInfo).port}`;
  anvil = await spawnAnvil(["--fork-url", remoteUrl, "--fork-block-number", "16", "--fork-chain-id", String(CHAIN_ID), "--retries", "0"], { captureLogs: true, timeoutMs: 30_000 });
  await rpcCall(anvil.url, "anvil_impersonateAccount", [SENDER]);
  await rpcCall(anvil.url, "anvil_setBalance", [SENDER, "0x56BC75E2D63100000"]);
});
afterAll(async () => {
  remote?.close();
  await anvil?.stop();
});

describe("fork backend latency is measured; confirmation failures carry full context", () => {
  it("fast backend: cold reads are quick and a transfer confirms", async () => {
    const lat = await probeForkLatency(anvil.url, 3);
    expect(lat.samplesMs).toHaveLength(3);
    const c = defineChain({ id: CHAIN_ID, name: "f", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [anvil.url] } } });
    const w = createWalletClient({ chain: c, transport: http(anvil.url), account: SENDER });
    const r = await sendAndConfirm({ rpcUrl: anvil.url, expectedChainId: CHAIN_ID, proc: anvil.proc, logs: anvil.logs, timeoutMs: 10_000 }, { n: 1, op: "call", contract: "t", fn: "x" }, { from: SENDER, to: SINK }, () => w.sendTransaction({ to: SINK, value: 1n, account: SENDER, chain: c } as never));
    expect(r.record.outcome).toBe("CONFIRMED");
  });

  it("slow backend: slow cold reads are visible in the latency probe", async () => {
    delayMs = 700;
    try {
      const lat = await probeForkLatency(anvil.url, 2);
      expect(lat.maxMs).toBeGreaterThanOrEqual(600);
    } finally {
      delayMs = 0;
    }
  });

  it("a failed confirmation always names the step and carries the node snapshot and anvil log tail", async () => {
    const err = await sendAndConfirm({ rpcUrl: anvil.url, expectedChainId: CHAIN_ID, proc: anvil.proc, logs: anvil.logs, timeoutMs: 800 }, { n: 12, op: "call", contract: "factory", fn: "addLaunchConfig" }, { from: SENDER, to: SINK }, async () => {
      await rpcCall(anvil.url, "anvil_setAutomine", [false]);
      const c = defineChain({ id: CHAIN_ID, name: "f", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [anvil.url] } } });
      const h = await createWalletClient({ chain: c, transport: http(anvil.url), account: SENDER }).sendTransaction({ to: SINK, value: 1n, account: SENDER, chain: c } as never);
      return h;
    }).catch((e) => e);
    await rpcCall(anvil.url, "anvil_setAutomine", [true]);
    expect(err).toBeInstanceOf(TxConfirmError);
    expect(err.message).toMatch(/step 12 \(call factory\.addLaunchConfig\)/);
    expect(err.snapshot.anvilLogTail.length).toBeGreaterThan(0);
    expect(err.snapshot.chainId).toBe(CHAIN_ID);
  });
});
