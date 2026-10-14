/**
 * W05 fork-mode guard rails, exercised locally (no Robinhood RPC needed):
 * fork mode refuses to run without FORGE_FORK_RPC_URL, the Forge stack is
 * never deployed to a 4663 chain that is not a LOCAL Anvil fork, and a
 * genuine local fork (anvil --fork-url <local anvil with chain id 4663>) is
 * recognised as such.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deploySandbox, isLocalAnvilFork } from "../../scripts/sandbox-lib";
import { requireForkRpc, genuineV4OnFork } from "../../scripts/w05/genuine-v4";
import { spawnAnvil, type AnvilProc } from "../../scripts/w05/anvil-proc";

let upstream: AnvilProc;
let fork: AnvilProc;

beforeAll(async () => {
  // A plain (non-fork) local chain that merely CLAIMS chain id 4663.
  upstream = await spawnAnvil(["--chain-id", "4663"]);
  fork = await spawnAnvil(["--fork-url", upstream.url]);
});
afterAll(async () => {
  await fork?.stop();
  await upstream?.stop();
});

describe("W05 fork-mode guards", () => {
  it("fork mode throws without FORGE_FORK_RPC_URL (fail loudly, never skip)", () => {
    expect(() => requireForkRpc({})).toThrow(/FORGE_FORK_RPC_URL is required/);
    expect(requireForkRpc({ FORGE_FORK_RPC_URL: "http://example.invalid" })).toBe("http://example.invalid");
  });

  it("a non-loopback RPC is never treated as a local fork", async () => {
    expect(await isLocalAnvilFork("https://rpc.mainnet.chain.robinhood.com")).toBe(false);
  });

  it("deploySandbox refuses chain 4663 when the RPC is not a local Anvil FORK, even if 4663 is allow-listed", async () => {
    expect(await isLocalAnvilFork(upstream.url)).toBe(false);
    await expect(deploySandbox(upstream.url, { allowLocalForkOf: [4663] })).rejects.toThrow(/Refusing to deploy the sandbox to chain 4663/);
    await expect(deploySandbox(upstream.url)).rejects.toThrow(/Refusing/);
  });

  it("a real local anvil fork of a 4663 chain is recognised; without the allow-list it is still refused", async () => {
    expect(await isLocalAnvilFork(fork.url)).toBe(true);
    await expect(deploySandbox(fork.url)).rejects.toThrow(/Refusing to deploy the sandbox to chain 4663/);
  });

  it("genuineV4OnFork refuses a non-fork 4663 endpoint", async () => {
    await expect(genuineV4OnFork(upstream.url)).rejects.toThrow(/LOCAL anvil fork/);
  });
});
