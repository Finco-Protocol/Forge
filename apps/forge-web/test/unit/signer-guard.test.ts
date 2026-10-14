import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress, hashMessage, keccak256, recoverAddress, recoverTypedDataAddress, toBytes, zeroAddress, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { PgliteDb } from "@/server/db";
import { migrate } from "@/server/db/migrate";
import { bindingOpTypes, eligibilityAttestationTypes, launchAuthorizationTypes, launchDomain, registryDomain } from "@/shared/forge-typed-data";
import { ELIGIBLE_REVENUE_TYPES, SPLITTER_EIP712_DOMAIN } from "@/server/finance/attestor";
import { buildAllowlist, type SignerRole } from "@/server/signer/allowlist";
import { enrollConfiguredKey, engageKillSwitch, releaseKillSwitch, revokeSignerKey, rotateSignerKey } from "@/server/signer/controls";
import { GuardedSigner, type TypedDataRequest } from "@/server/signer/guard";
import { LocalTestDigestSigner } from "@/server/signer/local";
import { KmsDigestSigner } from "@/server/signer/kms/signer";
import { awsKmsBackend } from "@/server/signer/kms/aws";
import type { DigestSigner } from "@/server/signer/types";
import { FakeAwsKms, fakeKeyArn } from "../helpers/fake-kms";

const T = 60_000;
const chainId = 31337;
const addresses = {
  registry: getAddress("0x5FbDB2315678afecb367f032d93F642f64180aa3"),
  authorizer: getAddress("0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"),
  revenueSplitter: getAddress("0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0"),
};
const meta = { requestedBy: "unit-test" };

let db: PgliteDb;
beforeAll(async () => {
  db = await PgliteDb.open();
  await migrate(db);
}, T);
afterAll(async () => db?.close());

/** Counts custody calls; optional delay/failure. */
class CountingSigner implements DigestSigner {
  calls = 0;
  fail = false;
  constructor(private readonly inner: DigestSigner, private readonly delayMs = 0) {}
  get role() {
    return this.inner.role;
  }
  get custody() {
    return this.inner.custody;
  }
  get address() {
    return this.inner.address;
  }
  async signDigest(d: Hex) {
    this.calls++;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.fail) throw new Error("KMS: ThrottlingException");
    return this.inner.signDigest(d);
  }
}

async function guard(role: SignerRole, opts: { inner?: DigestSigner; delayMs?: number; rate?: number; env?: string[]; gate?: () => Promise<string | null>; enroll?: boolean } = {}) {
  const inner = new CountingSigner(opts.inner ?? new LocalTestDigestSigner(role, generatePrivateKey(), { chainId }), opts.delayMs);
  // Make this key the role's only active version (rotation retires the previous one).
  if (opts.enroll !== false) await rotateSignerKey(db, role, { address: inner.address, custody: inner.custody, keyRef: null }, "unit-test", "fresh key");
  const g = new GuardedSigner({
    role,
    inner,
    db,
    chainId,
    allowlist: buildAllowlist(role, { chainId, addresses }),
    envKillSwitch: new Set(opts.env ?? []),
    rateLimitPerHour: opts.rate ?? 1_000,
    verificationGate: opts.gate ?? (async () => null),
  });
  return { g, inner };
}

let nonce = 0n;
function bindingOp(overrides: Partial<TypedDataRequest> = {}): TypedDataRequest {
  nonce++;
  return {
    domain: registryDomain(chainId, addresses.registry),
    types: bindingOpTypes,
    primaryType: "BindingOp",
    message: { githubRepoId: 42n, creator: getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8"), bindingExpiresAt: 2_000_000_000n, opDeadline: 1_900_000_000n, opNonce: nonce, parentOpDigest: keccak256(toBytes("head")), repoFullName: "org/repo", revoke: false },
    ...overrides,
  };
}

async function auditRows(correlationId: string) {
  return (await db.query<{ decision: string; reason: string | null; role: string; primary_type: string | null; digest: string | null; chain_id: string | null; replayed: boolean }>("SELECT * FROM signer_audit WHERE correlation_id = $1", [correlationId])).rows;
}

async function refused(p: Promise<unknown>): Promise<{ code: string; reason: string; correlationId: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { code: string; detail?: { reason: string; correlationId: string } };
    return { code: err.code, reason: err.detail?.reason ?? String(e), correlationId: err.detail?.correlationId ?? "" };
  }
  throw new Error("expected a refusal");
}

describe("W05 signing-policy guard: allowlist", () => {
  it("signs the allowlisted typed data, recomputing the digest itself, and audits it", async () => {
    const { g, inner } = await guard("authority");
    const req = bindingOp();
    const r = await g.signTypedData(req, { ...meta, correlationId: "corr-allowed-1" });
    expect(await recoverTypedDataAddress({ ...(req as Parameters<typeof recoverTypedDataAddress>[0]), signature: r.signature })).toBe(g.address);
    expect(inner.calls).toBe(1);
    const rows = await auditRows("corr-allowed-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: "allowed", role: "authority", primary_type: "BindingOp", digest: r.digest });
    expect(String(rows[0]!.chain_id)).toBe("31337");
    const att = await g.signTypedData(
      { domain: launchDomain(chainId, addresses.authorizer), types: eligibilityAttestationTypes, primaryType: "EligibilityAttestation", message: { githubRepoId: 1n, creator: zeroAddress, bindingEpoch: 1n, issuedAt: 1n, expiresAt: 2n } },
      meta,
    );
    expect(await recoverAddress({ hash: att.digest, signature: att.signature })).toBe(g.address);
  }, T);

  it("refuses wrong chain, chain 4663, wrong contract, wrong type, look-alike types, extra domain/message fields — custody is never called", async () => {
    const { g, inner } = await guard("authority");
    const cases: [string, TypedDataRequest, RegExp][] = [
      ["wrong chain", bindingOp({ domain: registryDomain(1337, addresses.registry) }), /wrong chain 1337/],
      ["mainnet", bindingOp({ domain: registryDomain(1, addresses.registry) }), /PRODUCTION_SIGNING_ENABLED=false: chain 1/],
      ["robinhood", bindingOp({ domain: registryDomain(4663, addresses.registry) }), /PRODUCTION_SIGNING_ENABLED=false: chain 4663/],
      ["wrong contract", bindingOp({ domain: registryDomain(chainId, addresses.authorizer) }), /wrong verifying contract/],
      ["registry type on the authorizer domain", bindingOp({ domain: launchDomain(chainId, addresses.authorizer) }), /wrong verifying contract|name\/version/],
      ["creator-only type", bindingOp({ primaryType: "LaunchAuthorization", types: launchAuthorizationTypes }), /not allowed for role authority/],
      ["revenue type", bindingOp({ domain: { ...SPLITTER_EIP712_DOMAIN, chainId, verifyingContract: addresses.revenueSplitter }, primaryType: "EligibleRevenue", types: ELIGIBLE_REVENUE_TYPES }), /not allowed for role authority/],
      ["look-alike struct", bindingOp({ types: { BindingOp: bindingOpTypes.BindingOp.map((f) => (f.name === "revoke" ? { name: "revoke", type: "uint8" } : f)) } }), /differ from the canonical/],
      ["salt", bindingOp({ domain: { ...registryDomain(chainId, addresses.registry), salt: keccak256(toBytes("s")) } }), /exactly name, version, chainId, verifyingContract/],
      ["version", bindingOp({ domain: { ...registryDomain(chainId, addresses.registry), version: "1" } }), /name\/version not allowed/],
      ["extra field", { ...bindingOp(), message: { ...bindingOp().message, extra: 1n } }, /fields outside BindingOp/],
      ["malformed", { ...bindingOp(), message: { ...bindingOp().message, creator: "0x1234" } }, /malformed BindingOp/],
    ];
    for (const [name, req, re] of cases) {
      const r = await refused(g.signTypedData(req, meta));
      expect(r.code, name).toBe("SIGNER_DENIED");
      expect(r.reason, name).toMatch(re);
      const rows = await auditRows(r.correlationId);
      expect(rows.map((x) => x.decision), name).toEqual(["denied"]);
    }
    expect((await refused(g.signEip191Hash32(keccak256(toBytes("r")), meta))).reason).toMatch(/EIP-191 payloads are not allowed/);
    expect(inner.calls).toBe(0);
  }, T);

  it("evidence signs only EIP-191 over one 32-byte hash; revenue signs only EligibleRevenue on this splitter", async () => {
    const ev = await guard("evidence");
    const h = keccak256(toBytes("receipt"));
    const r = await ev.g.signEip191Hash32(h, meta);
    expect(r.digest).toBe(hashMessage({ raw: h }));
    expect(await recoverAddress({ hash: r.digest, signature: r.signature })).toBe(ev.g.address);
    expect((await refused(ev.g.signEip191Hash32("0x1234", meta))).reason).toMatch(/exactly 32 bytes/);
    expect((await refused(ev.g.signTypedData(bindingOp(), meta))).reason).toMatch(/not allowed for role evidence/);
    const rev = await guard("revenue");
    const domain = { ...SPLITTER_EIP712_DOMAIN, chainId, verifyingContract: addresses.revenueSplitter };
    const message = { escrow: addresses.registry, factory: addresses.authorizer, asset: zeroAddress, cumulativeEligible: 5n, nonce: 1n, deadline: 9n, evidenceBlock: 3n, evidenceBlockHash: keccak256(toBytes("b")) };
    const ok = await rev.g.signTypedData({ domain, types: ELIGIBLE_REVENUE_TYPES, primaryType: "EligibleRevenue", message }, meta);
    expect(await recoverAddress({ hash: ok.digest, signature: ok.signature })).toBe(rev.g.address);
    const other = getAddress("0x0000000000000000000000000000000000000bad");
    expect((await refused(rev.g.signTypedData({ domain: { ...domain, verifyingContract: other }, types: ELIGIBLE_REVENUE_TYPES, primaryType: "EligibleRevenue", message }, meta))).reason).toMatch(/wrong verifying contract/);
    expect((await refused(rev.g.signTypedData(bindingOp(), meta))).reason).toMatch(/not allowed for role revenue/);
  }, T);
});

describe("W05 signing-policy guard: kill switch, rotation, revocation, verification gate", () => {
  it("DB kill switch (role and 'all') and env kill switch refuse immediately; release restores", async () => {
    const { g, inner } = await guard("authority");
    await engageKillSwitch(db, "authority", "ops", "INC-1 suspected compromise");
    expect((await refused(g.signTypedData(bindingOp(), meta))).reason).toMatch(/kill switch engaged: INC-1/);
    await releaseKillSwitch(db, "authority", "ops", "INC-1 closed");
    await g.signTypedData(bindingOp(), meta);
    await engageKillSwitch(db, "all", "ops", "INC-2 global");
    expect((await refused(g.signTypedData(bindingOp(), meta))).reason).toMatch(/INC-2/);
    await releaseKillSwitch(db, "all", "ops", "INC-2 closed");
    const env = await guard("evidence", { env: ["evidence"] });
    expect((await refused(env.g.signEip191Hash32(keccak256(toBytes("e")), meta))).reason).toMatch(/FORGE_SIGNER_KILL_SWITCH/);
    expect(env.inner.calls).toBe(0);
    expect(inner.calls).toBe(1);
    const alerts = await db.query<{ action: string }>("SELECT action FROM audit_events WHERE action LIKE 'ALERT:signer_kill_switch%'");
    expect(alerts.rows.length).toBeGreaterThanOrEqual(2);
  }, T);

  it("rotation: only the active version signs; retired and revoked never sign; revoked is terminal in the database", async () => {
    // Fresh role namespace: revoke whatever is active for 'revenue' from earlier tests.
    const v1 = await guard("revenue", { enroll: false });
    const prior = await db.query<{ address: Address }>("SELECT address FROM signer_keys WHERE role = 'revenue' AND status = 'active'");
    for (const p of prior.rows) await revokeSignerKey(db, "revenue", p.address, "test", "reset");
    expect((await enrollConfiguredKey(db, "revenue", v1.g.address, "local-test", null)).ok).toBe(true);
    const domain = { ...SPLITTER_EIP712_DOMAIN, chainId, verifyingContract: addresses.revenueSplitter };
    let n = 100n;
    const req = () => ({ domain, types: ELIGIBLE_REVENUE_TYPES, primaryType: "EligibleRevenue", message: { escrow: addresses.registry, factory: addresses.authorizer, asset: zeroAddress, cumulativeEligible: n, nonce: n++, deadline: 9n, evidenceBlock: 3n, evidenceBlockHash: keccak256(toBytes("b")) } });
    await v1.g.signTypedData(req(), meta);

    const v2 = await guard("revenue", { enroll: false });
    // A new key while v1 is active is NOT auto-enrolled: rotation is explicit.
    const pre = await enrollConfiguredKey(db, "revenue", v2.g.address, "local-test", null);
    expect(pre.ok).toBe(false);
    expect((await refused(v2.g.signTypedData(req(), meta))).reason).toMatch(/not enrolled/);
    const version = await rotateSignerKey(db, "revenue", { address: v2.g.address, custody: "kms", keyRef: "arn:aws:kms:us-east-1:111122223333:key/v2" }, "ops", "scheduled rotation");
    expect(version).toBeGreaterThan(1);
    expect((await refused(v1.g.signTypedData(req(), meta))).reason).toMatch(/is retired/);
    const ok = await v2.g.signTypedData(req(), meta);
    expect(ok.keyVersion).toBe(version);

    await revokeSignerKey(db, "revenue", v2.g.address, "ops", "INC-3 attestor compromised");
    expect((await refused(v2.g.signTypedData(req(), meta))).reason).toMatch(/is revoked/);
    await expect(db.query("UPDATE signer_keys SET status = 'active' WHERE address = $1", [v2.g.address])).rejects.toThrow(/never be reinstated/);
    await expect(db.query("UPDATE signer_keys SET status = 'active' WHERE address = $1", [v1.g.address])).rejects.toThrow(/never be reactivated/);
    await expect(db.query("DELETE FROM signer_keys WHERE address = $1", [v2.g.address])).rejects.toThrow(/never deleted/);
    // A revoked key can never be re-enrolled, even after restart.
    expect((await enrollConfiguredKey(db, "revenue", v2.g.address, "kms", null)).ok).toBe(false);
    // An address belongs to exactly one role, ever.
    expect((await enrollConfiguredKey(db, "authority", v1.g.address, "local-test", null)).ok).toBe(false);
  }, T);

  it("a disabled role (registry verification gate) refuses before custody", async () => {
    const { g, inner } = await guard("authority", { gate: async () => "custody address ≠ configured expected address" });
    expect((await refused(g.signTypedData(bindingOp(), meta))).reason).toMatch(/role disabled: custody address/);
    expect(inner.calls).toBe(0);
  }, T);
});

describe("W05 signing-policy guard: rate limit, replay/concurrency, failures, audit immutability", () => {
  it("per-role rate limit", async () => {
    const { g } = await guard("evidence", { rate: 3 });
    // The window is per role: earlier evidence signs in this hour's window count too.
    const windowStart = Math.floor(Date.now() / 1000 / 3600) * 3600;
    const used = (await db.query<{ count: number }>("SELECT coalesce(sum(count),0)::int AS count FROM rate_limits WHERE key = 'signer:evidence' AND window_start = $1", [windowStart])).rows[0]!.count;
    for (let i = used; i < 3; i++) await g.signEip191Hash32(keccak256(toBytes(`rl-${i}`)), meta);
    const r = await refused(g.signEip191Hash32(keccak256(toBytes("rl-over")), meta));
    expect(r.code).toBe("RATE_LIMITED");
    expect((await auditRows(r.correlationId))[0]!.decision).toBe("denied");
  }, T);

  it("concurrent identical requests produce ONE custody signature; repeats return it; idempotency keys bind one payload", async () => {
    const kms = new FakeAwsKms("alternate");
    const keyId = fakeKeyArn();
    kms.add(keyId, generatePrivateKey());
    const kmsSigner = await KmsDigestSigner.create("authority", awsKmsBackend(kms, keyId), { chainId });
    const { g, inner } = await guard("authority", { inner: kmsSigner, delayMs: 150 });
    const req = bindingOp();
    const results = await Promise.all(Array.from({ length: 5 }, () => g.signTypedData(req, meta)));
    expect(inner.calls).toBe(1);
    expect(kms.signCalls.length).toBe(1);
    expect(new Set(results.map((r) => r.signature)).size).toBe(1);
    expect(results.filter((r) => r.replayed).length).toBe(4);
    const again = await g.signTypedData(req, meta);
    expect(again.replayed).toBe(true);
    expect(inner.calls).toBe(1);
    const rows = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM signer_signatures WHERE role = 'authority' AND digest = $1", [results[0]!.digest]);
    expect(rows.rows[0]!.n).toBe("1");

    const a = await g.signTypedData(bindingOp(), { ...meta, idempotencyKey: "job-77" });
    expect(a.replayed).toBe(false);
    const r = await refused(g.signTypedData(bindingOp(), { ...meta, idempotencyKey: "job-77" }));
    expect(r.code).toBe("IDEMPOTENCY_KEY_REUSED");
  }, T);

  it("a custody failure is audited as failed, releases the claim, and a retry signs", async () => {
    const { g, inner } = await guard("authority");
    inner.fail = true;
    const req = bindingOp();
    await expect(g.signTypedData(req, { ...meta, correlationId: "corr-fail-1" })).rejects.toThrow(/ThrottlingException/);
    expect((await auditRows("corr-fail-1")).map((x) => x.decision)).toEqual(["failed"]);
    inner.fail = false;
    const ok = await g.signTypedData(req, meta);
    expect(ok.replayed).toBe(false);
    expect(inner.calls).toBe(2);
  }, T);

  it("signer_audit is append-only", async () => {
    await expect(db.query("UPDATE signer_audit SET decision = 'allowed'")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM signer_audit")).rejects.toThrow(/append-only/);
    const counts = await db.query<{ decision: string; n: string }>("SELECT decision, count(*)::text AS n FROM signer_audit GROUP BY decision ORDER BY decision");
    expect(counts.rows.map((r) => r.decision)).toEqual(["allowed", "denied", "failed"]);
  }, T);
});
