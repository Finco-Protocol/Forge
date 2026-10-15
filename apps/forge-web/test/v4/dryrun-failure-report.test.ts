/**
 * K: a dry-run whose transaction confirmation fails produces a FAILED report with the exact step, classification, node
 * snapshot and step history - never a partial "success" - and the local Anvil is stopped. L: the executor refuses a real
 * (non-loopback) RPC before sending a single request. J/M: addresses are predicted from the live nonce and the blocks
 * come from the node, not from a constant.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildDeployManifest } from "../../scripts/w05/deploy-plan-lib";
import { executeDryRun, forgeBuildProvider, planInputFor } from "../../scripts/w05/deploy-plan";
import { startGenuineChain, type GenuineChain } from "../../scripts/w05/genuine-v4";

let chain: GenuineChain;
let proxy: Server;
let proxyUrl: string;
let sends = 0;
let hideFromSend = Infinity;

beforeAll(async () => {
  chain = await startGenuineChain("local-genuine");
  proxy = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", async () => {
      const q = JSON.parse(b);
      let out: unknown;
      if (q.method === "eth_sendTransaction") sends++;
      if (q.method === "eth_getTransactionReceipt" && sends >= hideFromSend) out = { jsonrpc: "2.0", id: q.id, result: null };
      else out = await fetch(chain.anvil.url, { method: "POST", headers: { "content-type": "application/json" }, body: b }).then((r) => r.json());
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});
afterAll(async () => {
  proxy?.close();
  await chain?.stop();
});

const manifest = () => buildDeployManifest(planInputFor("local-genuine", { poolManager: chain.v4.poolManager, positionManager: chain.v4.positionManager, permit2: chain.v4.permit2 }), forgeBuildProvider());

describe("dry-run failure context (K)", () => {
  it("receipts vanish from the 4th submitted step: FAILED report with exact step, classification, snapshot and history", async () => {
    sends = 0;
    hideFromSend = 4; // from the 4th submitted transaction on, receipt lookups return null
    const m = manifest();
    const report = await executeDryRun(m, proxyUrl, { proc: chain.anvil.proc, logs: chain.anvil.logs, timeoutMs: 1_500 });
    hideFromSend = Infinity;
    expect(report.status).toBe("FAILED");
    expect(report.ok).toBe(false);
    expect(report.failure!.step).toBe(4);
    expect(report.failure!.classification).toBe("RPC_RECEIPT_UNAVAILABLE");
    expect(report.failure!.snapshot!.tx!.hash).toBe(report.stepHistory.at(-1)!.txHash);
    expect(report.failure!.snapshot!.automine).toBe(true);
    expect(report.stepHistory.map((s) => s.outcome)).toEqual(["CONFIRMED", "CONFIRMED", "CONFIRMED", "FAILED"]);
    expect(report.executedSteps).toBe(3);
    expect(report.checks.some((c) => c.id === "STEP:4" && !c.ok)).toBe(true);
    // not a single smoke check ran after the failed deployment, and nothing claims completeness
    expect(report.checks.every((c) => !c.id.startsWith("S0"))).toBe(true);
    expect(report.stepHistory.every((s) => s.contract && s.from && s.expectedNonce !== null)).toBe(true);
  });
});

describe("no genuine broadcast (L)", () => {
  it("executeDryRun refuses a real RPC before making any request", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(executeDryRun(manifest(), "https://rpc.mainnet.chain.robinhood.com")).rejects.toThrow(/refusing to send/);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
