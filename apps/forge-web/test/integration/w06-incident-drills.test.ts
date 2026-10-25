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
 *   W-D8  chain reorg -> rollback executed; durable reorg evidence; DEEP_REORG by depth (W07)
 *   W-D18 webhook delivery lifecycle (W07): durable receipts, bounded retries, terminal alerts
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
    const hb = (await health.json()) as { db?: { ok?: boolean }; ok?: boolean; failing?: string[] };
    // W07 fix: the outage is now a CONTROLLED, structured 503 (the W06 defect was an
    // unstructured 500: revocationHealth() threw outside the per-probe guards).
    expect(health.status).toBe(503);
    expect(hb.ok).toBe(false);
    expect(hb.db?.ok).toBe(false);
    expect(Array.isArray(hb.failing) && hb.failing.includes("db")).toBe(true);
    // Liveness is a separate endpoint that touches no dependency.
    const live = await dispatch(ctx, new Request("http://localhost:3000/api/live"));
    expect(live.status).toBe(200);
    // Readiness refuses while the database is down.
    const ready = await dispatch(ctx, new Request("http://localhost:3000/api/ready"));
    expect(ready.status).toBe(503);
    const auth = await browser.post(`/api/launch/drafts/${draft.json.id}/authorize`);
    expect(auth.status).toBeGreaterThanOrEqual(400);
    await expect(runWorkerOnce(ctx)).rejects.toThrow();
    down = false;

    // Automatic recovery: health, readiness and authorization all resume by themselves.
    expect(await countSigned()).toBe(signedBefore); // no signature was issued while the DB was down
    expect(await sb.ctx.client.getTransactionCount({ address: sb.ctx.relayer.account.address })).toBe(relayerNonce);

    const recovered = await browser.post(`/api/launch/drafts/${draft.json.id}/authorize`);
    expect(recovered.status).toBe(200);
    const healthAfter = await dispatch(ctx, new Request("http://localhost:3000/api/health"));
    expect(healthAfter.status).toBe(200);
    const readyAfter = await dispatch(ctx, new Request("http://localhost:3000/api/ready"));
    expect(readyAfter.status).toBe(200);
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

  // W07: the DEEP_REORG KNOWN_GAP is fixed. The indexer now writes durable reorg evidence
  // (ALERT:reorg, with depth and affected range) atomically with its rollback, and the alert
  // fires only when the recorded depth crosses the configured threshold (default 2 blocks).
  // Construction: the checkpoint is advanced onto blocks that carry real transactions (an
  // empty re-mined block can be hash-identical on Anvil, so orphans must contain txs), then
  // the snapshot is reverted: the canonical re-mined blocks are empty and diverge.
  const ANVIL_RICH = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // anvil dev account #0 (unlocked)
  const sendPlainTx = async (box: Sandbox = sb) => {
    const hash = await rpc<Hex>(box.anvil.url, "eth_sendTransaction", [{ from: ANVIL_RICH, to: "0x000000000000000000000000000000000000dEaD", value: "0x1" }]);
    for (let i = 0; i < 50; i++) {
      const r = await rpc<{ status: string } | null>(box.anvil.url, "eth_getTransactionReceipt", [hash]);
      if (r) return;
      await new Promise((x) => setTimeout(x, 50));
    }
    throw new Error("plain tx not mined");
  };

  it("W07 DEEP_REORG: a shallow (1-block) reorg stays evidence-only below the alert threshold", async () => {
    // Its own sandbox: the 24h alert window is global per database, so evidence from the
    // other drills (a depth-2 reorg legitimately fired above) must not leak into this assertion.
    const own = await startSandbox();
    try {
      await freshScenario(own);
      await runWorkerOnce(own.ctx);
      const snap = await rpc<string>(own.anvil.url, "evm_snapshot");
      await sendPlainTx(own); // block snap+1
      await runWorkerOnce(own.ctx); // checkpoint = snapshot + 1
      await rpc(own.anvil.url, "evm_revert", [snap]);
      for (let i = 0; i < 6; i++) await rpc(own.anvil.url, "evm_mine");
      const pass = await runWorkerOnce(own.ctx);
      expect(pass.reorgedTo).not.toBeNull();
      const row = (await own.ctx.db.query<{ detail: { depth: string } }>(
        "SELECT detail FROM audit_events WHERE action = 'ALERT:reorg' ORDER BY id DESC LIMIT 1",
      )).rows[0]!;
      expect(Number(row.detail.depth)).toBe(1); // evidence is still recorded...
      const shallowAlerts = evaluateAlerts(await collectSignals(own.ctx)).map((a) => a.id);
      expect(shallowAlerts).not.toContain("DEEP_REORG"); // ...but 1 block is below the alert threshold
    } finally {
      await own.stop();
    }
  });
  it("W07 DEEP_REORG: a real reorg is durably recorded exactly once with depth and range, and the alert fires past the threshold", async () => {
    await freshScenario(sb); // realistic indexed history
    await runWorkerOnce(sb.ctx);
    const snap = await rpc<string>(sb.anvil.url, "evm_snapshot");
    await sendPlainTx(); // block snap+1 (real tx content)
    await sendPlainTx(); // block snap+2
    await runWorkerOnce(sb.ctx); // checkpoint = snapshot + 2
    await rpc(sb.anvil.url, "evm_revert", [snap]);
    for (let i = 0; i < 6; i++) await rpc(sb.anvil.url, "evm_mine");
    const pass = await runWorkerOnce(sb.ctx);
    expect(pass.reorgedTo).not.toBeNull();
    const row = (await sb.ctx.db.query<{ detail: { depth: string; affectedFrom: string; affectedTo: string } }>(
      "SELECT detail FROM audit_events WHERE action = 'ALERT:reorg' ORDER BY id DESC LIMIT 1",
    )).rows[0]!;
    expect(Number(row.detail.depth)).toBe(2); // exactly the two orphaned blocks
    expect(Number(row.detail.affectedFrom)).toBeLessThan(Number(row.detail.affectedTo)); // the affected indexed range is recorded
    expect(await alerts()).toContain("DEEP_REORG");
    // Exactly once: further worker passes must not re-record the same reorg...
    const n = Number((await sb.ctx.db.query<{ n: string }>("SELECT count(*)::text AS n FROM audit_events WHERE action = 'ALERT:reorg'")).rows[0]!.n);
    await runWorkerOnce(sb.ctx);
    expect(Number((await sb.ctx.db.query<{ n: string }>("SELECT count(*)::text AS n FROM audit_events WHERE action = 'ALERT:reorg'")).rows[0]!.n)).toBe(n);
    // ...and the evidence is durable DB state, so it stays discoverable (e.g. after a worker restart).
    expect(await alerts()).toContain("DEEP_REORG");
  });

});

describe("W-D18 webhook backlog signal", () => {
  it("the WEBHOOK_BACKLOG rule fires on unprocessed delivery rows and clears with them", async () => {
    const id = randomUUID();
    await sb.ctx.db.query("INSERT INTO webhook_deliveries(delivery_id, event, action, payload_sha256, received_at) VALUES ($1,'repository','archived','x', now() - interval '1 hour')", [id]);
    expect(await alerts()).toContain("WEBHOOK_BACKLOG");
    await sb.ctx.db.query("DELETE FROM webhook_deliveries WHERE delivery_id = $1", [id]);
    expect(await alerts()).not.toContain("WEBHOOK_BACKLOG");
  });

  // W07: the WEBHOOK_BACKLOG KNOWN_GAP is fixed. A delivery is durably RECEIVED (its own
  // transaction, after constant-time signature verification) BEFORE processing; a processing
  // failure leaves the receipt behind with its attempt count and retry schedule, the worker
  // retries it with capped backoff to a terminal `failed` state (audited), and a genuine
  // GitHub redelivery re-activates it. Failed deliveries are observable and recoverable.
  it("W07 lifecycle: a failing delivery is durably recorded, retried to terminal, alerted, and redelivery re-activates it", async () => {
    // A validly signed payload the processor cannot handle (invalid repo id): the old code
    // rolled the delivery record back entirely; the new code keeps the durable receipt.
    const bad = JSON.stringify({ action: "transferred", repository: { id: "not-a-number", full_name: "a/b" } });
    const deliveryId = randomUUID();
    const res = await dispatch(sb.ctx, new Request("http://localhost:3000/api/github/webhook", { method: "POST", body: bad, headers: { "x-hub-signature-256": signWebhookBody(sb.env.GITHUB_WEBHOOK_SECRET!, bad), "x-github-delivery": deliveryId, "x-github-event": "repository" } }));
    expect(res.status).toBeGreaterThanOrEqual(500); // GitHub is told it failed, too
    const row = (await sb.ctx.db.query<{ status: string; attempts: string; last_error: string; signature_verified: boolean; body: string }>(
      "SELECT status, attempts::text, last_error, signature_verified, body FROM webhook_deliveries WHERE delivery_id = $1",
      [deliveryId],
    )).rows[0]!;
    expect(row.status).toBe("received");
    expect(Number(row.attempts)).toBe(1);
    expect(row.last_error).toBeTruthy();
    expect(row.signature_verified).toBe(true);
    expect(row.body).toBe(bad); // the durable receipt holds the verified body for retries

    // The worker retries with capped backoff until the terminal state...
    let pass: Awaited<ReturnType<typeof runWorkerOnce>> | null = null;
    for (let i = 0; i < 12; i++) {
      const st = (await sb.ctx.db.query<{ status: string; attempts: string }>("SELECT status, attempts::text FROM webhook_deliveries WHERE delivery_id = $1", [deliveryId])).rows[0]!;
      if (st.status === "failed") break;
      await sb.ctx.db.query("UPDATE webhook_deliveries SET next_retry_at = now() WHERE delivery_id = $1", [deliveryId]); // skip the backoff wait
      pass = await runWorkerOnce(sb.ctx);
    }
    const terminal = (await sb.ctx.db.query<{ status: string; attempts: string }>("SELECT status, attempts::text FROM webhook_deliveries WHERE delivery_id = $1", [deliveryId])).rows[0]!;
    expect(terminal.status).toBe("failed");
    expect(Number(terminal.attempts)).toBe(sb.ctx.cfg.worker.webhookMaxAttempts);
    expect(pass?.webhookRetries ?? 0).toBeGreaterThan(0);
    expect((await sb.ctx.db.query("SELECT 1 FROM audit_events WHERE action = 'ALERT:webhook_delivery_failed'")).rows.length).toBeGreaterThan(0);

    // ...and both delivery alerts are reachable from the real durable state.
    expect(await alerts()).toContain("WEBHOOK_DELIVERIES_FAILED"); // terminal failures have their own rule (backlog = unprocessed 'received' rows)

    // A genuine GitHub redelivery of the same GUID re-activates and processes it.
    // (unarchived for an unknown repo: fully processed, no side effects, no jobs)
    const good = JSON.stringify({ action: "unarchived", repository: { id: 5500, full_name: "a/b" } });
    const redelivered = await dispatch(sb.ctx, new Request("http://localhost:3000/api/github/webhook", { method: "POST", body: good, headers: { "x-hub-signature-256": signWebhookBody(sb.env.GITHUB_WEBHOOK_SECRET!, good), "x-github-delivery": deliveryId, "x-github-event": "repository" } }));
    expect(redelivered.status).toBe(200);
    const done = (await sb.ctx.db.query<{ status: string; outcome: string; body: string }>("SELECT status, outcome, body FROM webhook_deliveries WHERE delivery_id = $1", [deliveryId])).rows[0]!;
    expect(done.status).toBe("processed");
    expect(done.body).toBe(good); // the receipt describes exactly what was processed
    expect(done.outcome).toContain("unarchived");
    expect(await alerts()).not.toContain("WEBHOOK_DELIVERIES_FAILED");
  });

  it("W07 malformed payload: a valid signature over invalid JSON is a controlled 400 with audit evidence, and changes nothing", async () => {
    const bodies = ["{not json", "null", "[1,2,3]", '"text"'];
    const before = await sb.ctx.db.query("SELECT 1 FROM webhook_deliveries");
    const auditsBefore = Number((await sb.ctx.db.query<{ n: string }>("SELECT count(*)::text AS n FROM audit_events WHERE action = 'webhook_invalid_payload'")).rows[0]!.n);
    for (const b of bodies) {
      const res = await dispatch(sb.ctx, new Request("http://localhost:3000/api/github/webhook", { method: "POST", body: b, headers: { "x-hub-signature-256": signWebhookBody(sb.env.GITHUB_WEBHOOK_SECRET!, b), "x-github-delivery": randomUUID(), "x-github-event": "repository" } }));
      expect(res.status, `payload ${b}`).toBe(400);
      const j = (await res.json()) as { error?: { code?: string } };
      expect(j.error?.code).toBe("INVALID_PAYLOAD");
    }
    expect(Number((await sb.ctx.db.query<{ n: string }>("SELECT count(*)::text AS n FROM audit_events WHERE action = 'webhook_invalid_payload'")).rows[0]!.n)).toBe(auditsBefore + bodies.length);
    expect((await sb.ctx.db.query("SELECT 1 FROM webhook_deliveries WHERE received_at > now() - interval '1 minute' AND status <> 'processed'")).rows.length).toBe(0); // no receipt, no queued work
    expect(before.rows.length).toBe((await sb.ctx.db.query("SELECT 1 FROM webhook_deliveries")).rows.length); // no state change
  });
});
