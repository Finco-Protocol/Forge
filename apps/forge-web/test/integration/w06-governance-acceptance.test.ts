/**
 * W06 KMS / governance acceptance — a consolidated rehearsal on a LOCAL Anvil.
 *
 * Custody = the W05 FAKE AWS KMS (no real KMS, SANDBOX_NOT_EVIDENCE for B-class
 * custody items); governance = the genuine Safe 1.5.0 (2-of-3) + OpenZeppelin
 * TimelockController (2 days) from W05, owning the real Forge contracts.
 * Test keys only; production signing stays refused.
 *
 * Proves, against the REAL chain (not a stub):
 *   1. the five roles are separated (authority / evidence / revenue attestor /
 *      relayer server-side; treasury + governance external);
 *   2. signing fails CLOSED when the RPC is unavailable, before ANY custody call;
 *   3. an on-chain authority rotation executed by Safe→Timelock refuses the old
 *      KMS key on the very next request; the documented rotation procedure
 *      (add key → rotateSignerKey → on-chain change → restart) restores service;
 *   4. emergency key revocation is immediate and independent of the chain;
 *   5. revenue-attestor revocation + replacement (timelocked) works, pulls stay
 *      paused until an explicit governed unpause;
 *   6. a treasury recipient rotated into a server key trips the sticky custody
 *      violation on every role;
 *   7. production signing is refused.
 */
import { createServer, request as httpRequest, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, getAddress, http, keccak256, toBytes, toHex, zeroAddress, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { forgeBindingRegistryAbi, forgeLaunchAuthorizerAbi, forgeProtocolRevenueSplitterAbi } from "@/shared/abis.generated";
import { createAppContext, type AppContext } from "@/server/context";
import { PgliteDb, type Db } from "@/server/db";
import { PRODUCTION_SIGNING_ENABLED, PRODUCTION_BLOCKED, REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED, buildConfig } from "@/server/config";
import { engageKillSwitch, releaseKillSwitch, revokeSignerKey, rotateSignerKey } from "@/server/signer/controls";
import { awsKmsBackend } from "@/server/signer/kms/aws";
import { KmsDigestSigner } from "@/server/signer/kms/signer";
import { LocalTestDigestSigner } from "@/server/signer/local";
import { ELIGIBLE_REVENUE_TYPES, SPLITTER_EIP712_DOMAIN } from "@/server/finance/attestor";
import { bindingOpTypes, registryDomain } from "@/shared/forge-typed-data";
import { SANDBOX_ROLES } from "../../scripts/sandbox-lib";
import { batchId, deployGovernance, executeBatchData, OWNED_CONTRACTS, ownershipTransferBundle, safeAbi, safeExec, scheduleBatchData, timelockAbi, type Call, type OwnedContract } from "../../scripts/w05/governance";
import { startSandbox, ANVIL_KEYS, type Sandbox } from "../helpers/sandbox";
import { FakeAwsKms, fakeKeyArn } from "../helpers/fake-kms";
import { rpc } from "../helpers/anvil";

const DELAY = 2n * 24n * 3600n;
const SAFE_OWNER_KEYS = [ANVIL_KEYS[5], ANVIL_KEYS[6], ANVIL_KEYS[7]] as Hex[];
const SAFE_RELAYER_KEY = ANVIL_KEYS[9] as Hex;
const addr = (k: Hex) => privateKeyToAccount(k).address;

// ── custody: one fake KMS, one key per role plus spare keys for rotations ──
const kms = new FakeAwsKms("alternate");
const ARN = { authority: fakeKeyArn(), evidence: fakeKeyArn(), revenue: fakeKeyArn(), authority2: fakeKeyArn(), revenue2: fakeKeyArn() };
const SPARE = { authority2: generatePrivateKey(), revenue2: generatePrivateKey() };
kms.add(ARN.authority, SANDBOX_ROLES.authority).add(ARN.evidence, SANDBOX_ROLES.evidence).add(ARN.revenue, SANDBOX_ROLES.revenueAttestor).add(ARN.authority2, SPARE.authority2).add(ARN.revenue2, SPARE.revenue2);
const kmsFactory = (_role: string, keyId: string) => awsKmsBackend(kms, keyId);
const KMS_ENV = {
  FORGE_SIGNER_PROVIDER: "kms",
  FORGE_AUTHORITY_KMS_KEY_ID: ARN.authority,
  FORGE_AUTHORITY_EXPECTED_ADDRESS: addr(SANDBOX_ROLES.authority),
  FORGE_EVIDENCE_KMS_KEY_ID: ARN.evidence,
  FORGE_EVIDENCE_EXPECTED_ADDRESS: addr(SANDBOX_ROLES.evidence),
  FORGE_REVENUE_ATTESTOR_KMS_KEY_ID: ARN.revenue,
  FORGE_REVENUE_ATTESTOR_EXPECTED_ADDRESS: addr(SANDBOX_ROLES.revenueAttestor),
  FORGE_RELAYER_EXPECTED_ADDRESS: addr(SANDBOX_ROLES.relayer),
};
const IN_PROCESS_KEYS = ["FORGE_AUTHORITY_PRIVATE_KEY", "FORGE_EVIDENCE_PRIVATE_KEY", "FORGE_REVENUE_ATTESTOR_PRIVATE_KEY"];

let sb: Sandbox;
let pub: PublicClient;
let safeRelayer: WalletClient;
let gov: { safe: Address; timelock: Address };
let owned: Record<OwnedContract, Address>;
let proxy: { server: Server; url: string; up: boolean };
let n = 0;

const chainDef = (url: string) => defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } });
const wallet = (key: Hex) => createWalletClient({ chain: chainDef(sb.anvil.url), transport: http(sb.anvil.url), account: privateKeyToAccount(key) });
const meta = () => ({ requestedBy: "w06-test", correlationId: `w06-${++n}` });

/** A JSON-RPC pass-through we can switch off (a real network outage between the app and its RPC). */
async function startRpcProxy(target: string) {
  const t = new URL(target);
  const p = { server: undefined as unknown as Server, url: "", up: true };
  p.server = createServer((req, res) => {
    if (!p.up) {
      req.socket.destroy();
      return;
    }
    const upstream = httpRequest({ host: t.hostname, port: t.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>((r) => p.server.listen(0, "127.0.0.1", r));
  p.url = `http://127.0.0.1:${(p.server.address() as { port: number }).port}`;
  return p;
}

async function ctxFor(env: Record<string, string>, opts: { db?: Db } = {}): Promise<AppContext> {
  const e: Record<string, string> = { ...sb.env, ...KMS_ENV, ...env };
  for (const k of IN_PROCESS_KEYS) delete e[k];
  return createAppContext(e, { db: opts.db ?? (await PgliteDb.open()), kms: kmsFactory });
}

const bindingOp = (c: AppContext) =>
  c.signers.guarded("authority")!.signTypedData(
    {
      domain: registryDomain(31337, sb.deployment.registry),
      types: bindingOpTypes,
      primaryType: "BindingOp",
      message: { githubRepoId: BigInt(++n), creator: getAddress(`0x${(0x4000 + n).toString(16).padStart(40, "0")}`), bindingExpiresAt: 4_000_000_000n, opDeadline: 4_000_000_000n, opNonce: BigInt(n), parentOpDigest: `0x${"00".repeat(32)}`, repoFullName: "o/r", revoke: false },
    },
    meta(),
  );
const eligibleRevenue = (c: AppContext) =>
  c.signers.guarded("revenue")!.signTypedData(
    {
      domain: { ...SPLITTER_EIP712_DOMAIN, chainId: 31337, verifyingContract: sb.deployment.revenueSplitter },
      types: ELIGIBLE_REVENUE_TYPES,
      primaryType: "EligibleRevenue",
      message: { escrow: sb.deployment.feeEscrow, factory: sb.deployment.factory, asset: zeroAddress, cumulativeEligible: BigInt(++n), nonce: BigInt(n), deadline: 4_000_000_000n, evidenceBlock: 1n, evidenceBlockHash: keccak256(toBytes(`b${n}`)) },
    },
    meta(),
  );
const evidenceSig = (c: AppContext) => c.signers.guarded("evidence")!.signEip191Hash32(keccak256(toBytes(`e${++n}`)), meta());

async function warp(seconds: bigint) {
  await rpc(sb.anvil.url, "evm_increaseTime", [Number(seconds)]);
  await rpc(sb.anvil.url, "evm_mine");
}
/** Safe(2-of-3) → Timelock(2d): schedule, prove it is NOT executable early, wait, execute. */
async function governed(calls: Call[], label: string, opts: { onPending?: () => Promise<void> } = {}) {
  const salt = keccak256(toHex(`${label}-${++n}`));
  await safeExec(pub, safeRelayer, gov.safe, { to: gov.timelock, value: 0n, data: scheduleBatchData(calls, salt, DELAY) }, SAFE_OWNER_KEYS.slice(0, 2));
  await expect(safeExec(pub, safeRelayer, gov.safe, { to: gov.timelock, value: 0n, data: executeBatchData(calls, salt) }, SAFE_OWNER_KEYS.slice(0, 2))).rejects.toThrow();
  await opts.onPending?.();
  await warp(DELAY);
  expect(await pub.readContract({ address: gov.timelock, abi: timelockAbi, functionName: "isOperationReady", args: [batchId(calls, salt)] })).toBe(true);
  await safeExec(pub, safeRelayer, gov.safe, { to: gov.timelock, value: 0n, data: executeBatchData(calls, salt) }, SAFE_OWNER_KEYS.slice(0, 2));
}
const call = (target: Address, abi: readonly unknown[], functionName: string, args: unknown[], label: string): Call => ({ target, value: 0n, data: encodeFunctionData({ abi, functionName, args } as never), label });

const splitterRead = <T>(functionName: string, args: unknown[] = []) =>
  sb.ctx.client.readContract({ address: sb.deployment.revenueSplitter, abi: forgeProtocolRevenueSplitterAbi, functionName, args } as never) as Promise<T>;

beforeAll(async () => {
  sb = await startSandbox(KMS_ENV, { kms: kmsFactory, dropEnv: IN_PROCESS_KEYS });
  pub = createPublicClient({ transport: http(sb.anvil.url), pollingInterval: 100 }) as PublicClient;
  safeRelayer = wallet(SAFE_RELAYER_KEY);
  proxy = await startRpcProxy(sb.anvil.url);
}, 240_000);
afterAll(async () => {
  proxy?.server.close();
  await sb?.stop();
});

describe("W06 roles: five custody roles are strictly separated", () => {
  it("authority, evidence, revenue attestor and relayer are four distinct server addresses; treasury and governance are external to all of them", async () => {
    const st = Object.fromEntries(sb.ctx.signers.statuses().map((s) => [s.role, s]));
    const server = [st.authority!.address, st.evidence!.address, st.revenue!.address, addr(SANDBOX_ROLES.relayer)].map((a) => getAddress(a as string));
    expect(new Set(server).size).toBe(4);
    for (const r of ["authority", "evidence", "revenue"] as const) expect(st[r]).toMatchObject({ enabled: true, custody: "kms" });
    const external = [
      await splitterRead<Address>("treasuryRecipient"),
      await splitterRead<Address>("owner"),
      (await pub.readContract({ address: sb.deployment.registry, abi: forgeBindingRegistryAbi, functionName: "owner" })) as Address,
      (await pub.readContract({ address: sb.deployment.authorizer, abi: forgeLaunchAuthorizerAbi, functionName: "owner" })) as Address,
    ].map(getAddress);
    for (const e of external) expect(server).not.toContain(e);
  });

  it("the relayer is not a custody role: it has no guard and cannot produce typed-data signatures through the registry", () => {
    expect(sb.ctx.signers.guarded("relayer" as never)).toBeNull();
    for (const r of ["authority", "evidence", "revenue"] as const) {
      const g = sb.ctx.signers.guarded(r) as unknown as Record<string, unknown>;
      expect("signDigest" in g, `${r} exposes no raw digest signer`).toBe(false);
    }
  });

  it("an address can be enrolled for exactly one role, durably (UNIQUE signer_keys.address)", async () => {
    const authorityAddr = addr(SANDBOX_ROLES.authority);
    await expect(rotateSignerKey(sb.ctx.db, "evidence", { address: authorityAddr, custody: "kms", keyRef: ARN.authority }, "w06", "attempted reuse")).rejects.toThrow();
    // the evidence role is unaffected
    await expect(evidenceSig(sb.ctx)).resolves.toBeDefined();
  });

  it("cross-role signing is refused by the allowlist BEFORE custody is called", async () => {
    const calls = kms.signCalls.length;
    const authorityGuard = sb.ctx.signers.guarded("authority")!;
    const revenueGuard = sb.ctx.signers.guarded("revenue")!;
    const evidenceGuard = sb.ctx.signers.guarded("evidence")!;
    await expect(authorityGuard.signTypedData({ domain: { ...SPLITTER_EIP712_DOMAIN, chainId: 31337, verifyingContract: sb.deployment.revenueSplitter }, types: ELIGIBLE_REVENUE_TYPES, primaryType: "EligibleRevenue", message: { escrow: sb.deployment.feeEscrow, factory: sb.deployment.factory, asset: zeroAddress, cumulativeEligible: 1n, nonce: 1n, deadline: 4_000_000_000n, evidenceBlock: 1n, evidenceBlockHash: keccak256(toBytes("x")) } }, meta())).rejects.toMatchObject({ code: "SIGNER_DENIED" });
    await expect(revenueGuard.signTypedData({ domain: registryDomain(31337, sb.deployment.registry), types: bindingOpTypes, primaryType: "BindingOp", message: { githubRepoId: 1n, creator: zeroAddress, bindingExpiresAt: 4_000_000_000n, opDeadline: 4_000_000_000n, opNonce: 1n, parentOpDigest: `0x${"00".repeat(32)}`, repoFullName: "o/r", revoke: false } }, meta())).rejects.toMatchObject({ code: "SIGNER_DENIED" });
    await expect(evidenceGuard.signTypedData({ domain: registryDomain(31337, sb.deployment.registry), types: bindingOpTypes, primaryType: "BindingOp", message: { githubRepoId: 1n, creator: zeroAddress, bindingExpiresAt: 4_000_000_000n, opDeadline: 4_000_000_000n, opNonce: 1n, parentOpDigest: `0x${"00".repeat(32)}`, repoFullName: "o/r", revoke: false } }, meta())).rejects.toMatchObject({ code: "SIGNER_DENIED" });
    expect(kms.signCalls.length).toBe(calls);
  });

  it("a server key equal to the governance owner or the treasury recipient refuses startup (real chain values)", async () => {
    await expect(ctxFor({ FORGE_RELAYER_PRIVATE_KEY: SANDBOX_ROLES.governance, FORGE_RELAYER_EXPECTED_ADDRESS: addr(SANDBOX_ROLES.governance) })).rejects.toThrow(/custody violation.*relayer.*owner/);
    await expect(ctxFor({ FORGE_RELAYER_PRIVATE_KEY: SANDBOX_ROLES.treasury, FORGE_RELAYER_EXPECTED_ADDRESS: addr(SANDBOX_ROLES.treasury) })).rejects.toThrow(/custody violation.*relayer.*treasury recipient/);
  });
});

describe("W06 signing fails CLOSED when the RPC is unavailable (before any custody call)", () => {
  it("a network outage between the app and its RPC refuses authority, revenue and evidence signing with zero KMS calls; service resumes with the network", async () => {
    const c = await ctxFor({ FORGE_RPC_URL: proxy.url });
    await expect(bindingOp(c)).resolves.toBeDefined();
    await expect(eligibleRevenue(c)).resolves.toBeDefined();
    await expect(evidenceSig(c)).resolves.toBeDefined();

    proxy.up = false;
    const calls = kms.signCalls.length;
    await expect(bindingOp(c)).rejects.toThrow(/fail closed/);
    await expect(eligibleRevenue(c)).rejects.toThrow(/fail closed/);
    await expect(evidenceSig(c)).rejects.toThrow(/fail closed/);
    expect(kms.signCalls.length, "no custody call was made while the chain was unreadable").toBe(calls);
    const denied = await c.db.query("SELECT 1 FROM signer_audit WHERE decision = 'denied' AND reason ILIKE '%fail closed%'");
    expect(denied.rows.length).toBeGreaterThanOrEqual(3);

    proxy.up = true;
    await expect(bindingOp(c)).resolves.toBeDefined(); // fresh validation, nothing assumed
    expect(kms.signCalls.length).toBeGreaterThan(calls);
    await c.db.close();
  });

  it("an app that cannot reach its RPC AT STARTUP leaves roles unverified and signs nothing", async () => {
    proxy.up = false;
    const calls = kms.signCalls.length; // captured BEFORE the startup attempt: a Sign made during startup must be caught too
    let c: AppContext | null = null;
    try {
      c = await ctxFor({ FORGE_RPC_URL: proxy.url });
    } catch {
      /* refusing to start is also fail-closed */
    }
    if (c) {
      await expect(bindingOp(c)).rejects.toThrow();
      await c.db.close();
    }
    expect(kms.signCalls.length).toBe(calls); // zero custody calls: not at startup, not on the post-startup request
    proxy.up = true;
  });
});

describe("W06 governance: Safe 2-of-3 + 2-day Timelock owns the Forge contracts; rotations are real on-chain transactions", () => {
  it("setup: ownership of all 7 Forge contracts is handed to the Timelock (genuine Safe, genuine Timelock)", async () => {
    gov = await deployGovernance(pub, wallet(ANVIL_KEYS[0] as Hex), { owners: SAFE_OWNER_KEYS.map(addr), threshold: 2, minDelay: DELAY });
    const d = sb.deployment;
    owned = { factory: d.factory, memeHook: d.memeHook, revenueSplitter: d.revenueSplitter, registry: d.registry, authorizer: d.authorizer, buybackVault: d.buybackVault, locker: d.locker };
    const { step1, step2 } = ownershipTransferBundle(owned, gov.timelock);
    const eoa = wallet(ANVIL_KEYS[0] as Hex);
    for (const c of step1) await pub.waitForTransactionReceipt({ hash: await eoa.sendTransaction({ to: c.target, data: c.data, chain: eoa.chain, account: eoa.account! }) });
    await governed(step2, "accept-ownership");
    expect(await pub.readContract({ address: gov.safe, abi: safeAbi, functionName: "getThreshold" })).toBe(2n);
    expect(await splitterRead<Address>("owner")).toBe(gov.timelock);
    expect(OWNED_CONTRACTS.length).toBe(7);
    // The custody check still passes with the Timelock as owner: signing continues.
    await expect(bindingOp(sb.ctx)).resolves.toBeDefined();
  });

  it("authority rotation via Safe→Timelock: old KMS key is accepted during the delay, refused on the very next request after execution (zero custody calls); the documented rotation procedure restores service", async () => {
    const newAuthority = addr(SPARE.authority2);
    const calls = [
      call(sb.deployment.registry, forgeBindingRegistryAbi, "setEligibilityAuthority", [newAuthority], "registry.setEligibilityAuthority(new)"),
      call(sb.deployment.authorizer, forgeLaunchAuthorizerAbi, "setEligibilityAuthority", [newAuthority], "authorizer.setEligibilityAuthority(new)"),
    ];
    await governed(calls, "rotate-authority", {
      // The delay window is real: the compromised/old key is still the on-chain authority and signs.
      onPending: async () => void (await expect(bindingOp(sb.ctx)).resolves.toBeDefined()),
    });
    const k = kms.signCalls.length;
    await expect(bindingOp(sb.ctx)).rejects.toThrow(/eligibilityAuthority/);
    expect(kms.signCalls.length).toBe(k);
    expect(sb.ctx.signers.status("authority")).toMatchObject({ enabled: false, onchain: "mismatch" });
    await expect(evidenceSig(sb.ctx)).resolves.toBeDefined(); // other roles keep working

    // Procedure: (1) key exists in custody (2) rotateSignerKey (3) on-chain change (done above) (4) restart with the new key id.
    await rotateSignerKey(sb.ctx.db, "authority", { address: newAuthority, custody: "kms", keyRef: ARN.authority2 }, "w06-operator", "scheduled rotation drill");
    const restarted = await ctxFor({ FORGE_AUTHORITY_KMS_KEY_ID: ARN.authority2, FORGE_AUTHORITY_EXPECTED_ADDRESS: newAuthority }, { db: sb.ctx.db });
    expect(restarted.signers.status("authority")).toMatchObject({ enabled: true, onchain: "verified", address: newAuthority, keyVersion: 2 });
    await expect(bindingOp(restarted)).resolves.toBeDefined();
    await expect(bindingOp(sb.ctx)).rejects.toThrow(); // the old process/key stays refused

    // Emergency revocation of the NEW key is immediate and chain-independent: next request refused, no custody call.
    const before = kms.signCalls.length;
    await revokeSignerKey(sb.ctx.db, "authority", newAuthority, "incident-commander", "W06 drill: suspected compromise");
    await expect(bindingOp(restarted)).rejects.toThrow(/is revoked/);
    expect(kms.signCalls.length).toBe(before);
    const alert = await sb.ctx.db.query("SELECT 1 FROM audit_events WHERE action = 'ALERT:signer_key_revoked'");
    expect(alert.rows.length).toBeGreaterThan(0);
  });

  it("kill switch: engaged → every request refused with no custody call; released → service resumes (the evidence role, untouched by the rotation)", async () => {
    const k = kms.signCalls.length;
    await engageKillSwitch(sb.ctx.db, "evidence", "incident-commander", "W06 drill");
    await expect(evidenceSig(sb.ctx)).rejects.toThrow(/kill switch/i);
    expect(kms.signCalls.length).toBe(k);
    await releaseKillSwitch(sb.ctx.db, "evidence", "incident-commander", "drill over");
    await expect(evidenceSig(sb.ctx)).resolves.toBeDefined();
  });

  it("revenue attestor: timelocked on-chain revocation refuses the old key (zero custody calls) and pauses pulls atomically; a NEW proposal + the splitter's own 3-day timelock installs the replacement; pulls stay paused until an explicit governed unpause", async () => {
    await expect(eligibleRevenue(sb.ctx)).resolves.toBeDefined();
    await governed([call(sb.deployment.revenueSplitter, forgeProtocolRevenueSplitterAbi, "revokeRevenueAttestor", [], "splitter.revokeRevenueAttestor()")], "revoke-attestor");
    expect(await splitterRead<Address>("revenueAttestor")).toBe(zeroAddress);
    expect(await splitterRead<boolean>("pullsPaused")).toBe(true);
    const k = kms.signCalls.length;
    await expect(eligibleRevenue(sb.ctx)).rejects.toThrow(/revoked \(address\(0\)\)/);
    expect(kms.signCalls.length).toBe(k);

    // Replacement: governance proposes (delayed), then ANYONE executes after the splitter's own timelock.
    const newAttestor = addr(SPARE.revenue2);
    await governed([call(sb.deployment.revenueSplitter, forgeProtocolRevenueSplitterAbi, "proposeRevenueAttestor", [newAttestor], "splitter.proposeRevenueAttestor(new)")], "propose-attestor");
    const early = chainSim(sb);
    await expect(early.execAttestor()).rejects.toThrow(/TimelockNotElapsed/);
    const lock = await splitterRead<bigint>("RECIPIENT_TIMELOCK");
    await warp(lock + 1n);
    await early.execAttestor();
    expect(await splitterRead<Address>("revenueAttestor")).toBe(newAttestor);
    expect(await splitterRead<boolean>("pullsPaused"), "a healthy replacement does not silently unpause").toBe(true);

    await rotateSignerKey(sb.ctx.db, "revenue", { address: newAttestor, custody: "kms", keyRef: ARN.revenue2 }, "w06-operator", "post-incident replacement");
    const restarted = await ctxFor({ FORGE_REVENUE_ATTESTOR_KMS_KEY_ID: ARN.revenue2, FORGE_REVENUE_ATTESTOR_EXPECTED_ADDRESS: newAttestor }, { db: sb.ctx.db });
    expect(restarted.signers.status("revenue")).toMatchObject({ enabled: true, onchain: "verified", address: newAttestor });
    await expect(eligibleRevenue(restarted)).resolves.toBeDefined();
    await expect(eligibleRevenue(sb.ctx)).rejects.toThrow(); // the revoked key never comes back

    await governed([call(sb.deployment.revenueSplitter, forgeProtocolRevenueSplitterAbi, "setPullsPaused", [false], "splitter.setPullsPaused(false)")], "unpause");
    expect(await splitterRead<boolean>("pullsPaused")).toBe(false);
  });

  it("treasury recipient rotated into a SERVER key (a custody mistake) trips the sticky custody violation on every role, even after the chain is corrected", async () => {
    const evidenceAddr = addr(SANDBOX_ROLES.evidence);
    const original = await splitterRead<Address>("treasuryRecipient");
    await governed([call(sb.deployment.revenueSplitter, forgeProtocolRevenueSplitterAbi, "proposeTreasuryRecipient", [evidenceAddr], "splitter.proposeTreasuryRecipient(evidence key)")], "bad-treasury");
    await warp((await splitterRead<bigint>("RECIPIENT_TIMELOCK")) + 1n);
    await chainSim(sb).execTreasury();
    expect(await splitterRead<Address>("treasuryRecipient")).toBe(evidenceAddr);
    await expect(evidenceSig(sb.ctx)).rejects.toThrow(/custody violation.*treasury recipient/);
    // (the authority/revenue roles of this process are already retired by the earlier rotations; the evidence role shows the violation)
    // Correcting the chain does not silently re-enable: restart + startup verification required.
    await governed([call(sb.deployment.revenueSplitter, forgeProtocolRevenueSplitterAbi, "proposeTreasuryRecipient", [original], "splitter.proposeTreasuryRecipient(original)")], "restore-treasury");
    await warp((await splitterRead<bigint>("RECIPIENT_TIMELOCK")) + 1n);
    await chainSim(sb).execTreasury();
    expect(await splitterRead<Address>("treasuryRecipient")).toBe(original);
    await expect(evidenceSig(sb.ctx)).rejects.toThrow(/custody violation/);
  });
});

describe("W06 production signing stays refused", () => {
  it("flags are false and every production path refuses", async () => {
    expect(PRODUCTION_SIGNING_ENABLED).toBe(false);
    expect(REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED).toBe(false);
    expect(PRODUCTION_BLOCKED).toBe(true);
    for (const chainId of [4663, 1, 11155111]) {
      await expect(KmsDigestSigner.create("authority", awsKmsBackend(kms, ARN.authority), { chainId }), `KMS on ${chainId}`).rejects.toThrow(/PRODUCTION_BLOCKED|dev chain|refused/i);
      expect(() => new LocalTestDigestSigner("authority", `0x${"11".repeat(32)}`, { chainId }), `local key on ${chainId}`).toThrow();
    }
    expect(() => buildConfig({ ...sb.env, ...KMS_ENV, FORGE_CHAIN_ID: "4663", FORGE_NETWORK: "robinhood" })).toThrow(/PRODUCTION_BLOCKED/);
    await expect(ctxFor({ FORGE_CHAIN_ID: "11155111" })).rejects.toThrow(/PRODUCTION_BLOCKED/);
  });
});

/** Permissionless executions (anyone may call these after the splitter's own timelock). */
function chainSim(s: Sandbox) {
  const w = wallet(SAFE_RELAYER_KEY);
  const exec = async (functionName: string) => {
    const { request } = await pub.simulateContract({ address: s.deployment.revenueSplitter, abi: forgeProtocolRevenueSplitterAbi, functionName, account: w.account! } as never);
    const r = await pub.waitForTransactionReceipt({ hash: await w.writeContract(request as never) });
    if (r.status !== "success") throw new Error(`${functionName} reverted`);
  };
  return { execAttestor: () => exec("executeRevenueAttestorChange"), execTreasury: () => exec("executeTreasuryRecipientChange") };
}
