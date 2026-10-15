/**
 * PR #5 Correction A (P2): signer-role authority is re-read from the chain on EVERY signing request.
 * Startup verification is never a permanent authorization. The chain is a stub whose state the test
 * mutates between requests; the database is a real (PGlite) schema with the real guard, key registry,
 * kill switch, rate limit and audit tables. Production signing stays disabled (local-test keys,
 * chain 31337 only).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getAddress, keccak256, toBytes, zeroAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { PgliteDb } from "@/server/db";
import { migrate } from "@/server/db/migrate";
import { SignerRegistry } from "@/server/signer/registry";
import { LocalTestDigestSigner } from "@/server/signer/local";
import { revokeSignerKey, rotateSignerKey } from "@/server/signer/controls";
import { ELIGIBLE_REVENUE_TYPES, SPLITTER_EIP712_DOMAIN } from "@/server/finance/attestor";
import { bindingOpTypes, registryDomain } from "@/shared/forge-typed-data";
import type { ForgeConfig } from "@/server/config";

const CHAIN_ID = 31337;
const a = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const ADDR = { registry: a(0x1001), authorizer: a(0x1002), factory: a(0x1003), revenueSplitter: a(0x1004) };
const EXTERNAL = { govOwner: a(0x2001), treasury: a(0x2002), newGov: a(0x2003) };

const keys = { authority: generatePrivateKey(), evidence: generatePrivateKey(), revenue: generatePrivateKey(), relayer: generatePrivateKey(), other: generatePrivateKey() };
const addrOf = (k: Hex) => privateKeyToAccount(k).address;

/** Mutable on-chain truth + a call counter + an RPC outage switch. */
class FakeChain {
  regAuth: Address = addrOf(keys.authority);
  authzAuth: Address = addrOf(keys.authority);
  attestor: Address = addrOf(keys.revenue);
  owner: Address = EXTERNAL.govOwner;
  splitterOwner: Address = EXTERNAL.govOwner;
  treasury: Address = EXTERNAL.treasury;
  pendingOwner: Address = zeroAddress;
  down = false;
  reads = 0;
  gate: Promise<void> | null = null;
  client = {
    readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      this.reads++;
      if (this.gate) await this.gate;
      if (this.down) throw new Error("RPC unavailable (stub)");
      const isSplitter = address === ADDR.revenueSplitter;
      switch (functionName) {
        case "eligibilityAuthority":
          return address === ADDR.registry ? this.regAuth : this.authzAuth;
        case "revenueAttestor":
          return this.attestor;
        case "owner":
          return isSplitter ? this.splitterOwner : this.owner;
        case "treasuryRecipient":
          return this.treasury;
        case "pendingOwner":
          return this.pendingOwner;
      }
      throw new Error(`unexpected read ${functionName}`);
    },
  };
}

function cfg(): ForgeConfig {
  return {
    chainId: CHAIN_ID,
    addresses: ADDR,
    signer: { killSwitch: new Set<string>(), roleRateLimitPerHour: 10_000, expected: {}, provider: "local-test", kmsKeyIds: {} },
  } as unknown as ForgeConfig;
}

let db: PgliteDb;
let chain: FakeChain;
let reg: SignerRegistry;
let n = 0;

async function boot() {
  const c = cfg();
  reg = await SignerRegistry.create({
    cfg: c,
    db,
    client: chain.client as never,
    signers: {
      authority: new LocalTestDigestSigner("authority", keys.authority, c),
      evidence: new LocalTestDigestSigner("evidence", keys.evidence, c),
      revenue: new LocalTestDigestSigner("revenue", keys.revenue, c),
    },
    keyRefs: { authority: "local-test", evidence: "local-test", revenue: "local-test" },
    relayerAddress: addrOf(keys.relayer),
  });
}

const sigMeta = () => ({ requestedBy: "test", correlationId: `c-${++n}` });
const attest = () =>
  reg.guarded("revenue")!.signTypedData(
    {
      domain: { ...SPLITTER_EIP712_DOMAIN, chainId: CHAIN_ID, verifyingContract: ADDR.revenueSplitter },
      types: ELIGIBLE_REVENUE_TYPES,
      primaryType: "EligibleRevenue",
      message: { escrow: a(0x3001), factory: a(0x3002), asset: zeroAddress, cumulativeEligible: BigInt(++n), nonce: BigInt(n), deadline: 4_000_000_000n, evidenceBlock: 1n, evidenceBlockHash: keccak256(toBytes(`b${n}`)) },
    },
    sigMeta(),
  );
const bindingOp = () =>
  reg.guarded("authority")!.signTypedData(
    {
      domain: registryDomain(CHAIN_ID, ADDR.registry),
      types: bindingOpTypes,
      primaryType: "BindingOp",
      message: { githubRepoId: BigInt(++n), creator: a(0x4001), bindingExpiresAt: 4_000_000_000n, opDeadline: 4_000_000_000n, opNonce: BigInt(n), parentOpDigest: `0x${"00".repeat(32)}`, repoFullName: "o/r", revoke: false },
    },
    sigMeta(),
  );
const evidence = () => reg.guarded("evidence")!.signEip191Hash32(keccak256(toBytes(`e${++n}`)), sigMeta());

beforeEach(async () => {
  db = await PgliteDb.open();
  await migrate(db);
  chain = new FakeChain();
  await boot();
});

describe("PR #5 Correction A — signer authority freshness", () => {
  it("1. the correct signers are accepted after startup", async () => {
    await expect(attest()).resolves.toMatchObject({ replayed: false });
    await expect(bindingOp()).resolves.toBeDefined();
    await expect(evidence()).resolves.toBeDefined();
    expect(reg.status("revenue")).toMatchObject({ enabled: true, onchain: "verified" });
  });

  it("2. authority rotated on chain after startup: the old signer is refused on the very next request", async () => {
    await expect(bindingOp()).resolves.toBeDefined(); // verified once...
    chain.regAuth = addrOf(keys.other);
    chain.authzAuth = addrOf(keys.other);
    await expect(bindingOp()).rejects.toThrow(/eligibilityAuthority/); // ...and refused immediately after
    expect(reg.status("authority")).toMatchObject({ enabled: false, onchain: "mismatch" });
    // A half-rotated state (registry only) is refused too.
    chain.regAuth = addrOf(keys.authority);
    chain.authzAuth = addrOf(keys.other);
    await expect(bindingOp()).rejects.toThrow(/eligibilityAuthority/);
  });

  it("3. revenue attestor revoked on chain: refused; re-named by governance: accepted again (explicit current authority)", async () => {
    await expect(attest()).resolves.toBeDefined();
    chain.attestor = zeroAddress; // revokeRevenueAttestor()
    await expect(attest()).rejects.toThrow(/revoked \(address\(0\)\)/);
    expect(reg.status("revenue")?.enabled).toBe(false);
    chain.attestor = addrOf(keys.revenue); // timelocked governance re-names this very key
    await expect(attest()).resolves.toBeDefined();
    expect(reg.status("revenue")?.enabled).toBe(true);
  });

  it("4. treasury recipient rotated into a server signer address: custody conflict, ALL roles refused, sticky", async () => {
    await expect(evidence()).resolves.toBeDefined();
    chain.treasury = addrOf(keys.evidence);
    await expect(attest()).rejects.toThrow(/custody violation.*treasury recipient/);
    await expect(bindingOp()).rejects.toThrow(/custody violation/);
    await expect(evidence()).rejects.toThrow(/custody violation/);
    chain.treasury = EXTERNAL.treasury; // rotating it back does NOT silently re-enable: restart + startup verification required
    await expect(evidence()).rejects.toThrow(/custody violation/);
  });

  it("5. governance owner changed into a server key (or pending owner): key separation is re-checked", async () => {
    await expect(attest()).resolves.toBeDefined();
    chain.pendingOwner = addrOf(keys.relayer); // Ownable2Step pending owner is the server's relayer
    await expect(attest()).rejects.toThrow(/custody violation.*relayer/);
  });

  it("5b. a governance owner equal to the authority key refuses signing", async () => {
    chain.owner = addrOf(keys.authority);
    await expect(bindingOp()).rejects.toThrow(/custody violation.*owner/);
  });

  it("6. RPC unavailable during verification: refused (fail closed) for every role", async () => {
    chain.down = true;
    await expect(attest()).rejects.toThrow(/fail closed/);
    await expect(bindingOp()).rejects.toThrow(/fail closed/);
    await expect(evidence()).rejects.toThrow(/fail closed/);
  });

  it("7. RPC recovers with a legitimately authorized signer: accepted after a fresh validation", async () => {
    chain.down = true;
    await expect(attest()).rejects.toThrow(/fail closed/);
    chain.down = false;
    const before = chain.reads;
    await expect(attest()).resolves.toBeDefined();
    expect(chain.reads).toBeGreaterThan(before); // it read the chain again; nothing was assumed
  });

  it("8. a revoked / retired / stale DB key version is refused even though the chain still names the key", async () => {
    await expect(attest()).resolves.toBeDefined();
    await rotateSignerKey(db, "revenue", { address: addrOf(keys.other), custody: "local-test", keyRef: null }, "ops", "scheduled rotation");
    await expect(attest()).rejects.toThrow(/key version \d+ is retired/);
    await revokeSignerKey(db, "authority", addrOf(keys.authority), "ops", "suspected compromise");
    await expect(bindingOp()).rejects.toThrow(/is revoked/);
    // On-chain agreement cannot override the durable revocation.
    expect(reg.status("authority")?.onchain).not.toBe("mismatch");
  });

  it("9. a previously cached successful verification cannot bypass a later revocation (no TTL, no cache)", async () => {
    for (let i = 0; i < 3; i++) await expect(attest()).resolves.toBeDefined();
    chain.attestor = a(0x9999);
    await expect(attest()).rejects.toThrow(/revenueAttestor .* ≠ custody address/);
    // and the very same request can never be replayed from the stored signature after revocation
    chain.attestor = addrOf(keys.revenue);
    await expect(attest()).resolves.toBeDefined();
    chain.attestor = zeroAddress;
    await expect(attest()).rejects.toThrow(/revoked/);
  });

  it("10. concurrent signing: every request decides from its own fresh read; none passes after the revocation", async () => {
    // 10a: a burst while healthy — all pass, one authoritative snapshot per request (no more, no less).
    const r0 = chain.reads;
    await Promise.all(Array.from({ length: 8 }, () => attest()));
    const perRequest = (chain.reads - r0) / 8;
    expect(Number.isInteger(perRequest) && perRequest > 0).toBe(true);
    // 10b: revocation while requests are in flight. Requests that start after the flip are refused.
    let release!: () => void;
    chain.gate = new Promise<void>((r) => (release = r));
    const inFlight = Array.from({ length: 4 }, () => attest().then(() => "ok", () => "refused"));
    await new Promise((r) => setTimeout(r, 20));
    chain.attestor = zeroAddress; // governance revokes while those reads are pending
    const after = Array.from({ length: 6 }, () => attest().then(() => "ok", () => "refused"));
    await new Promise((r) => setTimeout(r, 20));
    chain.gate = null;
    release();
    const results = await Promise.all([...inFlight, ...after]);
    expect(results.slice(4)).toEqual(Array(6).fill("refused")); // started after the revocation
    // A stale (older) snapshot must not re-enable persisted state.
    expect(reg.status("revenue")?.enabled).toBe(false);
    await expect(attest()).rejects.toThrow(/revoked/);
  });
});
