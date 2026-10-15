/**
 * W05 signer custody over the REAL Forge stack on a standard Anvil, with
 * every custody role (eligibility authority, evidence, revenue attestor)
 * held by a FAKE AWS KMS (DER signatures, deliberately high-s half the time,
 * OpenSSL SPKI public keys). No real KMS is exercised. Proves:
 *   - KMS-signed BindingOp / EligibilityAttestation verify in
 *     ForgeBindingRegistry / ForgeLaunchAuthorizer (a real launch), KMS-signed
 *     EligibleRevenue verifies in ForgeProtocolRevenueSplitter, KMS-signed
 *     Proof-of-Build receipts recover to the evidence key;
 *   - startup verification fails closed (expected address, on-chain holder,
 *     external treasury/governance keys, key overlap, non-dev chains);
 *   - the revenue-attestor incident sequence: registry revocation stops new
 *     signatures immediately; on-chain revokeRevenueAttestor() is ATOMIC
 *     (PR #5 Correction A): it clears the attestor, discards any pending
 *     rotation AND pauses pulls, so already-authorized headroom cannot be
 *     drained; claims keep working.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress, hashMessage, parseEther, recoverAddress, zeroAddress, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { forgeProtocolRevenueSplitterAbi, ponsV2BondingCurveAbi, ponsV2FeeEscrowAbi } from "@/shared/abis.generated";
import { createAppContext } from "@/server/context";
import { PgliteDb } from "@/server/db";
import { runWorkerOnce } from "@/server/worker";
import { runRevenueAttestation } from "@/server/finance/service";
import { ELIGIBLE_REVENUE_TYPES, SPLITTER_EIP712_DOMAIN, eligibleRevenueDigest, type EligibleRevenueAuth } from "@/server/finance/attestor";
import { awsKmsBackend } from "@/server/signer/kms/aws";
import { KmsDigestSigner } from "@/server/signer/kms/signer";
import { revokeSignerKey } from "@/server/signer/controls";
import { SANDBOX_ROLES } from "../../scripts/sandbox-lib";
import { startSandbox, chainClients, ANVIL_KEYS, type Sandbox } from "../helpers/sandbox";
import { freshScenario, launchThroughApi, governanceWrite } from "../helpers/scenario";
import { FakeAwsKms, fakeKeyArn } from "../helpers/fake-kms";
import { rpc } from "../helpers/anvil";

const NATIVE = zeroAddress as Address;
const BUYER_KEY = ANVIL_KEYS[6];
const STRANGER_KEY = ANVIL_KEYS[7];
const TREASURY_KEY = ANVIL_KEYS[8];

const kms = new FakeAwsKms("alternate");
const ARN = { authority: fakeKeyArn(), evidence: fakeKeyArn(), revenue: fakeKeyArn(), other: fakeKeyArn(), treasury: fakeKeyArn() };
kms.add(ARN.authority, SANDBOX_ROLES.authority).add(ARN.evidence, SANDBOX_ROLES.evidence).add(ARN.revenue, SANDBOX_ROLES.revenueAttestor).add(ARN.other, ANVIL_KEYS[5]).add(ARN.treasury, TREASURY_KEY);
const kmsFactory = (_role: string, keyId: string) => awsKmsBackend(kms, keyId);
const addr = (k: Hex) => privateKeyToAccount(k).address;

const KMS_ENV = {
  FORGE_SIGNER_PROVIDER: "kms",
  FORGE_AUTHORITY_KMS_KEY_ID: ARN.authority,
  FORGE_AUTHORITY_EXPECTED_ADDRESS: addr(SANDBOX_ROLES.authority),
  FORGE_EVIDENCE_KMS_KEY_ID: ARN.evidence,
  FORGE_EVIDENCE_EXPECTED_ADDRESS: addr(SANDBOX_ROLES.evidence),
  FORGE_REVENUE_ATTESTOR_KMS_KEY_ID: ARN.revenue,
  FORGE_REVENUE_ATTESTOR_EXPECTED_ADDRESS: addr(SANDBOX_ROLES.revenueAttestor),
};
const IN_PROCESS_KEYS = ["FORGE_AUTHORITY_PRIVATE_KEY", "FORGE_EVIDENCE_PRIVATE_KEY", "FORGE_REVENUE_ATTESTOR_PRIVATE_KEY"];

let sb: Sandbox;
let splitter: Address;
beforeAll(async () => {
  sb = await startSandbox(KMS_ENV, { kms: kmsFactory, dropEnv: IN_PROCESS_KEYS });
  splitter = sb.deployment.revenueSplitter;
});
afterAll(async () => sb?.stop());

const splitterRead = <T>(functionName: string, args: unknown[] = []) =>
  sb.ctx.client.readContract({ address: splitter, abi: forgeProtocolRevenueSplitterAbi, functionName, args } as never) as Promise<T>;

async function send(key: Hex, address: Address, abi: readonly unknown[], functionName: string, args: unknown[] = [], value = 0n) {
  const { wallet, pub } = chainClients(sb.anvil.url, key);
  const h = await wallet.writeContract({ address, abi, functionName, args, value } as never);
  return (await pub.waitForTransactionReceipt({ hash: h })).status;
}

/** Simulates and returns "OK" or the decoded custom error name. */
async function simulate(key: Hex, address: Address, abi: Abi, functionName: string, args: unknown[]): Promise<string> {
  const { pub, account } = chainClients(sb.anvil.url, key);
  try {
    await pub.simulateContract({ account, address, abi, functionName, args } as never);
    return "OK";
  } catch (e) {
    const err = e as { cause?: { data?: { errorName?: string } }; shortMessage?: string };
    return err.cause?.data?.errorName ?? err.shortMessage ?? String(e);
  }
}

/** Startup outcome as a string (never hand an AppContext to an assertion: it holds a WASM Postgres). */
async function startupError(p: Promise<{ db: { close(): Promise<void> } }>): Promise<string> {
  try {
    const ctx = await p;
    await ctx.db.close();
    return "STARTED";
  } catch (e) {
    return (e as Error).message;
  }
}

async function freshCtx(env: Record<string, string>, drop: string[] = []) {
  const e: Record<string, string> = { ...sb.env, ...env };
  for (const k of drop) delete e[k];
  const db = await PgliteDb.open();
  return createAppContext(e, { db, kms: kmsFactory }).catch(async (err: unknown) => {
    await db.close();
    throw err;
  });
}

describe("W05 startup verification (fail closed)", () => {
  it("all three custody roles come up from the fake KMS, matching expected addresses and on-chain holders", () => {
    const st = Object.fromEntries(sb.ctx.signers.statuses().map((s) => [s.role, s]));
    expect(st.authority).toMatchObject({ enabled: true, custody: "kms", onchain: "verified", keyVersion: 1, address: addr(SANDBOX_ROLES.authority), keyRef: ARN.authority });
    expect(st.evidence).toMatchObject({ enabled: true, custody: "kms", onchain: "not-applicable", address: addr(SANDBOX_ROLES.evidence) });
    expect(st.revenue).toMatchObject({ enabled: true, custody: "kms", onchain: "verified", address: addr(SANDBOX_ROLES.revenueAttestor) });
    expect(sb.ctx.authority.address).toBe(addr(SANDBOX_ROLES.authority));
  });

  it("expected-address mismatch disables that role (logged), other roles keep working", async () => {
    const ctx = await freshCtx({ FORGE_EVIDENCE_EXPECTED_ADDRESS: addr(ANVIL_KEYS[9]) }, IN_PROCESS_KEYS);
    expect(ctx.signers.status("evidence")).toMatchObject({ enabled: false, reason: expect.stringMatching(/≠ configured expected address/) });
    expect(ctx.signers.status("authority")!.enabled).toBe(true);
    await expect(ctx.evidenceSigner.signEip191Hash32(`0x${"11".repeat(32)}`, { requestedBy: "test" })).rejects.toMatchObject({ code: "SIGNER_DENIED" });
    const alerts = await ctx.db.query<{ subject: string }>("SELECT subject FROM audit_events WHERE action = 'ALERT:signer_role_disabled'");
    expect(alerts.rows.map((r) => r.subject)).toEqual(["evidence"]);
    await ctx.db.close();
  });

  it("an attestor key that is not the splitter's on-chain revenueAttestor is disabled and attestation reports DISABLED", async () => {
    const ctx = await freshCtx({ FORGE_REVENUE_ATTESTOR_KMS_KEY_ID: ARN.other, FORGE_REVENUE_ATTESTOR_EXPECTED_ADDRESS: addr(ANVIL_KEYS[5]) }, IN_PROCESS_KEYS);
    expect(ctx.signers.status("revenue")).toMatchObject({ enabled: false, onchain: "mismatch", reason: expect.stringMatching(/splitter revenueAttestor .* ≠ custody address/) });
    const out = await runRevenueAttestation(ctx);
    expect(out[0]).toMatchObject({ status: "DISABLED" });
    await ctx.db.close();
  });

  it("a server key equal to an external treasury/governance address refuses startup", async () => {
    // Relayer = the governance owner key.
    expect(await startupError(freshCtx({ FORGE_RELAYER_PRIVATE_KEY: SANDBOX_ROLES.governance }, IN_PROCESS_KEYS))).toMatch(/custody violation.*relayer.*owner/);
    // Evidence key = the splitter's treasury recipient.
    expect(await startupError(freshCtx({ FORGE_EVIDENCE_KMS_KEY_ID: ARN.treasury, FORGE_EVIDENCE_EXPECTED_ADDRESS: addr(TREASURY_KEY) }, IN_PROCESS_KEYS))).toMatch(/custody violation.*evidence.*treasury recipient/);
  });

  it("overlapping server keys, non-dev chains, missing KMS backend and in-process keys under kms are refused", async () => {
    expect(await startupError(freshCtx({ FORGE_REVENUE_ATTESTOR_KMS_KEY_ID: ARN.authority, FORGE_REVENUE_ATTESTOR_EXPECTED_ADDRESS: addr(SANDBOX_ROLES.authority) }, IN_PROCESS_KEYS))).toMatch(/must be distinct/);
    expect(await startupError(freshCtx({ FORGE_CHAIN_ID: "11155111" }, IN_PROCESS_KEYS))).toMatch(/PRODUCTION_BLOCKED: FORGE_SIGNER_PROVIDER=kms is refused for chain 11155111/);
    expect(await startupError(freshCtx({ FORGE_AUTHORITY_PRIVATE_KEY: SANDBOX_ROLES.authority }))).toMatch(/private keys must not be configured/);
    const e: Record<string, string> = { ...sb.env };
    for (const k of IN_PROCESS_KEYS) delete e[k];
    const db = await PgliteDb.open();
    expect(await startupError(createAppContext(e, { db }))).toMatch(/no KMS backend is wired/);
    await db.close();
    // Sanity: the same KMS configuration starts.
    expect(await startupError(freshCtx({}, IN_PROCESS_KEYS))).toBe("STARTED");
  });
});

describe("W05 KMS-held keys verify on chain", () => {
  let token: Address;
  let curve: Address;
  let creatorKey: Hex;

  it("a launch with KMS-signed BindingOp + EligibilityAttestation succeeds; the Proof-of-Build receipt is KMS-signed", async () => {
    const before = kms.signCalls.length;
    const sc = await freshScenario(sb);
    creatorKey = sc.key;
    const l = await launchThroughApi(sb, sc.browser, sc.key, sc.draft);
    expect(l.submitted.status).toBe(200);
    token = getAddress(l.submitted.json.token);
    curve = getAddress(l.submitted.json.curve);
    const w = await runWorkerOnce(sb.ctx);
    expect(w.receipts).toContain(token);
    const rcpt = (await sb.ctx.db.query<{ receipt_hash: Hex; signature: Hex; signer: string }>("SELECT receipt_hash, signature, signer FROM evidence_receipts WHERE token = $1", [token])).rows[0]!;
    expect(getAddress(rcpt.signer)).toBe(addr(SANDBOX_ROLES.evidence));
    expect(await recoverAddress({ hash: hashMessage({ raw: rcpt.receipt_hash }), signature: rcpt.signature })).toBe(addr(SANDBOX_ROLES.evidence));
    // BindingOp (registry), EligibilityAttestation (authorizer) and the receipt all went through KMS.
    expect(kms.signCalls.length - before).toBeGreaterThanOrEqual(3);
    expect(kms.highSReturned).toBeGreaterThan(0); // high-s answers were normalised and still accepted on chain
    const audit = await sb.ctx.db.query<{ role: string; primary_type: string; custody: string }>("SELECT role, primary_type, custody FROM signer_audit WHERE decision = 'allowed' AND replayed = false");
    const kinds = new Set(audit.rows.map((r) => `${r.role}:${r.primary_type}:${r.custody}`));
    expect(kinds).toContain("authority:BindingOp:kms");
    expect(kinds).toContain("authority:EligibilityAttestation:kms");
    expect(kinds).toContain("evidence:EIP191(bytes32):kms");
    await rpc(sb.anvil.url, "evm_increaseTime", [20]);
    await rpc(sb.anvil.url, "evm_mine");
  });

  it("a KMS-signed EligibleRevenue ceiling is accepted by splitter.authorizeEligibleRevenue", async () => {
    const buyer = chainClients(sb.anvil.url, BUYER_KEY).account.address;
    expect(await send(BUYER_KEY, curve, ponsV2BondingCurveAbi, "buy", [parseEther("10"), 0n, buyer], parseEther("10"))).toBe("success");
    expect(await send(creatorKey, curve, ponsV2BondingCurveAbi, "sweepFees", [0n])).toBe("success");
    const w = await runWorkerOnce(sb.ctx);
    expect(w.attestations.find((a) => a.status === "AUTHORIZED")).toBeTruthy();
    expect(await splitterRead<bigint>("verifiedHeadroom", [NATIVE])).toBe((parseEther("0.1") * 3_000n) / 10_000n);
    const audit = await sb.ctx.db.query("SELECT 1 FROM signer_audit WHERE role = 'revenue' AND primary_type = 'EligibleRevenue' AND decision = 'allowed' AND custody = 'kms'");
    expect(audit.rows.length).toBe(1);
  });

  it("revenue-attestor incident: registry revocation → on-chain revoke is atomic (clears attestor + pauses pulls) → claims still work", async () => {
    const attestor = addr(SANDBOX_ROLES.revenueAttestor);
    const headroom = await splitterRead<bigint>("verifiedHeadroom", [NATIVE]);
    expect(headroom).toBeGreaterThan(0n);
    // More eligible revenue arrives (unattested yet).
    const buyer = chainClients(sb.anvil.url, BUYER_KEY).account.address;
    await send(BUYER_KEY, curve, ponsV2BondingCurveAbi, "buy", [parseEther("5"), 0n, buyer], parseEther("5"));
    await send(creatorKey, curve, ponsV2BondingCurveAbi, "sweepFees", [0n]);

    // 1. Registry revocation (off-chain, immediate): the next signature is refused BEFORE custody is called.
    await revokeSignerKey(sb.ctx.db, "revenue", attestor, "incident-commander", "INC-W05 drill: attestor suspected compromised");
    const kmsCalls = kms.signCalls.length;
    // The worker indexes the new sweep; its attestation step is refused (logged, never signed).
    const w = await runWorkerOnce(sb.ctx);
    expect(w.attestations).toEqual([]);
    await expect(runRevenueAttestation(sb.ctx)).rejects.toMatchObject({ code: "SIGNER_DENIED", detail: { reason: expect.stringMatching(/is revoked/) } });
    expect(kms.signCalls.length).toBe(kmsCalls);
    expect(await splitterRead<bigint>("verifiedHeadroom", [NATIVE])).toBe(headroom);
    const denied = await sb.ctx.db.query("SELECT 1 FROM signer_audit WHERE role = 'revenue' AND decision = 'denied' AND reason LIKE '%revoked%'");
    expect(denied.rows.length).toBe(2); // the worker's attempt and the direct one, both audited

    // 2. The key itself still exists in custody (a compromised KMS principal could still sign):
    //    its authorization would still be accepted until the on-chain attestor is revoked.
    const rogue = await KmsDigestSigner.create("revenue", awsKmsBackend(kms, ARN.revenue), { chainId: 31337 });
    const live = await splitterRead<{ eligibleCeiling: bigint; authNonce: bigint; escrowClaimed: bigint }>("ledger", [NATIVE]);
    // W05 on-chain cap: a ceiling can reach at most escrow claimed + held. A compromised attestor's
    // best case is therefore "everything currently in escrow for the key" (here: the unattested sweep).
    const held = (await sb.ctx.client.readContract({ address: sb.deployment.feeEscrow, abi: ponsV2FeeEscrowAbi, functionName: "balanceOf", args: [splitter] })) as bigint;
    const head = await sb.ctx.client.getBlock({ blockTag: "latest" });
    const evidence = await sb.ctx.client.getBlock({ blockNumber: head.number - 1n });
    const auth: EligibleRevenueAuth = {
      escrow: sb.deployment.feeEscrow,
      factory: sb.deployment.factory,
      asset: NATIVE,
      cumulativeEligible: live.escrowClaimed + held,
      nonce: live.authNonce + 1n,
      deadline: head.timestamp + 600n,
      evidenceBlock: evidence.number,
      evidenceBlockHash: evidence.hash,
    };
    const rogueSig = await rogue.signDigest(eligibleRevenueDigest(31337, splitter, auth));
    expect(await simulate(STRANGER_KEY, splitter, forgeProtocolRevenueSplitterAbi, "authorizeEligibleRevenue", [auth, rogueSig])).toBe("OK");

    // Part of the authorized headroom is pulled BEFORE the incident (so a treasury liability exists to claim afterwards).
    const half = headroom / 2n;
    expect(await send(STRANGER_KEY, splitter, forgeProtocolRevenueSplitterAbi, "pullRevenue", [NATIVE, half])).toBe("success");

    // 3. Governance: revokeRevenueAttestor() — new ceilings are now impossible on chain …
    await governanceWrite(sb, splitter, forgeProtocolRevenueSplitterAbi as Abi, "revokeRevenueAttestor", []);
    expect(await splitterRead<Address>("revenueAttestor")).toBe(zeroAddress);
    expect(await simulate(STRANGER_KEY, splitter, forgeProtocolRevenueSplitterAbi, "authorizeEligibleRevenue", [auth, rogueSig])).toBe("AttestorNotSet");

    // … and (Correction A) the SAME transaction paused pulls: the ALREADY-AUTHORIZED headroom is not erased
    // but nobody can drain it.
    expect(await splitterRead<boolean>("pullsPaused")).toBe(true);
    expect(await splitterRead<bigint>("verifiedHeadroom", [NATIVE])).toBe(headroom - half);
    expect(await simulate(STRANGER_KEY, splitter, forgeProtocolRevenueSplitterAbi, "pullRevenue", [NATIVE, headroom - half])).toBe("PullsPaused");
    expect(await simulate(STRANGER_KEY, splitter, forgeProtocolRevenueSplitterAbi, "pullRevenue", [NATIVE, 0n])).toBe("PullsPaused");

    // 5. Claims are unaffected by the pause: the treasury claims its allocation, the creator claims escrow fees.
    const liability = await splitterRead<bigint>("treasuryLiability", [NATIVE]);
    expect(liability).toBeGreaterThan(0n);
    expect(await send(TREASURY_KEY, splitter, forgeProtocolRevenueSplitterAbi, "claimTreasury", [NATIVE, 0n])).toBe("success");
    expect(await splitterRead<bigint>("treasuryLiability", [NATIVE])).toBe(0n);
    const creator = privateKeyToAccount(creatorKey).address;
    const owed = (await sb.ctx.client.readContract({ address: sb.deployment.feeEscrow, abi: ponsV2FeeEscrowAbi, functionName: "balanceOf", args: [creator] })) as bigint;
    expect(owed).toBeGreaterThan(0n);
    expect(await send(creatorKey, sb.deployment.feeEscrow, ponsV2FeeEscrowAbi, "claim", [])).toBe("success");

    // The off-chain attestor now reports the on-chain revocation instead of signing.
    const after = await runRevenueAttestation(sb.ctx);
    expect(after[0]).toMatchObject({ status: "ATTESTOR_MISMATCH" });
    // Sanity: the guard-typed request the attestor would have made is also refused directly.
    await expect(
      sb.ctx.revenueAttestor!.signTypedData({ domain: { ...SPLITTER_EIP712_DOMAIN, chainId: 31337, verifyingContract: splitter }, types: ELIGIBLE_REVENUE_TYPES, primaryType: "EligibleRevenue", message: { ...auth } }, { requestedBy: "test" }),
    ).rejects.toMatchObject({ code: "SIGNER_DENIED" });
  });
});
