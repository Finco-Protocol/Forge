import { describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { ANVIL_KEYS } from "../../scripts/sandbox-lib";
import { assertStagingChain, assertStagingEnv, StagingConfigError, stagingViolations } from "@/server/staging/guard";

const GOOD: Record<string, string> = {
  FORGE_STAGING: "true",
  FORGE_NETWORK: "sandbox",
  FORGE_CHAIN_ID: "31337",
  FORGE_RPC_URL: "http://127.0.0.1:8545",
  FORGE_PUBLIC_ORIGIN: "http://localhost:3000",
  GITHUB_API_URL: "http://127.0.0.1:8787",
  GITHUB_WEB_URL: "http://127.0.0.1:8787",
  DATABASE_URL: "postgres://forge:pw@127.0.0.1:5432/forge_staging",
  SESSION_SECRET: "cd".repeat(20),
  FORGE_OPS_TOKEN: "ab".repeat(20),
  FORGE_AUTHORITY_PRIVATE_KEY: ANVIL_KEYS[1],
  FORGE_RELAYER_PRIVATE_KEY: ANVIL_KEYS[2],
};
const codes = (patch: Record<string, string | undefined>) => stagingViolations({ ...GOOD, ...patch }).map((v) => v.code);

describe("W06 staging guard", () => {
  it("accepts a fully sandboxed environment", () => {
    expect(stagingViolations(GOOD)).toEqual([]);
    expect(() => assertStagingEnv(GOOD)).not.toThrow();
  });

  it("allow-lists compose service names but never public providers, even if allow-listed by mistake", () => {
    expect(codes({ FORGE_RPC_URL: "http://anvil:8545" })).toContain("STAGING_RPC_HOST");
    expect(codes({ FORGE_RPC_URL: "http://anvil:8545", FORGE_STAGING_HOST_ALLOWLIST: "anvil" })).not.toContain("STAGING_RPC_HOST");
    expect(codes({ FORGE_RPC_URL: "https://rpc.arbitrum.io", FORGE_STAGING_HOST_ALLOWLIST: "rpc.arbitrum.io" })).toContain("STAGING_RPC_HOST");
    expect(codes({ GITHUB_API_URL: "https://api.github.com", FORGE_STAGING_HOST_ALLOWLIST: "api.github.com" })).toContain("STAGING_GITHUB_REAL");
  });

  const refused: Array<[string, Record<string, string | undefined>, string]> = [
    ["missing marker", { FORGE_STAGING: undefined }, "STAGING_MARKER_MISSING"],
    ["robinhood network", { FORGE_NETWORK: "robinhood" }, "STAGING_NETWORK"],
    ["chain 4663", { FORGE_CHAIN_ID: "4663" }, "STAGING_CHAIN_ID"],
    ["mainnet chain", { FORGE_CHAIN_ID: "1" }, "STAGING_CHAIN_ID"],
    ["remote RPC", { FORGE_RPC_URL: "https://eth-mainnet.g.alchemy.com/v2/x" }, "STAGING_RPC_HOST"],
    ["unparseable RPC", { FORGE_RPC_URL: "not a url" }, "STAGING_RPC_HOST"],
    ["real GitHub API", { GITHUB_API_URL: "https://api.github.com" }, "STAGING_GITHUB_REAL"],
    ["real GitHub web", { GITHUB_WEB_URL: "https://github.com" }, "STAGING_GITHUB_REAL"],
    ["kms provider", { FORGE_SIGNER_PROVIDER: "kms" }, "STAGING_SIGNER_PROVIDER"],
    ["random (non-test) key", { FORGE_AUTHORITY_PRIVATE_KEY: generatePrivateKey() }, "STAGING_KEY_NOT_TEST_ONLY"],
    ["malformed key", { FORGE_EVIDENCE_PRIVATE_KEY: "0x1234" }, "STAGING_KEY_NOT_TEST_ONLY"],
    ["burn enabled", { FINCO_BURN_ENABLED: "true" }, "STAGING_FLAG"],
    ["production signing", { PRODUCTION_SIGNING_ENABLED: "true" }, "STAGING_FLAG"],
    ["revenue signing", { REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED: "1" }, "STAGING_FLAG"],
    ["deploy writes", { DEPLOY_WRITE_ENABLED: "true" }, "STAGING_FLAG"],
    ["production unblocked", { PRODUCTION_BLOCKED: "false" }, "STAGING_FLAG"],
    ["no database", { DATABASE_URL: undefined }, "STAGING_DATABASE"],
    ["pglite store", { FORGE_PGLITE_DIR: "/tmp/x" }, "STAGING_DATABASE"],
    ["production db name", { DATABASE_URL: "postgres://u:p@127.0.0.1/forge" }, "STAGING_DATABASE"],
    ["managed cloud db host", { DATABASE_URL: "postgres://u:p@mydb.abc.us-east-1.rds.amazonaws.com/forge_staging" }, "STAGING_DATABASE"],
    ["non-postgres scheme", { DATABASE_URL: "mysql://u:p@127.0.0.1/forge_staging" }, "STAGING_DATABASE"],
    ["short session secret", { SESSION_SECRET: "short" }, "STAGING_SECRET"],
    ["sample session secret", { SESSION_SECRET: "replace-with-64-hex-chars-from-openssl-rand-hex-32-xxxx" }, "STAGING_SECRET"],
    ["missing ops token", { FORGE_OPS_TOKEN: undefined }, "STAGING_SECRET"],
    ["public origin", { FORGE_PUBLIC_ORIGIN: "https://forge.example.com" }, "STAGING_PUBLIC_ORIGIN"],
  ];
  it.each(refused)("refuses: %s", (_name, patch, code) => {
    expect(codes(patch)).toContain(code);
    expect(() => assertStagingEnv({ ...GOOD, ...patch })).toThrow(StagingConfigError);
  });

  it("reports every violation at once (an operator fixes them in one pass)", () => {
    const v = stagingViolations({ ...GOOD, FORGE_CHAIN_ID: "4663", FINCO_BURN_ENABLED: "true", DATABASE_URL: undefined });
    expect(new Set(v.map((x) => x.code))).toEqual(new Set(["STAGING_CHAIN_ID", "STAGING_FLAG", "STAGING_DATABASE"]));
  });

  describe("RPC chain probe", () => {
    const rpcReturning = (result: string | undefined): typeof fetch => (async () => new Response(JSON.stringify(result === undefined ? {} : { jsonrpc: "2.0", id: 1, result }), { status: 200 })) as unknown as typeof fetch;
    it("accepts 31337 and 1337", async () => {
      await expect(assertStagingChain("http://x", rpcReturning("0x7a69"))).resolves.toBe(31337);
      await expect(assertStagingChain("http://x", rpcReturning("0x539"))).resolves.toBe(1337);
    });
    it("refuses 4663, mainnet and a malformed answer", async () => {
      for (const r of ["0x1237", "0x1", undefined]) await expect(assertStagingChain("http://x", rpcReturning(r))).rejects.toBeInstanceOf(StagingConfigError);
    });
    it("fails closed when the RPC is unreachable", async () => {
      await expect(assertStagingChain("http://x", (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch)).rejects.toThrow("ECONNREFUSED");
    });
  });
});
