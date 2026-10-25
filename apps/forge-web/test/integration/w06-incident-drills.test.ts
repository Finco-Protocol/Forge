/**
 * W06 incident drills — ONLY the scenarios that W05's 15 drills did not
 * execute (docs/W06-DRILL-COVERAGE.md maps all 13). Local Anvil, test keys,
 * fake GitHub, in-process Postgres (PGlite). SANDBOX evidence: it proves the
 * application's behaviour and its own alert signals, NOT that production
 * monitoring is routed to a pager (operator item B06).
 *
 *   W-D1  GitHub App credentials compromised (webhook secret leaked)
 *   W-D12 failed launch transaction  -> LAUNCH_TX_FAILURES, no retry loop
 *   W-D16 stuck / dropped launch transaction -> no duplicate, no false confirmation
 *   W-D17 PostgreSQL outage -> fail closed (no signature), health reports, recovery
 *   W-D8  chain reorg -> rollback executed; DEEP_REORG alert signal (KNOWN_GAP, see test)
 *   W-D18 webhook backlog signal (KNOWN_GAP: the handler can never produce a backlog)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getAddress, type Abi, type Hex } from "viem";
import { ponsV2LaunchFactoryAbi } from "@/shared/abis.generated";
import { dispatch } from "@/server/api/handlers";
import { createAppContext } from "@/server/context";
import { runWorkerOnce } from "@/server/worker";
import { refreshIntent } from "@/server/launch/service";
import { collectSignals, evaluateAlerts } from "@/server/ops/monitor";
import { setControl } from "@/server/ops/controls";
import { signWebhookBody } from "@/server/github/webhooks";
import type { Db } from "@/server/db";
import { startSandbox, chainClients, TestBrowser, type Sandbox } from "../helpers/sandbox";
import { freshScenario, governanceWrite, launchThroughApi, signedLaunch } from "../helpers/scenario";
import { rpc } from "../helpers/anvil";

let sb: Sandbox;
beforeAll(async () => {
  sb = await startSandbox({ FORGE_OPS_TOKEN: "ops-token-for-w06-drills-0123456789abcdef" });
}, 180_000);
afterAll(async () => sb?.stop());

const alerts = async (finance = false) => evaluateAlerts(await collectSignals(sb.ctx, { finance })).map((a) => a.id);
const isActive = async (repoId: number, creator: `0x${string}`) => {
  const { forgeBindingRegistryAbi } = await import("@/shared/abis.generated");
  return sb.ctx.client.readContract({ address: sb.deployment.registry, abi: forgeBindingRegistryAbi, functionName: "isActive", args: [BigInt(repoId), creator] });
};

async function sendLaunch(key: Hex, call: Awaited<ReturnType<typeof signedLaunch>>["call"], opts: { gas?: bigint; wait?: boolean } = {}) {
  const { wallet, pub } = chainClients(sb.anvil.url, key);
  const hash = await wallet.writeContract({
    address: sb.deployment.factory,
    abi: ponsV2LaunchFactoryAbi,
    functionName: "launchToken",
    args: [call.params, call.launchConfigId, call.pairToken, call.exemptions],
    value: call.value,
    ...(opts.gas ? { gas: opts.gas } : {}),
  });
  return { hash, receipt: opts.wait === false ? null : await pub.waitForTransactionReceipt({ hash }) };
}

describe("W-D1 GitHub App compromise: leaked webhook secret / stolen App key", () => {
  const post = (ctx: typeof sb.ctx, event: string, payload: unknown, secret: string) => {
    const body = JSON.stringify(payload);
    return dispatch(ctx, new Request("http://localhost:3000/api/github/webhook", { method: "POST", body, headers: { "x-hub-signature-256": signWebhookBody(secret, body), "x-github-delivery": randomUUID(), "x-github-event": event, "content-type": "application/json" } }));
  };

  it("an attacker holding the webhook secret can only NARROW (revocation, fail-safe) and can never widen eligibility or sign anything; rotating the secret kills the forged channel; lockdown is the immediate control", async () => {
    const s = await freshScenario(sb);
    await signedLaunch(sb, s.browser, s.key, s.draft); // active binding
    expect(await isActive(s.repoId, s.address)).toBe(true);
    const leaked = sb.env.GITHUB_WEBHOOK_SECRET!;

    // 0. Containment first: lockdown (immediate, off-chain). The alert fires.
    await setControl(sb.ctx.db, "emergency_lockdown", true, "W-D1 drill: webhook secret leaked", "drill-operator");
    expect(await alerts()).toContain("EMERGENCY_LOCKDOWN_ACTIVE");

    // 1. Attack with the leaked secret: a validly-signed 'deleted' narrows (revocation queued, on-chain revoke) …
    const forged = await post(sb.ctx, "repository", { action: "deleted", repository: { id: s.repoId, full_name: "x/y" } }, leaked);
    expect(forged.status).toBe(200);
    await runWorkerOnce(sb.ctx);
    expect(await isActive(s.repoId, s.address)).toBe(false); // DoS-only impact, and a recoverable one

    // 2. … but a forged "good news" event cannot restore anything (installation re-created / unsuspend / publicized / unarchived).
    for (const [ev, p] of [
      ["installation", { action: "created", installation: { id: s.installationId, account: { id: s.org.id, login: s.org.login, type: "Organization" } } }],
      ["installation", { action: "unsuspend", installation: { id: s.installationId } }],
      ["repository", { action: "unarchived", repository: { id: s.repoId, full_name: "x/y" } }],
    ] as const) {
      expect((await post(sb.ctx, ev, p, leaked)).status).toBe(200);
    }
    await runWorkerOnce(sb.ctx);
    expect(await isActive(s.repoId, s.address)).toBe(false);
    const live = await sb.ctx.db.query("SELECT 1 FROM verifications WHERE repo_id = $1 AND revoked_at IS NULL AND expires_at > now()", [s.repoId]);
    expect(live.rows.length).toBe(0);

    // 3. Recovery step: rotate the webhook secret (new process config) and make the rotated context the
    //    ACTIVE application context. The TestBrowser and every dispatch below read sb.ctx per request, so
    //    from here on the sandbox and its browser genuinely run on the rotated secret — a deliberately
    //    reverted active context would accept the old signature and fail this drill at 3a/3b.
    const rotatedSecret = "rotated-webhook-secret-0123456789abcdef-new";
    const rotated = await createAppContext({ ...sb.env, GITHUB_WEBHOOK_SECRET: rotatedSecret }, { db: sb.ctx.db });
    sb.ctx = rotated;
    sb.env.GITHUB_WEBHOOK_SECRET = rotatedSecret;
    const rejections = async () =>
      Number((await sb.ctx.db.query<{ n: string }>("SELECT count(*)::text n FROM audit_events WHERE action = 'webhook_signature_rejected'")).rows[0]!.n);
    const before = await rejections();

    // 3a. The leaked secret is rejected by the ACTIVE route, and the rejection is audited.
    expect((await post(sb.ctx, "repository", { action: "deleted", repository: { id: s.repoId, full_name: "x/y" } }, leaked)).status).toBe(401);
    expect(await rejections()).toBe(before + 1);

    // 3b. The new secret is accepted by the ACTIVE route (a legitimately signed benign event is processed) —
    //     and even a validly signed good-news event cannot restore eligibility without a fresh verification.
    const withNew = await post(sb.ctx, "repository", { action: "unarchived", repository: { id: s.repoId, full_name: "x/y" } }, rotatedSecret);
    expect(withNew.status).toBe(200);
    expect(((await withNew.json()) as { processed?: boolean }).processed).toBe(true);
    await runWorkerOnce(sb.ctx);
    expect(await isActive(s.repoId, s.address)).toBe(false);

    // 4. Release lockdown. The old secret is STILL rejected by the active route after lockdown: an old-key
    //    webhook can neither revoke again, nor restore, nor otherwise modify repository verification.
    await setControl(sb.ctx.db, "emergency_lockdown", false, "W-D1 drill complete", "drill-operator");
    expect(await alerts()).not.toContain("EMERGENCY_LOCKDOWN_ACTIVE");
    const afterLockdown = await rejections();
    for (const [ev, action, p] of [
      ["repository", "deleted", { action: "deleted", repository: { id: s.repoId, full_name: "x/y" } }],
      ["installation", "created", { action: "created", installation: { id: s.installationId, account: { id: s.org.id, login: s.org.login, type: "Organization" } } }],
      ["installation", "unsuspend", { action: "unsuspend", installation: { id: s.installationId } }],
      ["repository", "unarchived", { action: "unarchived", repository: { id: s.repoId, full_name: "x/y" } }],
    ] as const) {
      expect((await post(sb.ctx, ev, p, leaked)).status, `${ev}.${action} must stay rejected after lockdown`).toBe(401);
    }
    expect(await rejections()).toBe(afterLockdown + 4);
    await runWorkerOnce(sb.ctx);
    expect(await isActive(s.repoId, s.address)).toBe(false); // no unexpected revocation, no restoration
    const revokedStill = await sb.ctx.db.query("SELECT 1 FROM verifications WHERE repo_id = $1 AND revoked_at IS NULL AND expires_at > now()", [s.repoId]);
    expect(revokedStill.rows.length).toBe(0);

    // 5. A legitimate user must re-verify from scratch (the repository was marked ineligible by the forged
    //    event); the fresh full verification runs through the rotated, active application and restores service.
    const re = await s.browser.post("/api/github/verify", { repoId: s.repoId, installationId: s.installationId });
    expect(re.status).toBe(200); // GitHub (the fake) still shows the user as admin: a fresh full verification restores service
    const restored = await sb.ctx.db.query("SELECT 1 FROM verifications WHERE repo_id = $1 AND revoked_at IS NULL AND expires_at > now()", [s.repoId]);
    expect(restored.rows.length).toBe(1);
  });
});

describe("W-D12 failed launch transaction", () => {
  it("a reverted launch raises LAUNCH_TX_FAILURES, is reported with its reason and a recovery path, and is never retried automatically", async () => {
    const s = await freshScenario(sb);
    const l = await signedLaunch(sb, s.browser, s.key, s.draft);
    const cfg = await sb.ctx.client.readContract({ address: sb.deployment.factory, abi: ponsV2LaunchFactoryAbi, functionName: "getLaunchConfig", args: [0n] });
    await governanceWrite(sb, sb.deployment.factory, ponsV2LaunchFactoryAbi as unknown as Abi, "updateLaunchConfig", [0n, { ...cfg, enabled: false }]);
    let sent;
    try {
      sent = await sendLaunch(s.key, l.call, { gas: 5_000_000n });
    } finally {
      await governanceWrite(sb, sb.deployment.factory, ponsV2LaunchFactoryAbi as unknown as Abi, "updateLaunchConfig", [0n, { ...cfg, enabled: true }]);
    }
    expect(sent.receipt!.status).toBe("reverted");
    const r = await s.browser.post(`/api/launch/intents/${l.auth.json.intentId}/submitted`, { txHash: sent.hash });
    expect(r.json.status).toBe("failed");
    expect(await alerts()).toContain("LAUNCH_TX_FAILURES");
    // No automatic retry: another worker pass leaves the failed intent failed and sends nothing.
    const nonce = await sb.ctx.client.getTransactionCount({ address: sb.ctx.relayer.account.address });
    await runWorkerOnce(sb.ctx);
    expect((await s.browser.get(`/api/launch/intents/${l.auth.json.intentId}`)).json.status).toBe("failed");
    expect(await sb.ctx.client.getTransactionCount({ address: sb.ctx.relayer.account.address })).toBe(nonce);
    expect(r.json.recovery).toMatch(/Re-authorize/);
  });
});

describe("W-D16 stuck / dropped launch transaction", () => {
  it("a pending (unmined) launch is never reported confirmed, blocks a duplicate authorization, and confirms exactly once when mined", async () => {
    const s = await freshScenario(sb);
    const l = await signedLaunch(sb, s.browser, s.key, s.draft);
    await rpc(sb.anvil.url, "evm_setAutomine", [false]);
    let hash: Hex;
    try {
      hash = (await sendLaunch(s.key, l.call, { wait: false })).hash;
      const sub = await s.browser.post(`/api/launch/intents/${l.auth.json.intentId}/submitted`, { txHash: hash });
      expect(sub.status).toBe(200);
      expect(sub.json.status).toBe("submitted"); // pending: not included, not confirmed
      await runWorkerOnce(sb.ctx);
      expect((await refreshIntent(sb.ctx, l.auth.json.intentId)).status).toBe("submitted");
      expect((await s.browser.post(`/api/launch/drafts/${l.draft.json.id}/authorize`)).json.error.code).toBe("LAUNCH_IN_FLIGHT");
      expect((await sb.ctx.db.query("SELECT 1 FROM tokens WHERE launch_tx = $1", [hash])).rows.length).toBe(0);
    } finally {
      await rpc(sb.anvil.url, "evm_setAutomine", [true]);
    }
    await rpc(sb.anvil.url, "evm_mine");
    await runWorkerOnce(sb.ctx);
    expect((await refreshIntent(sb.ctx, l.auth.json.intentId)).status).toBe("confirmed");
    expect((await sb.ctx.db.query("SELECT 1 FROM tokens WHERE launch_tx = $1", [hash!])).rows.length).toBe(1);
  });

  it("a launch transaction that is DROPPED from the mempool never confirms; the intent expires with a recovery path and the nonce stays unconsumed (a fresh authorization works)", async () => {
    const s = await freshScenario(sb);
    const l = await signedLaunch(sb, s.browser, s.key, s.draft);
    await rpc(sb.anvil.url, "evm_setAutomine", [false]);
    let hash: Hex;
    try {
      hash = (await sendLaunch(s.key, l.call, { wait: false })).hash;
      await s.browser.post(`/api/launch/intents/${l.auth.json.intentId}/submitted`, { txHash: hash });
      await rpc(sb.anvil.url, "anvil_dropTransaction", [hash]);
    } finally {
      await rpc(sb.anvil.url, "evm_setAutomine", [true]);
    }
    expect((await refreshIntent(sb.ctx, l.auth.json.intentId)).status).toBe("submitted"); // dropped but not yet expired: still no false failure
    await rpc(sb.anvil.url, "evm_increaseTime", [3600 * 24]); // past the authorization expiry
    await rpc(sb.anvil.url, "evm_mine");
    const r = await refreshIntent(sb.ctx, l.auth.json.intentId);
    expect(r.status).toBe("expired");
    expect(r.failureReason).toBe("transaction_dropped");
    expect(r.recovery).toMatch(/Re-authorize/);
    expect((await sb.ctx.db.query("SELECT 1 FROM tokens WHERE launch_tx = $1", [hash!])).rows.length).toBe(0);
    const again = await s.browser.post(`/api/launch/drafts/${l.draft.json.id}/authorize`);
    expect(again.status).toBe(200);
  });
});

describe("W-D17 PostgreSQL outage", () => {
  it("while the database is unreachable nothing is signed, nothing is sent, /api/health goes unhealthy, and service resumes without manual repair", async () => {
    const real = sb.ctx.db;
    let down = false;
    const gate = (name: string, f: (...a: unknown[]) => unknown) => (...a: unknown[]) => {
      if (down) {
        if (name === "stats") return f(...a);
        return Promise.reject(new Error("connection terminated unexpectedly (simulated PostgreSQL outage)"));
      }
      return f(...a);
    };
    const flakyDb = new Proxy(real, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        return typeof v === "function" ? gate(String(prop), (v as (...a: unknown[]) => unknown).bind(target)) : v;
      },
    }) as Db;
    const ctx = await createAppContext(sb.env, { db: flakyDb });
    const s = await freshScenario(sb);
    const draft = await s.browser.post("/api/launch/drafts", s.draft);
    expect(draft.status).toBe(201);
    const browser = new TestBrowser({ ...sb, ctx } as Sandbox);
    for (const [k, v] of s.browser.cookies) browser.cookies.set(k, v);

    const countSigned = async () => Number((await real.query<{ n: string }>("SELECT count(*)::text n FROM signing_requests WHERE decision = 'allowed'")).rows[0]!.n);
    const signedBefore = await countSigned();
    const relayerNonce = await sb.ctx.client.getTransactionCount({ address: sb.ctx.relayer.account.address });

    down = true;
    const health = await dispatch(ctx, new Request("http://localhost:3000/api/health"));
    const hb = (await health.json()) as { db?: { ok?: boolean }; ok?: boolean };
    // OBSERVATION (product, not fixed here): src/server/ops/health.ts promises 'one failing probe is reported, never thrown',
    // but the handler also awaits revocationHealth() outside those guards, so a DB outage turns /api/health into HTTP 500 with
    // no diagnostic body. It is still a clear 'unhealthy' signal for an external probe; the body is the gap.
    expect(health.status === 500 || hb.db?.ok === false || hb.ok === false).toBe(true);
    const auth = await browser.post(`/api/launch/drafts/${draft.json.id}/authorize`);
    expect(auth.status).toBeGreaterThanOrEqual(400);
    await expect(runWorkerOnce(ctx)).rejects.toThrow();
    down = false;

    expect(await countSigned()).toBe(signedBefore); // no signature was issued while the DB was down
    expect(await sb.ctx.client.getTransactionCount({ address: sb.ctx.relayer.account.address })).toBe(relayerNonce);

    const recovered = await browser.post(`/api/launch/drafts/${draft.json.id}/authorize`);
    expect(recovered.status).toBe(200);
    expect(await countSigned()).toBeGreaterThan(signedBefore); // authorization (binding op + attestation) resumes by itself
    await expect(runWorkerOnce(ctx)).resolves.toBeTruthy();
  });
});

describe("W-D8 chain reorg", () => {
  async function reorg() {
    const sc = await freshScenario(sb);
    await runWorkerOnce(sb.ctx);
    const snap = await rpc<string>(sb.anvil.url, "evm_snapshot");
    const l = await launchThroughApi(sb, sc.browser, sc.key, sc.draft);
    const token = getAddress(l.submitted.json.token);
    const pass1 = await runWorkerOnce(sb.ctx);
    expect(pass1.receipts).toContain(token);
    await rpc(sb.anvil.url, "evm_revert", [snap]);
    for (let i = 0; i < 6; i++) await rpc(sb.anvil.url, "evm_mine");
    const pass2 = await runWorkerOnce(sb.ctx);
    return { token, pass2 };
  }

  it("EXECUTED: the orphaned launch is rolled back and its receipt retracted (never deleted)", async () => {
    const { token, pass2 } = await reorg();
    expect(pass2.reorgedTo).not.toBeNull();
    expect(pass2.retractions).toContain(token);
    expect((await sb.ctx.db.query("SELECT 1 FROM tokens WHERE token = $1", [token])).rows.length).toBe(0);
  });

  // KNOWN_GAP (product defect, NOT fixed here): the DEEP_REORG rule reads audit_events rows whose action LIKE 'ALERT:reorg%',
  // but no production code path ever writes such a row, so the alert cannot fire after a real reorg. This test states the
  // DESIRED behaviour and is marked `fails`: it passes while the gap exists and will FAIL (loudly) once the indexer starts
  // emitting the alert, at which point the marker must be removed and docs/W06-DRILL-COVERAGE.md updated.
  it.fails("KNOWN_GAP DEEP_REORG: after a real reorg the DEEP_REORG alert should be firing", async () => {
    await reorg();
    expect(await alerts()).toContain("DEEP_REORG");
  });
});

describe("W-D18 webhook backlog signal", () => {
  it("the WEBHOOK_BACKLOG rule itself works on an unprocessed delivery row, but the real handler can never leave one (KNOWN_GAP: failed deliveries are invisible to monitoring)", async () => {
    const id = randomUUID();
    await sb.ctx.db.query("INSERT INTO webhook_deliveries(delivery_id, event, action, payload_sha256, received_at) VALUES ($1,'repository','archived','x', now() - interval '1 hour')", [id]);
    expect(await alerts()).toContain("WEBHOOK_BACKLOG");
    await sb.ctx.db.query("DELETE FROM webhook_deliveries WHERE delivery_id = $1", [id]);
    expect(await alerts()).not.toContain("WEBHOOK_BACKLOG");

    // A delivery that fails mid-processing is rolled back with its record (so GitHub's redelivery works) -> no row, no backlog, no alert.
    const body = JSON.stringify({ action: "transferred", repository: { id: "not-a-number", full_name: "a/b" } });
    const res = await dispatch(sb.ctx, new Request("http://localhost:3000/api/github/webhook", { method: "POST", body, headers: { "x-hub-signature-256": signWebhookBody(sb.env.GITHUB_WEBHOOK_SECRET!, body), "x-github-delivery": randomUUID(), "x-github-event": "repository" } }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    const backlog = await sb.ctx.db.query("SELECT 1 FROM webhook_deliveries WHERE processed_at IS NULL");
    expect(backlog.rows.length).toBe(0);
    expect(await alerts()).not.toContain("WEBHOOK_BACKLOG");
  });
});
