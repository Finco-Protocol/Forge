/**
 * Mandatory negative cases — EIP-712/contract enforcement, launch tracking
 * and recovery, indexer duplicates/reorders/reorgs/interruptions, and
 * cross-factory isolation. All on the real W02 contracts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeAbiParameters, getAddress, keccak256, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { forgeBindingRegistryAbi, forgeLaunchAuthorizerAbi, ponsV2BondingCurveAbi, ponsV2LaunchFactoryAbi, ponsV2MemeHookAbi } from "@/shared/abis.generated";
import { launchAuthorizationTypes, launchDomain, launchAuthorizationMessage, canonicalExemptionHash, bindingOpTypes, registryDomain, eligibilityAttestationTypes, encodeAttestationPayload, tokenMetadataHash, EMPTY_SOCIALS } from "@/shared/forge-typed-data";
import { reviveTypedData } from "@/shared/launch-tx";
import { createAppContext } from "@/server/context";
import { runWorkerOnce } from "@/server/worker";
import { ForgeIndexer } from "@/server/indexer/indexer";
import { rebuildTokenProjection } from "@/server/indexer/projection";
import { revokeOnChain } from "@/server/eligibility/registry-ops";
import { verifyLedger } from "@/server/proof/ledger";
import { deploySandbox, SANDBOX_ROLES } from "../../scripts/sandbox-lib";
import { startSandbox, chainClients, type Sandbox } from "../helpers/sandbox";
import { rpc } from "../helpers/anvil";
import { freshScenario, signedLaunch, simulateLaunch, governanceWrite, freshCreator, LAUNCH_ERRORS_ABI } from "../helpers/scenario";
import type { Abi } from "viem";

let sb: Sandbox;
beforeAll(async () => {
  sb = await startSandbox();
});
afterAll(async () => sb?.stop());

async function send(key: Hex, call: Awaited<ReturnType<typeof signedLaunch>>["call"], gas?: bigint) {
  const { wallet, pub } = chainClients(sb.anvil.url, key);
  const hash = await wallet.writeContract({
    address: sb.deployment.factory,
    abi: ponsV2LaunchFactoryAbi,
    functionName: "launchToken",
    args: [call.params, call.launchConfigId, call.pairToken, call.exemptions],
    value: call.value,
    ...(gas ? { gas } : {}),
  });
  return { hash, receipt: await pub.waitForTransactionReceipt({ hash }) };
}

describe("EIP-712 / contract enforcement", () => {
  it("old registry epoch: an attestation from epoch 1 is dead after revoke + re-bind (epoch 2)", async () => {
    const s = await freshScenario(sb);
    const l = await signedLaunch(sb, s.browser, s.key, s.draft);
    await revokeOnChain(sb.ctx, BigInt(s.repoId), "test_rebind");
    // Re-establish eligibility for the SAME creator → epoch 2.
    const l2 = await signedLaunch(sb, s.browser, s.key, { ...s.draft, symbol: `E${s.n}` });
    expect(l2.auth.json.eligibility.bindingEpoch).toBe("2");
    // The epoch-1 launch (valid signatures, still unexpired) can no longer execute.
    expect(await simulateLaunch(sb, s.key, l.call)).toBe("InvalidAttestationSignature");
    expect(await simulateLaunch(sb, s.key, l2.call)).toBe("OK");
  });

  it("invalid creator signature: API refuses, contract refuses", async () => {
    const s = await freshScenario(sb);
    const d = await s.browser.post("/api/launch/drafts", s.draft);
    const auth = await s.browser.post(`/api/launch/drafts/${d.json.id}/authorize`);
    const intruder = privateKeyToAccount(await freshCreator(sb));
    const bad = await intruder.signTypedData(reviveTypedData(auth.json.typedData));
    const r = await s.browser.post(`/api/launch/intents/${auth.json.intentId}/signature`, { signature: bad });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("WRONG_SIGNER");
    expect((await s.browser.post(`/api/launch/intents/${auth.json.intentId}/signature`, { signature: "0x1234" })).json.error.code).toBe("BAD_SIGNATURE");
    const good = await signedLaunch(sb, s.browser, s.key, { ...s.draft, symbol: `S${s.n}` });
    const forged = { ...good.call, params: { ...good.call.params, creatorSignature: bad } };
    expect(["WrongCreator", "InvalidCreatorSignature"]).toContain(await simulateLaunch(sb, s.key, forged));
  });

  it("wrong chain / wrong domain consent is refused", async () => {
    const s = await freshScenario(sb);
    const d = await s.browser.post("/api/launch/drafts", s.draft);
    const auth = await s.browser.post(`/api/launch/drafts/${d.json.id}/authorize`);
    const td = reviveTypedData(auth.json.typedData);
    const wrongChain = await privateKeyToAccount(s.key).signTypedData({ ...td, domain: { ...td.domain, chainId: 4663 } });
    expect((await s.browser.post(`/api/launch/intents/${auth.json.intentId}/signature`, { signature: wrongChain })).json.error.code).toBe("WRONG_SIGNER");
    const wrongContract = await privateKeyToAccount(s.key).signTypedData({ ...td, domain: { ...td.domain, verifyingContract: sb.deployment.registry } });
    expect((await s.browser.post(`/api/launch/intents/${auth.json.intentId}/signature`, { signature: wrongContract })).json.error.code).toBe("WRONG_SIGNER");
  });

  it("wrong factory: a submission that is not a launch on the Forge factory is refused", async () => {
    const s = await freshScenario(sb);
    const l = await signedLaunch(sb, s.browser, s.key, s.draft);
    const { wallet, pub } = chainClients(sb.anvil.url, s.key);
    const h = await wallet.sendTransaction({ to: sb.deployment.registry, value: 0n, data: "0x" }).catch(async () => wallet.sendTransaction({ to: s.address, value: 1n }));
    await pub.waitForTransactionReceipt({ hash: h });
    const r = await s.browser.post(`/api/launch/intents/${l.auth.json.intentId}/submitted`, { txHash: h });
    expect(r.json.error.code).toBe("WRONG_FACTORY");
  });

  it("changed creator tax after signing is rejected by the authorizer", async () => {
    const s = await freshScenario(sb);
    const l = await signedLaunch(sb, s.browser, s.key, { ...s.draft, creatorTaxBps: 100 });
    expect(await simulateLaunch(sb, s.key, { ...l.call, params: { ...l.call.params, creatorTaxBps: 200 } })).toBe("WrongCreator");
    expect(await simulateLaunch(sb, s.key, l.call)).toBe("OK");
  });

  it("changed anti-snipe exemption set is rejected; a reordering of the same set is accepted", async () => {
    const s = await freshScenario(sb);
    const a = "0x00000000000000000000000000000000000000aa" as Address;
    const b = "0x00000000000000000000000000000000000000bb" as Address;
    const l = await signedLaunch(sb, s.browser, s.key, { ...s.draft, snipeTaxExemptions: [b, a] });
    expect(await simulateLaunch(sb, s.key, { ...l.call, exemptions: [a] })).toBe("WrongCreator");
    expect(await simulateLaunch(sb, s.key, { ...l.call, exemptions: [a, b, a] })).toBe("WrongCreator");
    expect(await simulateLaunch(sb, s.key, { ...l.call, exemptions: [a, b] })).toBe("OK");
    expect(canonicalExemptionHash([a, b])).toBe(canonicalExemptionHash([b, a]));
  });

  it("reused nonce: a consumed authorization never launches twice", async () => {
    const s = await freshScenario(sb);
    const l = await signedLaunch(sb, s.browser, s.key, s.draft);
    const first = await send(s.key, l.call);
    expect(first.receipt.status).toBe("success");
    // Same consent again with a different salt (fresh CREATE2 space) → nonce check.
    expect(await simulateLaunch(sb, s.key, l.call)).toBe("CreatorNonceStale");
    const again = await s.browser.post(`/api/launch/intents/${l.auth.json.intentId}/signature`, { signature: l.signature });
    expect(again.json.error.code).toBe("NONCE_USED");
  });

  it("expired consent and expired attestation are refused (API and contract)", async () => {
    const shortCtx = await createAppContext({ ...sb.env, FORGE_ATTESTATION_TTL_SECONDS: "30", FORGE_CONSENT_TTL_SECONDS: "30" }, { db: sb.ctx.db });
    const s = await freshScenario(sb);
    const { establishEligibility } = await import("@/server/eligibility/service");
    const elig = await establishEligibility(shortCtx, { githubUserId: s.user.id, githubLogin: s.user.login, userToken: sb.github.issueUserToken(s.user.id) }, { repoId: s.repoId, installationId: s.installationId });
    // Consent valid for an hour, attestation for 30 s.
    const econ = await sb.ctx.client.readContract({ address: sb.deployment.factory, abi: ponsV2LaunchFactoryAbi, functionName: "previewLaunchEconomics", args: [0n, "0x0000000000000000000000000000000000000000"] });
    const nonce = await sb.ctx.client.readContract({ address: sb.deployment.authorizer, abi: forgeLaunchAuthorizerAbi, functionName: "nextCreatorNonce", args: [s.address] });
    const now = (await sb.ctx.client.getBlock()).timestamp;
    const meta = { name: "Exp", symbol: `X${s.n}`, logo: "", description: "", socials: EMPTY_SOCIALS };
    const intent = {
      factory: sb.deployment.factory,
      creator: s.address,
      githubRepoId: BigInt(s.repoId),
      launchConfigId: 0n,
      pairToken: "0x0000000000000000000000000000000000000000" as Address,
      tokenMetadataHash: tokenMetadataHash(meta),
      economicsDigest: econ,
      salt: keccak256("0x01"),
      expiresAt: now + 3600n,
      nonce,
      creatorTaxBps: 0,
      exemptionListHash: canonicalExemptionHash([]),
    };
    const consent = await privateKeyToAccount(s.key).signTypedData({ domain: launchDomain(31337, sb.deployment.authorizer), types: launchAuthorizationTypes, primaryType: "LaunchAuthorization", message: launchAuthorizationMessage(intent, s.address, false) });
    const call = {
      params: { ...meta, creatorFeeRecipient: "0x0000000000000000000000000000000000000000" as Address, creatorTaxBps: 0, buybackEnabled: false, expectedEconomics: econ, salt: intent.salt, githubRepoId: intent.githubRepoId, authorizationExpiresAt: intent.expiresAt, authorizationNonce: nonce, creatorSignature: consent, attestationPayload: elig.attestation.payload },
      launchConfigId: 0n,
      pairToken: intent.pairToken,
      exemptions: [] as Address[],
      value: 0n,
    };
    expect(await simulateLaunch(sb, s.key, call)).toBe("OK");
    await rpc(sb.anvil.url, "evm_increaseTime", [45]);
    await rpc(sb.anvil.url, "evm_mine");
    expect(await simulateLaunch(sb, s.key, call)).toBe("AttestationExpired");
    // And the consent side: an expired authorization.
    const expiredIntent = { ...intent, expiresAt: now + 10n };
    const expiredConsent = await privateKeyToAccount(s.key).signTypedData({ domain: launchDomain(31337, sb.deployment.authorizer), types: launchAuthorizationTypes, primaryType: "LaunchAuthorization", message: launchAuthorizationMessage(expiredIntent, s.address, false) });
    expect(await simulateLaunch(sb, s.key, { ...call, params: { ...call.params, authorizationExpiresAt: expiredIntent.expiresAt, creatorSignature: expiredConsent } })).toBe("AuthorizationExpired");
    // API: an intent whose window passed is refused before gas is spent.
    const d = await s.browser.post("/api/launch/drafts", { ...s.draft, symbol: `Y${s.n}` });
    const auth = await s.browser.post(`/api/launch/drafts/${d.json.id}/authorize`);
    await rpc(sb.anvil.url, "evm_increaseTime", [sb.ctx.cfg.policy.consentTtlSeconds + 5]);
    await rpc(sb.anvil.url, "evm_mine");
    const sig = await privateKeyToAccount(s.key).signTypedData(reviveTypedData(auth.json.typedData));
    expect((await s.browser.post(`/api/launch/intents/${auth.json.intentId}/signature`, { signature: sig })).json.error.code).toBe("INTENT_EXPIRED");
    expect((await s.browser.get(`/api/launch/intents/${auth.json.intentId}`)).json).toMatchObject({ status: "expired" });
  });

  it("stale economics preview forces review and re-signing (API) and reverts on chain", async () => {
    const s = await freshScenario(sb);
    const l = await signedLaunch(sb, s.browser, s.key, s.draft);
    const d2 = await s.browser.post("/api/launch/drafts", { ...s.draft, symbol: `Z${s.n}` });
    // Governance re-pegs the hook fee underneath both.
    await governanceWrite(sb, sb.deployment.memeHook, ponsV2MemeHookAbi as unknown as Abi, "setHookFeeBps", [150n]);
    try {
      expect(await simulateLaunch(sb, s.key, l.call)).toBe("LaunchEconomicsMismatch");
      const again = await s.browser.post(`/api/launch/intents/${l.auth.json.intentId}/signature`, { signature: l.signature });
      expect(again.json.error.code).toBe("STALE_ECONOMICS");
      const auth = await s.browser.post(`/api/launch/drafts/${d2.json.id}/authorize`);
      expect(auth.status).toBe(409);
      expect(auth.json.error.code).toBe("STALE_ECONOMICS");
      const view = await s.browser.get(`/api/launch/drafts/${d2.json.id}`);
      expect(view.json.economicsStale).toBe(true);
      const refreshed = await s.browser.post(`/api/launch/drafts/${d2.json.id}/refresh`);
      expect(refreshed.json.economics.hookFeeBps).toBe(150);
      const auth2 = await s.browser.post(`/api/launch/drafts/${d2.json.id}/authorize`);
      expect(auth2.status).toBe(200);
    } finally {
      await governanceWrite(sb, sb.deployment.memeHook, ponsV2MemeHookAbi as unknown as Abi, "setHookFeeBps", [100n]);
    }
  });
});

describe("launch tracking & recovery", () => {
  it("a reverted launch is reported with its reason and an explicit recovery path; re-authorization succeeds", async () => {
    const s = await freshScenario(sb);
    const l = await signedLaunch(sb, s.browser, s.key, s.draft);
    const cfg = await sb.ctx.client.readContract({ address: sb.deployment.factory, abi: ponsV2LaunchFactoryAbi, functionName: "getLaunchConfig", args: [0n] });
    await governanceWrite(sb, sb.deployment.factory, ponsV2LaunchFactoryAbi as unknown as Abi, "updateLaunchConfig", [0n, { ...cfg, enabled: false }]);
    let sent;
    try {
      sent = await send(s.key, l.call, 5_000_000n);
    } finally {
      await governanceWrite(sb, sb.deployment.factory, ponsV2LaunchFactoryAbi as unknown as Abi, "updateLaunchConfig", [0n, { ...cfg, enabled: true }]);
    }
    expect(sent.receipt.status).toBe("reverted");
    const r = await s.browser.post(`/api/launch/intents/${l.auth.json.intentId}/submitted`, { txHash: sent.hash });
    expect(r.json.status).toBe("failed");
    expect(r.json.failureReason).toMatch(/reverted/);
    expect(r.json.recovery).toMatch(/Re-authorize/);
    // Recovery: same draft, fresh authorization (nonce was not consumed).
    const auth = await s.browser.post(`/api/launch/drafts/${l.draft.json.id}/authorize`);
    expect(auth.status).toBe(200);
    expect(auth.json.nonce).toBe(l.auth.json.nonce);
    const sig = await privateKeyToAccount(s.key).signTypedData(reviveTypedData(auth.json.typedData));
    expect((await s.browser.post(`/api/launch/intents/${auth.json.intentId}/signature`, { signature: sig })).status).toBe(200);
  });

  it("no duplicate launches during retries: in-flight launch blocks re-authorization; a tx is attached once", async () => {
    const s = await freshScenario(sb);
    const l = await signedLaunch(sb, s.browser, s.key, s.draft);
    // Re-authorizing an unsigned/signed draft supersedes the old intent (it can never also land).
    const sent = await send(s.key, l.call);
    const sub = await s.browser.post(`/api/launch/intents/${l.auth.json.intentId}/submitted`, { txHash: sent.hash });
    expect(["included", "confirmed"]).toContain(sub.json.status);
    expect((await s.browser.post(`/api/launch/intents/${l.auth.json.intentId}/submitted`, { txHash: sent.hash })).json.error.code).toBe("BAD_STATE");
    const reauth = await s.browser.post(`/api/launch/drafts/${l.draft.json.id}/authorize`);
    expect(reauth.json.error.code).toBe("LAUNCH_IN_FLIGHT");
  });
});

describe("indexer: duplicates, reorders, reorgs, interruptions, isolation", () => {
  it("replay after checkpoint rewind inserts no duplicates and yields the same projection", async () => {
    const s = await freshScenario(sb);
    const l = await signedLaunch(sb, s.browser, s.key, s.draft);
    await send(s.key, l.call);
    await runWorkerOnce(sb.ctx);
    const count = async () => Number((await sb.ctx.db.query<{ c: string }>("SELECT count(*)::text c FROM chain_events")).rows[0]!.c);
    const before = await count();
    const snap = (await sb.ctx.db.query("SELECT * FROM tokens ORDER BY token")).rows.map((r) => ({ ...r, updated_at: null, reconciled_at: null }));
    await sb.ctx.db.query("UPDATE indexer_checkpoints SET last_block = $1, last_block_hash = NULL", [sb.deployment.deployBlock]);
    await runWorkerOnce(sb.ctx);
    expect(await count()).toBe(before);
    const after = (await sb.ctx.db.query("SELECT * FROM tokens ORDER BY token")).rows.map((r) => ({ ...r, updated_at: null, reconciled_at: null }));
    expect(after).toEqual(snap);
  });

  it("reordered event insertion produces the identical projection", async () => {
    const token = (await sb.ctx.db.query<{ token: string }>("SELECT token FROM tokens LIMIT 1")).rows[0]!.token;
    const before = (await sb.ctx.db.query("SELECT phase, buy_count, quote_volume::text FROM tokens WHERE token = $1", [token])).rows[0];
    const events = (await sb.ctx.db.query("SELECT * FROM chain_events ORDER BY random()")).rows;
    await sb.ctx.db.tx(async (q) => {
      await q.query("DELETE FROM chain_events");
      for (const e of events.reverse()) {
        const r = e as Record<string, unknown>;
        await q.query("INSERT INTO chain_events(chain_id, block_number, block_hash, tx_hash, log_index, address, event_name, args, block_timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
          r.chain_id, r.block_number, r.block_hash, r.tx_hash, r.log_index, r.address, r.event_name, JSON.stringify(r.args), r.block_timestamp,
        ]);
      }
      await rebuildTokenProjection(q, sb.ctx.cfg.chainId, sb.ctx.cfg.addresses, token);
    });
    expect((await sb.ctx.db.query("SELECT phase, buy_count, quote_volume::text FROM tokens WHERE token = $1", [token])).rows[0]).toEqual(before);
  });

  it("an interrupted indexer pass commits nothing and the restart converges", async () => {
    const s = await freshScenario(sb);
    const l = await signedLaunch(sb, s.browser, s.key, s.draft);
    await send(s.key, l.call);
    const cp = async () => (await sb.ctx.db.query<{ last_block: string }>("SELECT last_block::text FROM indexer_checkpoints")).rows[0]!.last_block;
    const before = await cp();
    const origTx = sb.ctx.db.tx.bind(sb.ctx.db);
    sb.ctx.db.tx = (async (fn: (q: unknown) => Promise<unknown>) =>
      origTx(async (q) => {
        await fn(q);
        throw new Error("simulated crash before commit");
      })) as typeof sb.ctx.db.tx;
    try {
      await expect(new ForgeIndexer(sb.ctx).tick()).rejects.toThrow(/simulated crash/);
    } finally {
      sb.ctx.db.tx = origTx;
    }
    expect(await cp()).toBe(before);
    const token = getAddress(l.signed.json.simulation.token);
    expect((await sb.ctx.db.query("SELECT 1 FROM tokens WHERE token = $1", [token])).rows.length).toBe(0);
    await runWorkerOnce(sb.ctx);
    expect((await sb.ctx.db.query("SELECT 1 FROM tokens WHERE token = $1", [token])).rows.length).toBe(1);
  });

  it("chain reorg: orphaned trades and an orphaned launch are rolled back; the receipt is retracted, never deleted", async () => {
    const s = await freshScenario(sb);
    const l = await signedLaunch(sb, s.browser, s.key, s.draft);
    await runWorkerOnce(sb.ctx);
    const snapshot = await rpc<string>(sb.anvil.url, "evm_snapshot");
    const sent = await send(s.key, l.call);
    await s.browser.post(`/api/launch/intents/${l.auth.json.intentId}/submitted`, { txHash: sent.hash });
    const token = getAddress(l.signed.json.simulation.token);
    const curve = getAddress(l.signed.json.simulation.curve);
    const buyer = chainClients(sb.anvil.url, await freshCreator(sb));
    await rpc(sb.anvil.url, "evm_increaseTime", [20]);
    const h = await buyer.wallet.writeContract({ address: curve, abi: ponsV2BondingCurveAbi, functionName: "buy", args: [parseEther("1"), 0n, buyer.account.address], value: parseEther("1") });
    await buyer.pub.waitForTransactionReceipt({ hash: h });
    const pass1 = await runWorkerOnce(sb.ctx);
    expect(pass1.receipts).toContain(token);
    expect((await s.browser.get(`/api/launch/intents/${l.auth.json.intentId}`)).json.status).toBe("confirmed");
    // Reorg: drop the launch + trade blocks, then build a LONGER competing chain.
    await rpc(sb.anvil.url, "evm_revert", [snapshot]);
    for (let i = 0; i < 6; i++) await rpc(sb.anvil.url, "evm_mine");
    const pass2 = await runWorkerOnce(sb.ctx);
    expect(pass2.reorgedTo).not.toBeNull();
    expect(pass2.retractions).toContain(token);
    expect((await sb.ctx.db.query("SELECT 1 FROM tokens WHERE token = $1", [token])).rows.length).toBe(0);
    expect((await sb.ctx.db.query("SELECT 1 FROM chain_events WHERE address = $1", [curve])).rows.length).toBe(0);
    const kinds = (await sb.ctx.db.query<{ kind: string }>("SELECT kind FROM evidence_receipts WHERE token = $1 ORDER BY seq", [token])).rows.map((r) => r.kind);
    expect(kinds).toEqual(["launch", "retraction"]);
    expect((await verifyLedger(sb.ctx)).ok).toBe(true);
    // The intent is no longer "confirmed": the tx is gone from the canonical chain.
    expect((await s.browser.get(`/api/launch/intents/${l.auth.json.intentId}`)).json.status).not.toBe("confirmed");
  });

  it("does not mix in launches from any other factory (allowlist)", async () => {
    // A second, fully functional W02 stack on the same chain — its launches must never appear.
    const other = await deploySandbox(sb.anvil.url);
    const creatorKey = await freshCreator(sb);
    const creator = privateKeyToAccount(creatorKey).address;
    const authority = privateKeyToAccount(SANDBOX_ROLES.authority);
    const { pub, wallet } = chainClients(sb.anvil.url, creatorKey);
    const now = (await pub.getBlock()).timestamp;
    const op = { githubRepoId: 4242n, creator, bindingExpiresAt: now + 86400n, opDeadline: now + 300n, opNonce: 1n, parentOpDigest: `0x${"00".repeat(32)}` as Hex, repoFullName: "other/repo", revoke: false };
    const opSig = await authority.signTypedData({ domain: registryDomain(31337, other.registry), types: bindingOpTypes, primaryType: "BindingOp", message: op });
    await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: other.registry, abi: forgeBindingRegistryAbi, functionName: "applyBindingOp", args: [op, opSig] }) });
    const econ = await pub.readContract({ address: other.factory, abi: ponsV2LaunchFactoryAbi, functionName: "previewLaunchEconomics", args: [0n, "0x0000000000000000000000000000000000000000"] });
    const t = (await pub.getBlock()).timestamp;
    const attSig = await authority.signTypedData({ domain: launchDomain(31337, other.authorizer), types: eligibilityAttestationTypes, primaryType: "EligibilityAttestation", message: { githubRepoId: 4242n, creator, bindingEpoch: 1n, issuedAt: t, expiresAt: t + 600n } });
    const meta = { name: "Other", symbol: "OTH", logo: "", description: "", socials: EMPTY_SOCIALS };
    const intent = { factory: other.factory, creator, githubRepoId: 4242n, launchConfigId: 0n, pairToken: "0x0000000000000000000000000000000000000000" as Address, tokenMetadataHash: tokenMetadataHash(meta), economicsDigest: econ, salt: keccak256("0x02"), expiresAt: t + 600n, nonce: 0n, creatorTaxBps: 0, exemptionListHash: keccak256(encodeAbiParameters([{ type: "address[]" }], [[]])) };
    const consent = await privateKeyToAccount(creatorKey).signTypedData({ domain: launchDomain(31337, other.authorizer), types: launchAuthorizationTypes, primaryType: "LaunchAuthorization", message: launchAuthorizationMessage(intent, creator, false) });
    const hash = await wallet.writeContract({
      address: other.factory,
      abi: LAUNCH_ERRORS_ABI,
      functionName: "launchToken",
      args: [{ ...meta, creatorFeeRecipient: "0x0000000000000000000000000000000000000000", creatorTaxBps: 0, buybackEnabled: false, expectedEconomics: econ, salt: intent.salt, githubRepoId: 4242n, authorizationExpiresAt: intent.expiresAt, authorizationNonce: 0n, creatorSignature: consent, attestationPayload: encodeAttestationPayload(t, t + 600n, attSig) }, 0n, "0x0000000000000000000000000000000000000000", []],
    });
    expect((await pub.waitForTransactionReceipt({ hash })).status).toBe("success");
    await runWorkerOnce(sb.ctx);
    const foreign = await sb.ctx.db.query("SELECT 1 FROM chain_events WHERE tx_hash = $1", [hash.toLowerCase()]);
    expect(foreign.rows.length).toBe(0);
    const tokens = await sb.ctx.db.query<{ factory: string }>("SELECT DISTINCT factory FROM tokens");
    expect(tokens.rows.map((r) => r.factory)).toEqual([getAddress(sb.deployment.factory)]);
  });
});
