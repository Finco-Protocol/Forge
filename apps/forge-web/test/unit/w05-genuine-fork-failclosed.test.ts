/**
 * genuineV4OnFork must fail closed: any Uniswap V4 runtime on the fork that differs from the genuine artifact
 * (PoolManager, PositionManager, Permit2), or is missing, aborts - it is never recorded as provenance.
 * Uses a fake loopback JSON-RPC "local fork" so no network is needed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import manifest from "../../config/networks/robinhood-4663.json";
import { genuineV4OnFork } from "../../scripts/w05/genuine-v4";
import { GENUINE, permit2RuntimeFromDeployPermit2 } from "../../scripts/w05/uniswap-artifacts";

const PM = manifest.uniswapV4.poolManager.address.toLowerCase();
const POSM = manifest.uniswapV4.positionManager.address.toLowerCase();
const P2 = manifest.uniswapV4.permit2.address.toLowerCase();

let server: Server;
let url: string;
let code: Record<string, string> = {};
const genuine = () => ({
  [PM]: GENUINE.poolManager().deployedBytecode,
  [POSM]: GENUINE.positionManager().deployedBytecode,
  [P2]: permit2RuntimeFromDeployPermit2().runtime,
});

beforeAll(async () => {
  server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(b);
      let result: unknown = null;
      if (method === "eth_chainId") result = "0x1237";
      else if (method === "anvil_nodeInfo") result = { forkConfig: { forkUrl: "https://example.invalid" } };
      else if (method === "eth_getCode") result = code[String(params[0]).toLowerCase()] ?? "0x";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("genuineV4OnFork fails closed", () => {
  it("accepts the genuine runtimes (control)", async () => {
    code = genuine();
    const g = await genuineV4OnFork(url);
    expect(g.provenance.map((p) => p.contract)).toEqual(["PoolManager", "PositionManager", "Permit2"]);
  });
  it.each([
    ["PoolManager", PM, /PoolManager runtime .* differs/],
    ["PositionManager", POSM, /PositionManager runtime .* differs/],
    ["Permit2", P2, /Permit2 runtime .* differs/],
  ])("%s with different bytecode aborts", async (_n, addr, re) => {
    code = { ...genuine(), [addr]: "0x6080604052600080fdfe" };
    await expect(genuineV4OnFork(url)).rejects.toThrow(re);
  });
  it.each([["PoolManager", PM], ["PositionManager", POSM], ["Permit2", P2]])("%s with no code aborts", async (_n, addr) => {
    code = { ...genuine(), [addr]: "0x" };
    await expect(genuineV4OnFork(url)).rejects.toThrow(/differs|no code|mismatch/i);
  });
  it("a one-byte mutation inside PoolManager runtime aborts", async () => {
    const pm = genuine()[PM] as string;
    const i = 2 + 2 * 3000;
    const flipped = pm.slice(0, i) + (pm.slice(i, i + 2) === "00" ? "01" : "00") + pm.slice(i + 2);
    code = { ...genuine(), [PM]: flipped };
    await expect(genuineV4OnFork(url)).rejects.toThrow(/PoolManager runtime/);
  });
});
