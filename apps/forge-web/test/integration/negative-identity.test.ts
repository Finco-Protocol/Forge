/**
 * Mandatory negative cases — identity, GitHub, wallet, signing policy, webhooks.
 * Every refusal is produced by the production code paths.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { forgeBindingRegistryAbi } from "@/shared/abis.generated";
import { runJobs, runWorkerOnce } from "@/server/worker";
import { createAppContext } from "@/server/context";
import { verifyRepository } from "@/server/github/verify";
import { signWebhookBody } from "@/server/github/webhooks";
import { establishEligibility } from "@/server/eligibility/service";
import { buildConfig } from "@/server/config";
import { startSandbox, TestBrowser, type Sandbox } from "../helpers/sandbox";
import { BOB, REPO_ID, INSTALLATION_ID, seedGithub, freshScenario, signedLaunch, simulateLaunch, freshCreator } from "../helpers/scenario";
import { randomUUID } from "node:crypto";

let sb: Sandbox;
beforeAll(async () => {
  sb = await startSandbox();
  seedGithub(sb);
});
afterAll(async () => sb?.stop());

const isActive = (repoId: number, creator: `0x${string}`) =>
  sb.ctx.client.readContract({ address: sb.deployment.registry, abi: forgeBindingRegistryAbi, functionName: "isActive", args: [BigInt(repoId), creator] });

async function rawWebhook(event: string, body: string, delivery: string, secret: string) {
  const { dispatch } = await import("@/server/api/handlers");
  const res = await dispatch(
    sb.ctx,
    new Request("http://localhost:3000/api/github/webhook", {
      method: "POST",
      headers: { "x-hub-signature-256": signWebhookBody(secret, body), "x-github-delivery": delivery, "x-github-event": event, "content-type": "application/json" },
      body,
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("identity & eligibility refusals", () => {
  it("non-admin user is refused (write access is not admin)", async () => {
    const b = new TestBrowser(sb);
    await b.signInGithub(BOB.id);
    const v = await b.post("/api/github/verify", { repoId: REPO_ID, installationId: INSTALLATION_ID });
    expect(v.status).toBe(403);
    expect(v.json.error.code).toBe("NOT_ADMIN");
  });

  it("an installation token alone never proves admin: user-token admin is required", async () => {
    // GitHub's installation view says admin, but the user's OWN token says otherwise → refused.
    const s = await freshScenario(sb, { verify: false });
    sb.github.setPermission(s.repoId, s.user.id, "write");
    const v = await s.browser.post("/api/github/verify", { repoId: s.repoId, installationId: s.installationId });
    expect(v.status).toBe(403);
    expect(v.json.error.code).toBe("NOT_ADMIN");
    expect(v.json.error.detail.userPermission).toBe("write");
  });

  it("App not installed (repo outside the installation) is refused", async () => {
    const s = await freshScenario(sb, { verify: false });
    sb.github.removeRepoFromInstallation(s.installationId, s.repoId);
    const v = await s.browser.post("/api/github/verify", { repoId: s.repoId, installationId: s.installationId });
    expect(v.status).toBe(403);
    expect(v.json.error.code).toBe("APP_NOT_INSTALLED");
    sb.github.uninstall(s.installationId);
    const v2 = await s.browser.post("/api/github/verify", { repoId: s.repoId, installationId: s.installationId });
    expect(v2.json.error.code).toBe("APP_NOT_INSTALLED");
  });

  it("private and fork repositories follow the explicit eligibility policy", async () => {
    const s = await freshScenario(sb, { verify: false });
    sb.github.repos.get(s.repoId)!.private = true;
    const v = await s.browser.post("/api/github/verify", { repoId: s.repoId, installationId: s.installationId });
    expect(v.json.error.code).toBe("REPO_INELIGIBLE");
    expect(v.json.error.detail.reasons).toEqual(["PRIVATE_NOT_ALLOWED"]);
  });

  it("removed repository: webhook revokes evidence, the worker revokes on chain, the signed launch can no longer execute", async () => {
    const s = await freshScenario(sb);
    const l = await signedLaunch(sb, s.browser, s.key, s.draft);
    expect(await simulateLaunch(sb, s.key, l.call)).toBe("OK");
    expect(await isActive(s.repoId, s.address)).toBe(true);
    const r = await rawWebhook("installation_repositories", JSON.stringify({ action: "removed", installation: { id: s.installationId }, repositories_removed: [{ id: s.repoId, full_name: "x/y" }] }), randomUUID(), sb.env.GITHUB_WEBHOOK_SECRET!);
    expect(r.status).toBe(200);
    await runJobs(sb.ctx);
    expect(await isActive(s.repoId, s.address)).toBe(false);
    expect(await simulateLaunch(sb, s.key, l.call)).toBe("BindingNotActive");
    const again = await s.browser.post(`/api/launch/intents/${l.auth.json.intentId}/signature`, { signature: l.signature });
    expect(again.status).toBe(409);
  });

  it("revoked wallet binding: no new authorization, and the on-chain binding is revoked", async () => {
    const s = await freshScenario(sb);
    const l = await signedLaunch(sb, s.browser, s.key, s.draft);
    const del = await s.browser.request("DELETE", "/api/wallet/binding");
    expect(del.status).toBe(200);
    const auth = await s.browser.post(`/api/launch/drafts/${l.draft.json.id}/authorize`);
    expect(auth.json.error.code).toBe("WALLET_NOT_BOUND");
    await runJobs(sb.ctx);
    expect(await isActive(s.repoId, s.address)).toBe(false);
    expect(await simulateLaunch(sb, s.key, l.call)).toBe("BindingNotActive");
  });

  it("transferred repository: webhook invalidates, chain binding revoked, old admin refused", async () => {
    const s = await freshScenario(sb);
    const l = await signedLaunch(sb, s.browser, s.key, s.draft);
    sb.github.transfer(s.repoId, { id: 99_001, login: "someone-else", type: "User" });
    const r = await rawWebhook(
      "repository",
      JSON.stringify({ action: "transferred", repository: { id: s.repoId, full_name: `someone-else/project-${s.n}`, owner: { id: 99_001, login: "someone-else" } }, installation: { id: s.installationId } }),
      randomUUID(),
      sb.env.GITHUB_WEBHOOK_SECRET!,
    );
    expect(r.json.outcome).toBe("transferred");
    await runJobs(sb.ctx);
    expect(await isActive(s.repoId, s.address)).toBe(false);
    expect(await simulateLaunch(sb, s.key, l.call)).toBe("BindingNotActive");
    const v = await s.browser.post("/api/github/verify", { repoId: s.repoId, installationId: s.installationId });
    expect(v.status).toBe(403);
  });

  it("rename preserves canonical identity (binding stays active, launches continue)", async () => {
    const s = await freshScenario(sb);
    await signedLaunch(sb, s.browser, s.key, s.draft);
    sb.github.rename(s.repoId, `renamed-${s.n}`);
    const r = await rawWebhook("repository", JSON.stringify({ action: "renamed", repository: { id: s.repoId, full_name: `org-${s.n}/renamed-${s.n}` } }), randomUUID(), sb.env.GITHUB_WEBHOOK_SECRET!);
    expect(r.json.outcome).toBe("renamed");
    await runJobs(sb.ctx);
    expect(await isActive(s.repoId, s.address)).toBe(true);
    const names = await sb.ctx.db.query<{ full_name: string }>("SELECT full_name FROM repository_names WHERE repo_id = $1 ORDER BY first_seen_at", [s.repoId]);
    expect(names.rows.map((x) => x.full_name)).toContain(`org-${s.n}/renamed-${s.n}`);
    const l2 = await signedLaunch(sb, s.browser, s.key, { ...s.draft, symbol: `R${s.n}` });
    expect(await simulateLaunch(sb, s.key, l2.call)).toBe("OK");
  });

  it("stale GitHub evidence is never reused for authority signing", async () => {
    const s = await freshScenario(sb, { verify: false });
    const shortCtx = await createAppContext({ ...sb.env, FORGE_VERIFICATION_TTL_SECONDS: "1" }, { db: sb.ctx.db });
    const token = sb.github.issueUserToken(s.user.id);
    const wallet = (await sb.ctx.db.query<{ id: string }>("SELECT id::text FROM wallet_bindings WHERE github_user_id = $1 AND revoked_at IS NULL", [s.user.id])).rows[0]!;
    const v = await verifyRepository(shortCtx, { userToken: token, githubUserId: s.user.id, githubLogin: s.user.login, repoId: s.repoId, installationId: s.installationId, wallet: { bindingId: Number(wallet.id), address: s.address } });
    await new Promise((r) => setTimeout(r, 1200));
    const now = (await sb.ctx.client.getBlock()).timestamp;
    await expect(
      sb.ctx.authority.signBindingOp(
        { githubRepoId: BigInt(s.repoId), creator: s.address, bindingExpiresAt: now + 3600n, opDeadline: now + 60n, opNonce: 1n, parentOpDigest: `0x${"00".repeat(32)}`, repoFullName: v.fullName, revoke: false },
        { verificationId: v.id, reason: "bind", requestedBy: "test" },
      ),
    ).rejects.toMatchObject({ code: "SIGNING_POLICY_DENIED", detail: { reason: "verification stale" } });
    // Draft creation also requires unexpired evidence.
    const d = await s.browser.post("/api/launch/drafts", s.draft);
    expect(d.json.error.code).toBe("NOT_VERIFIED");
  });

  it("unauthorized authority-signing requests are denied and recorded", async () => {
    const s = await freshScenario(sb);
    const other = await freshScenario(sb);
    const v = (await sb.ctx.db.query<{ id: string }>("SELECT id FROM verifications WHERE repo_id = $1 ORDER BY verified_at DESC LIMIT 1", [other.repoId])).rows[0]!;
    // Evidence for a different repository / wallet cannot authorize this one.
    const now = (await sb.ctx.client.getBlock()).timestamp;
    await expect(
      sb.ctx.authority.signAttestation({ githubRepoId: BigInt(s.repoId), creator: s.address, bindingEpoch: 1n, issuedAt: now, expiresAt: now + 60n }, { verificationId: v.id, requestedBy: "attacker" }),
    ).rejects.toMatchObject({ code: "SIGNING_POLICY_DENIED", detail: { reason: "verification is for a different repository" } });
    // No evidence at all, for an otherwise well-formed operation against the live head.
    const head = await sb.ctx.client.readContract({ address: sb.deployment.registry, abi: forgeBindingRegistryAbi, functionName: "repoLogs", args: [BigInt(s.repoId)] });
    await expect(
      sb.ctx.authority.signBindingOp(
        { githubRepoId: BigInt(s.repoId), creator: s.address, bindingExpiresAt: now + 3600n, opDeadline: now + 60n, opNonce: head[0] + 1n, parentOpDigest: head[2], repoFullName: "x", revoke: false },
        { reason: "bind", requestedBy: "attacker" },
      ),
    ).rejects.toMatchObject({ code: "SIGNING_POLICY_DENIED", detail: { reason: "no verification evidence supplied" } });
    // Revoking someone else's binding by naming a different creator.
    await expect(
      sb.ctx.authority.signBindingOp(
        { githubRepoId: BigInt(s.repoId), creator: other.address, bindingExpiresAt: 0n, opDeadline: now + 60n, opNonce: head[0] + 1n, parentOpDigest: head[2], repoFullName: "x", revoke: true },
        { reason: "malicious", requestedBy: "attacker" },
      ),
    ).rejects.toMatchObject({ code: "SIGNING_POLICY_DENIED" });
    const denied = await sb.ctx.db.query("SELECT 1 FROM signing_requests WHERE decision = 'denied' AND requested_by = 'attacker'");
    expect(denied.rows.length).toBe(3);
    // There is no HTTP surface that signs caller-chosen data.
    const r = await s.browser.post("/api/sign", { digest: `0x${"11".repeat(32)}` });
    expect(r.status).toBe(404);
  });

  it("old registry epoch / obsolete sequence: the policy refuses to sign against a stale head", async () => {
    const s = await freshScenario(sb);
    await signedLaunch(sb, s.browser, s.key, s.draft); // epoch 1, sequence 1
    const v = (await sb.ctx.db.query<{ id: string; full_name: string }>("SELECT id, full_name FROM verifications WHERE repo_id = $1 ORDER BY verified_at DESC LIMIT 1", [s.repoId])).rows[0]!;
    const block = await sb.ctx.client.getBlock();
    await expect(
      sb.ctx.authority.signBindingOp(
        { githubRepoId: BigInt(s.repoId), creator: s.address, bindingExpiresAt: block.timestamp + 3600n, opDeadline: block.timestamp + 60n, opNonce: 1n, parentOpDigest: `0x${"00".repeat(32)}`, repoFullName: v.full_name, revoke: false },
        { verificationId: v.id, reason: "bind", requestedBy: "test" },
      ),
    ).rejects.toMatchObject({ detail: { reason: "obsolete or gapped registry sequence" } });
    await expect(
      sb.ctx.authority.signAttestation({ githubRepoId: BigInt(s.repoId), creator: s.address, bindingEpoch: 0n, issuedAt: block.timestamp, expiresAt: block.timestamp + 60n }, { verificationId: v.id, requestedBy: "test" }),
    ).rejects.toMatchObject({ detail: { reason: "obsolete binding epoch" } });
  });

  it("concurrent conflicting eligibility requests produce exactly one registry operation", async () => {
    const s = await freshScenario(sb);
    const token = sb.github.issueUserToken(s.user.id);
    const who = { githubUserId: s.user.id, githubLogin: s.user.login, userToken: token };
    const results = await Promise.allSettled([
      establishEligibility(sb.ctx, who, { repoId: s.repoId, installationId: s.installationId }),
      establishEligibility(sb.ctx, who, { repoId: s.repoId, installationId: s.installationId }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    const ops = await sb.ctx.db.query("SELECT 1 FROM registry_ops WHERE repo_id = $1 AND status = 'confirmed'", [s.repoId]);
    expect(ops.rows.length).toBe(1);
  });
});

describe("wallet binding protections", () => {
  it("SIWE: wrong chain, replay, tampering, other session and expiry are refused", async () => {
    const s = await freshScenario(sb, { bind: false, verify: false });
    const key = await freshCreator(sb);
    const acct = privateKeyToAccount(key);
    expect((await s.browser.post("/api/wallet/challenge", { address: acct.address, chainId: 1 })).json.error.code).toBe("WRONG_CHAIN");
    const ch = await s.browser.post("/api/wallet/challenge", { address: acct.address, chainId: 31337 });
    const sig = await acct.signMessage({ message: ch.json.message });
    // Tampered message (different statement) → signature mismatch / not issued.
    const tampered = ch.json.message.replace("FINCO Forge", "Evil Forge");
    const tSig = await acct.signMessage({ message: tampered });
    expect((await s.browser.post("/api/wallet/verify", { message: tampered, signature: tSig })).status).toBe(401);
    // Another session (different GitHub user) cannot redeem it.
    const other = await freshScenario(sb, { bind: false, verify: false });
    const ch2 = await s.browser.post("/api/wallet/challenge", { address: acct.address, chainId: 31337 });
    const sig2 = await acct.signMessage({ message: ch2.json.message });
    expect((await other.browser.post("/api/wallet/verify", { message: ch2.json.message, signature: sig2 })).json.error.code).toBe("SIWE_SESSION_MISMATCH");
    // Valid once, then replay refused.
    expect((await s.browser.post("/api/wallet/verify", { message: ch.json.message, signature: sig })).status).toBe(200);
    expect((await s.browser.post("/api/wallet/verify", { message: ch.json.message, signature: sig })).json.error.code).toBe("SIWE_REPLAY");
    // The same wallet cannot be bound to a second GitHub identity.
    const ch3 = await other.browser.post("/api/wallet/challenge", { address: acct.address, chainId: 31337 });
    const sig3 = await acct.signMessage({ message: ch3.json.message });
    expect((await other.browser.post("/api/wallet/verify", { message: ch3.json.message, signature: sig3 })).json.error.code).toBe("WALLET_BOUND_ELSEWHERE");
  });

  it("CSRF: missing token and cross-origin requests are refused; sessions can be revoked", async () => {
    const s = await freshScenario(sb, { verify: false });
    expect((await s.browser.request("POST", "/api/github/verify", { repoId: s.repoId, installationId: s.installationId }, { csrf: false })).json.error.code).toBe("CSRF");
    expect((await s.browser.request("POST", "/api/github/verify", { repoId: s.repoId, installationId: s.installationId }, { origin: "https://evil.example" })).json.error.code).toBe("CSRF");
    const out = await s.browser.post("/api/auth/logout", { all: true });
    expect(out.status).toBe(200);
    expect((await s.browser.get("/api/dashboard")).status).toBe(401);
  });

  it("OAuth state is single-use and session-bound", async () => {
    const s = await freshScenario(sb, { bind: false, verify: false });
    sb.github.nextLoginUser = s.user.id;
    const start = await s.browser.get("/api/auth/github/start");
    const authz = await fetch(start.headers.get("location")!, { redirect: "manual" });
    const cb = authz.headers.get("location")!;
    const attacker = new TestBrowser(sb);
    await attacker.get("/api/me");
    expect((await attacker.request("GET", cb)).json.error.code).toBe("OAUTH_STATE");
  });
});

describe("webhooks", () => {
  it("bad signatures are rejected; duplicate deliveries are processed exactly once", async () => {
    const s = await freshScenario(sb);
    await signedLaunch(sb, s.browser, s.key, s.draft);
    const body = JSON.stringify({ action: "archived", repository: { id: s.repoId, full_name: `org-${s.n}/project-${s.n}` } });
    expect((await rawWebhook("repository", body, randomUUID(), "wrong-secret-wrong-secret")).status).toBe(401);
    const delivery = randomUUID();
    const first = await rawWebhook("repository", body, delivery, sb.env.GITHUB_WEBHOOK_SECRET!);
    const second = await rawWebhook("repository", body, delivery, sb.env.GITHUB_WEBHOOK_SECRET!);
    expect(first.json).toMatchObject({ processed: true, outcome: "archived" });
    expect(second.json).toEqual({ duplicate: true });
    const jobs = await sb.ctx.db.query("SELECT 1 FROM jobs WHERE kind = 'registry_revoke' AND payload->>'repoId' = $1", [String(s.repoId)]);
    expect(jobs.rows.length).toBe(1);
  });

  it("reconciliation catches a missed webhook (admin lost silently)", async () => {
    const s = await freshScenario(sb);
    await signedLaunch(sb, s.browser, s.key, s.draft);
    sb.github.setPermission(s.repoId, s.user.id, "write"); // no webhook delivered
    const pass = await runWorkerOnce(sb.ctx, { reconcile: true });
    expect(pass).toBeTruthy();
    await runJobs(sb.ctx);
    expect(await isActive(s.repoId, s.address)).toBe(false);
  });
});

describe("configuration guards", () => {
  it("refuses the original PONS factory, chain 4663 in sandbox, and FINCO burn activation", () => {
    const base = { ...sb.env };
    expect(() => buildConfig({ ...base, FINCO_BURN_ENABLED: "true" })).toThrow(/FINCO_BURN_ENABLED/);
    expect(() => buildConfig({ ...base, FORGE_CHAIN_ID: "4663" })).toThrow(/4663/);
    expect(() => buildConfig({ ...base, FORGE_NETWORK: "robinhood", FORGE_CHAIN_ID: "4663" })).toThrow(/PRODUCTION_BLOCKED/);
  });
  it("the local test signer refuses any chain but a local dev chain", async () => {
    const { LocalTestDigestSigner } = await import("@/server/signer/local");
    expect(() => new LocalTestDigestSigner("authority", `0x${"11".repeat(32)}`, { chainId: 4663 })).toThrow(/PRODUCTION_BLOCKED/);
    expect(() => new LocalTestDigestSigner("authority", `0x${"11".repeat(32)}`, { chainId: 11155111 })).toThrow(/local dev chains only/);
    await expect(createAppContext({ ...sb.env, FORGE_CHAIN_ID: "11155111" }, { db: sb.ctx.db })).rejects.toThrow(/PRODUCTION_BLOCKED/);
  });
});
