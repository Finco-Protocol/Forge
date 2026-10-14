/**
 * W03 Correction A — revocation safety and trusted-proxy rate limiting.
 *
 * What these prove (and what they do NOT): off-chain refusal is immediate;
 * on-chain revocation is a confirmed transaction landed by the worker with
 * priority, retried indefinitely, alerted on, and re-asserted by a watchdog
 * if it is ever reorged out. A pre-issued attestation + signed consent
 * remains executable until that revocation confirms or the attestation
 * expires — the contracts provide no stronger guarantee.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { forgeBindingRegistryAbi } from "@/shared/abis.generated";
import { runJobs, runWorkerOnce, revocationHealth } from "@/server/worker";
import { signWebhookBody } from "@/server/github/webhooks";
import { dispatch, trustedClientIp } from "@/server/api/handlers";
import { createAppContext } from "@/server/context";
import { revokeOnChain } from "@/server/eligibility/registry-ops";
import { startSandbox, TestBrowser, type Sandbox } from "../helpers/sandbox";
import { rpc } from "../helpers/anvil";
import { freshScenario, signedLaunch, simulateLaunch } from "../helpers/scenario";

let sb: Sandbox;
beforeAll(async () => {
  sb = await startSandbox();
});
afterAll(async () => sb?.stop());

const isActive = (repoId: number, creator: `0x${string}`) =>
  sb.ctx.client.readContract({ address: sb.deployment.registry, abi: forgeBindingRegistryAbi, functionName: "isActive", args: [BigInt(repoId), creator] });

async function webhook(event: string, payload: unknown, delivery = randomUUID()) {
  const body = JSON.stringify(payload);
  const res = await dispatch(
    sb.ctx,
    new Request("http://localhost:3000/api/github/webhook", {
      method: "POST",
      headers: { "x-hub-signature-256": signWebhookBody(sb.env.GITHUB_WEBHOOK_SECRET!, body), "x-github-delivery": delivery, "x-github-event": event },
      body,
    }),
  );
  return (await res.json()) as Record<string, unknown>;
}

const revokeJobs = async (repoId: number) =>
  (await sb.ctx.db.query<{ status: string; attempts: number; completed_at: Date | null; priority: number }>(
    "SELECT status, attempts, completed_at, priority FROM jobs WHERE kind = 'registry_revoke' AND payload->>'repoId' = $1 ORDER BY id",
    [String(repoId)],
  )).rows;

describe("revocation: off-chain immediately, on-chain by confirmed transaction", () => {
  it("1. repository transfer → immediate signing refusal, then confirmed on-chain revocation with measured latency", async () => {
    const s = await freshScenario(sb);
    const l = await signedLaunch(sb, s.browser, s.key, s.draft);
    sb.github.transfer(s.repoId, { id: 99_100 + s.n, login: `new-owner-${s.n}`, type: "User" });
    await webhook("repository", { action: "transferred", repository: { id: s.repoId, full_name: `new-owner-${s.n}/project-${s.n}`, owner: { id: 99_100 + s.n, login: `new-owner-${s.n}` } } });
    // 9. Before ANY on-chain action: the authority refuses to sign for this repo.
    const v = (await sb.ctx.db.query<{ id: string }>("SELECT id FROM verifications WHERE repo_id = $1 ORDER BY verified_at DESC LIMIT 1", [s.repoId])).rows[0]!;
    const now = (await sb.ctx.client.getBlock()).timestamp;
    await expect(
      sb.ctx.authority.signAttestation({ githubRepoId: BigInt(s.repoId), creator: s.address, bindingEpoch: 1n, issuedAt: now, expiresAt: now + 60n }, { verificationId: v.id, requestedBy: "test" }),
    ).rejects.toMatchObject({ detail: { reason: "verification revoked" } });
    // Residual risk, stated honestly: the pre-issued attestation + consent still executes until revocation confirms.
    expect(await simulateLaunch(sb, s.key, l.call)).toBe("OK");
    expect((await revokeJobs(s.repoId))[0]).toMatchObject({ status: "pending", priority: 0 });
    // 10. Finality: the job is done only once the revoke is confirmed on chain.
    await runWorkerOnce(sb.ctx);
    expect(await isActive(s.repoId, s.address)).toBe(false);
    expect(await simulateLaunch(sb, s.key, l.call)).toBe("BindingNotActive");
    const [job] = await revokeJobs(s.repoId);
    expect(job!.status).toBe("done");
    expect(job!.completed_at).not.toBeNull();
    const h = await revocationHealth(sb.ctx);
    expect(h.lastLatencySeconds).not.toBeNull();
    expect(h.breached).toBe(false);
  });

  it("2. App uninstall → every covered repository is revoked on chain", async () => {
    const s = await freshScenario(sb);
    await signedLaunch(sb, s.browser, s.key, s.draft);
    sb.github.uninstall(s.installationId);
    await webhook("installation", { action: "deleted", installation: { id: s.installationId, account: s.org }, repositories: [{ id: s.repoId, full_name: "x" }] });
    await runWorkerOnce(sb.ctx);
    expect(await isActive(s.repoId, s.address)).toBe(false);
  });

  it("3. loss of GitHub admin (member edited) → revalidation job → on-chain revoke", async () => {
    const s = await freshScenario(sb);
    await signedLaunch(sb, s.browser, s.key, s.draft);
    sb.github.setPermission(s.repoId, s.user.id, "write");
    await webhook("member", { action: "edited", repository: { id: s.repoId, full_name: `org-${s.n}/project-${s.n}` }, member: { id: s.user.id, login: s.user.login } });
    await runWorkerOnce(sb.ctx); // revalidate → invalidate → revoke job
    await runWorkerOnce(sb.ctx); // revoke job (priority 0)
    expect(await isActive(s.repoId, s.address)).toBe(false);
  });

  it("4. revoked wallet binding → on-chain revoke", async () => {
    const s = await freshScenario(sb);
    await signedLaunch(sb, s.browser, s.key, s.draft);
    await s.browser.request("DELETE", "/api/wallet/binding");
    await runWorkerOnce(sb.ctx);
    expect(await isActive(s.repoId, s.address)).toBe(false);
  });

  it("5. worker failure → retried (never silently dropped), alert raised, then confirmed", async () => {
    const s = await freshScenario(sb);
    await signedLaunch(sb, s.browser, s.key, s.draft);
    const relayer = sb.ctx.relayer.account.address;
    const balance = await rpc<string>(sb.anvil.url, "eth_getBalance", [relayer, "latest"]);
    await rpc(sb.anvil.url, "anvil_setBalance", [relayer, "0x0"]); // relayer cannot pay gas
    try {
      await webhook("repository", { action: "archived", repository: { id: s.repoId, full_name: `org-${s.n}/project-${s.n}` } });
      for (let i = 0; i < 4; i++) {
        await sb.ctx.db.query("UPDATE jobs SET run_after = now() WHERE status = 'pending'");
        await runJobs(sb.ctx);
      }
      const [job] = await revokeJobs(s.repoId);
      expect(job).toMatchObject({ status: "pending" });
      expect(job!.attempts).toBeGreaterThanOrEqual(4);
      const alert = await sb.ctx.db.query("SELECT 1 FROM audit_events WHERE action = 'ALERT:revocation_retrying'");
      expect(alert.rows.length).toBeGreaterThan(0);
      expect((await revocationHealth(sb.ctx)).retrying).toBeGreaterThan(0);
      expect(await isActive(s.repoId, s.address)).toBe(true);
    } finally {
      await rpc(sb.anvil.url, "anvil_setBalance", [relayer, balance]);
    }
    await sb.ctx.db.query("UPDATE jobs SET run_after = now() WHERE status = 'pending'");
    await runJobs(sb.ctx);
    expect(await isActive(s.repoId, s.address)).toBe(false);
    expect((await revokeJobs(s.repoId))[0]!.status).toBe("done");
  });

  it("6. duplicate webhook → exactly one revocation job", async () => {
    const s = await freshScenario(sb);
    await signedLaunch(sb, s.browser, s.key, s.draft);
    const delivery = randomUUID();
    const p = { action: "archived", repository: { id: s.repoId, full_name: `org-${s.n}/project-${s.n}` } };
    expect(await webhook("repository", p, delivery)).toMatchObject({ processed: true });
    expect(await webhook("repository", p, delivery)).toEqual({ duplicate: true });
    expect((await revokeJobs(s.repoId)).length).toBe(1);
  });

  it("7. conflicting registry operations: concurrent revocations land exactly one on-chain revoke", async () => {
    const s = await freshScenario(sb);
    await signedLaunch(sb, s.browser, s.key, s.draft);
    const results = await Promise.allSettled([revokeOnChain(sb.ctx, BigInt(s.repoId), "a"), revokeOnChain(sb.ctx, BigInt(s.repoId), "b")]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const ops = await sb.ctx.db.query("SELECT 1 FROM registry_ops WHERE repo_id = $1 AND revoke = true AND status = 'confirmed'", [s.repoId]);
    expect(ops.rows.length).toBe(1);
    expect(await isActive(s.repoId, s.address)).toBe(false);
  });

  it("8. a revocation reorged out of the chain is detected and re-asserted by the watchdog", async () => {
    const s = await freshScenario(sb);
    await signedLaunch(sb, s.browser, s.key, s.draft);
    const snap = await rpc<string>(sb.anvil.url, "evm_snapshot");
    await webhook("repository", { action: "archived", repository: { id: s.repoId, full_name: `org-${s.n}/project-${s.n}` } });
    await runWorkerOnce(sb.ctx);
    expect(await isActive(s.repoId, s.address)).toBe(false);
    // Reorg: the confirmed revoke block disappears; the binding is active again on the canonical chain.
    await rpc(sb.anvil.url, "evm_revert", [snap]);
    for (let i = 0; i < 3; i++) await rpc(sb.anvil.url, "evm_mine");
    expect(await isActive(s.repoId, s.address)).toBe(true);
    await sb.ctx.db.query("UPDATE registry_ops SET status = 'failed', error = 'reorged' WHERE repo_id = $1 AND revoke = true", [s.repoId]); // its tx no longer exists
    await runWorkerOnce(sb.ctx); // watchdog enqueues + runs a fresh revoke against the live head
    await runWorkerOnce(sb.ctx);
    expect(await isActive(s.repoId, s.address)).toBe(false);
    const alert = await sb.ctx.db.query("SELECT 1 FROM audit_events WHERE action = 'ALERT:revocation_not_final' AND subject = $1", [`repo:${s.repoId}`]);
    expect(alert.rows.length).toBe(1);
  });

  it("revocation jobs run before routine work (priority 0) even with a backlog", async () => {
    for (let i = 0; i < 30; i++) {
      await sb.ctx.db.query("INSERT INTO jobs(kind, dedupe_key, payload) VALUES ('noop_backlog', $1, '{}')", [`backlog:${i}:${randomUUID()}`]);
    }
    const s = await freshScenario(sb);
    await signedLaunch(sb, s.browser, s.key, s.draft);
    await webhook("repository", { action: "archived", repository: { id: s.repoId, full_name: `org-${s.n}/project-${s.n}` } });
    await runJobs(sb.ctx, 5); // only five slots: the revocation must take one
    expect(await isActive(s.repoId, s.address)).toBe(false);
    await sb.ctx.db.query("DELETE FROM jobs WHERE kind = 'noop_backlog'");
  });
});

describe("trusted-proxy policy and rate limiting", () => {
  it("never trusts X-Forwarded-For without a declared proxy chain; takes the proxy-appended entry otherwise", () => {
    const req = (xff?: string) => new Request("http://x/", { headers: xff ? { "x-forwarded-for": xff } : {} });
    expect(trustedClientIp(req("1.2.3.4"), 0)).toBeNull();
    expect(trustedClientIp(req("6.6.6.6, 10.0.0.7"), 1)).toBe("10.0.0.7");
    expect(trustedClientIp(req("6.6.6.6, 7.7.7.7, 10.0.0.7"), 2)).toBe("7.7.7.7");
    expect(trustedClientIp(req(), 1)).toBeNull();
    expect(trustedClientIp(req("not an ip"), 1)).toBeNull();
  });

  it("spoofed X-Forwarded-For cannot multiply the OAuth-start budget (no trusted proxy)", async () => {
    const ctx = await createAppContext({ ...sb.env }, { db: sb.ctx.db });
    const b = new TestBrowser({ ...sb, ctx });
    await b.get("/api/me");
    const statuses: number[] = [];
    for (let i = 0; i < 35; i++) {
      const r = await b.request("GET", "/api/auth/github/start", undefined, { headers: { "x-forwarded-for": `203.0.113.${i}` } });
      statuses.push(r.status);
    }
    expect(statuses.filter((x) => x === 302).length).toBe(30);
    expect(statuses.filter((x) => x === 429).length).toBe(5);
  });

  it("with one trusted hop, client-supplied prefixes are ignored and the limit holds under parallel requests", async () => {
    const ctx = await createAppContext({ ...sb.env, FORGE_TRUSTED_PROXY_HOPS: "1" }, { db: sb.ctx.db });
    const send = (spoof: string) =>
      dispatch(ctx, new Request("http://localhost:3000/api/auth/github/start", { headers: { "x-forwarded-for": `${spoof}, 198.51.100.77` } })).then((r) => r.status);
    const statuses = await Promise.all(Array.from({ length: 40 }, (_, i) => send(`192.0.2.${i}`)));
    expect(statuses.filter((x) => x === 302).length).toBe(30);
    expect(statuses.filter((x) => x === 429).length).toBe(10);
  });
});
