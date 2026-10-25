/**
 * W07 alert reachability: every NEW alert rule must be reachable through the
 * REAL application code paths (controls, guard, indexer, worker, handler) —
 * not by hand-inserting artificial alert rows. Signals are read from the same
 * durable state production reads; rules are evaluated by the production
 * evaluateAlerts. WEBHOOK_DELIVERIES_FAILED / WEBHOOK_BACKLOG / DEEP_REORG and
 * the malformed-payload handling are covered by the W06 incident drills
 * (updated for the W07 lifecycle) — not duplicated here.
 */
import { createServer, request as httpRequest, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindingOpTypes, registryDomain } from "@/shared/forge-typed-data";
import type { AppContext } from "@/server/context";
import { collectSignals, evaluateAlerts } from "@/server/ops/monitor";
import { engageKillSwitch, releaseKillSwitch, revokeSignerKey } from "@/server/signer/controls";
import { recordHeartbeat, runWorkerOnce } from "@/server/worker";
import { dispatch } from "@/server/api/handlers";
import { launchThroughApi } from "../helpers/scenario";
import { rpc } from "../helpers/anvil";
import { startSandbox, type Sandbox } from "../helpers/sandbox";
import { zeroAddress } from "viem";

let sb: Sandbox;
beforeAll(async () => {
  sb = await startSandbox({ FORGE_OPS_TOKEN: "ops-token-for-w07-monitoring-0123456789abcdef" });
}, 180_000);
afterAll(async () => sb?.stop());

const firing = async (ctx: AppContext = sb.ctx) => evaluateAlerts(await collectSignals(ctx)).map((a) => a.id);
let n = 0;

describe("W07 alert reachability: signer controls", () => {
  it("engaging the kill switch raises SIGNER_KILL_SWITCH through the real control; releasing it clears the alert", async () => {
    expect(await firing()).not.toContain("SIGNER_KILL_SWITCH");
    await engageKillSwitch(sb.ctx.db, "authority", "w07-drill", "kill switch reachability drill");
    expect(await firing()).toContain("SIGNER_KILL_SWITCH");
    await releaseKillSwitch(sb.ctx.db, "authority", "w07-drill", "drill over");
    expect(await firing()).not.toContain("SIGNER_KILL_SWITCH");
  });

});

describe("W07 alert reachability: signing guard denials from authority inconsistency", () => {
  /** A JSON-RPC pass-through that can be switched off (the RPC-outage path). */
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

  it("repeated fail-closed refusals while the RPC is unreachable raise AUTHORITY_SIGNING_REFUSALS (real guard denials)", async () => {
    const { createAppContext } = await import("@/server/context");
    const proxy = await startRpcProxy(sb.anvil.url);
    try {
      // A context that STARTED while the RPC was reachable, then lost it: every signing
      // request is denied fail-closed by the guard and appended to signer_audit.
      proxy.up = true;
      const ctx2 = await createAppContext({ ...sb.env, FORGE_RPC_URL: proxy.url }, { db: sb.ctx.db });
      proxy.up = false;
      const guard = ctx2.signers.guarded("authority")!;
      for (let i = 0; i < 3; i++) {
        await expect(
          guard.signTypedData(
            { domain: registryDomain(31337, sb.deployment.registry), types: bindingOpTypes, primaryType: "BindingOp", message: { githubRepoId: BigInt(++n), creator: zeroAddress, bindingExpiresAt: 4_000_000_000n, opDeadline: 4_000_000_000n, opNonce: BigInt(n), parentOpDigest: `0x${"00".repeat(32)}`, repoFullName: "o/r", revoke: false } },
            { requestedBy: "w07-monitoring", correlationId: `w07-auth-${++n}` },
          ),
        ).rejects.toThrow();
      }
      expect(await firing(ctx2)).toContain("AUTHORITY_SIGNING_REFUSALS");
      // ctx2 shares the sandbox's database handle — never close it here (the sandbox owns it).
    } finally {
      proxy.server.close();
    }
  });
});

describe("W07 alert reachability: launch transactions", () => {
  it("a transaction left pending/submitted for over 30 minutes raises STUCK_LAUNCH_TRANSACTIONS and clears once confirmed", async () => {
    const s = await freshScenario(); // signs, authorizes and sends the launch tx (left unmined)
    const sub = await s.browser.post(`/api/launch/intents/${s.intentId}/submitted`, { txHash: s.pendingHash });
    expect(sub.status).toBe(200);
    // backdate the intent so the 30-minute stuck window is crossed without waiting
    await sb.ctx.db.query("UPDATE launch_intents SET updated_at = now() - interval '31 minutes' WHERE id = $1", [s.intentId]);
    expect(await firing()).toContain("STUCK_LAUNCH_TRANSACTIONS");
    await rpc(sb.anvil.url, "evm_mine");
    await runWorkerOnce(sb.ctx);
    expect(await firing()).not.toContain("STUCK_LAUNCH_TRANSACTIONS"); // confirmed: no longer stuck
  });
});

describe("W07 alert reachability: infrastructure", () => {
  it("a database outage yields a STRUCTURED signal (dbOk=false) and fires DB_UNAVAILABLE without throwing", async () => {
    const real = sb.ctx.db;
    let down = false;
    const flaky = new Proxy(real, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (down && typeof v === "function" && prop !== "stats" && prop !== "close") {
          return () => Promise.reject(new Error("connection terminated unexpectedly (simulated PostgreSQL outage)"));
        }
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as AppContext["db"];
    const ctx = { ...sb.ctx, db: flaky } as AppContext;
    down = true;
    const f = await firing(ctx);
    expect(f).toContain("DB_UNAVAILABLE");
    expect(f).not.toContain("EMERGENCY_LOCKDOWN_ACTIVE"); // no false positives from the empty snapshot
    down = false;
    expect(await firing()).not.toContain("DB_UNAVAILABLE"); // automatic recovery
  });

  it("a worker that stopped beating raises WORKER_UNHEALTHY; a fresh heartbeat clears it", async () => {
    const w = { id: "w07-drill-worker", applicationName: "w07-drill" };
    await recordHeartbeat(sb.ctx.db, w, "running");
    expect(await firing()).not.toContain("WORKER_UNHEALTHY");
    await sb.ctx.db.query("UPDATE worker_heartbeats SET beat_at = now() - interval '1 hour' WHERE worker_id = $1", [w.id]);
    expect(await firing()).toContain("WORKER_UNHEALTHY");
    await recordHeartbeat(sb.ctx.db, w, "running"); // the real writer recovers it
    expect(await firing()).not.toContain("WORKER_UNHEALTHY");
  });

  it("a spike of rejected webhook signatures raises WEBHOOK_SIGNATURE_REJECTED_SPIKE (real handler rejections)", async () => {
    const body = JSON.stringify({ action: "unarchived", repository: { id: 1, full_name: "a/b" } });
    for (let i = 0; i < 21; i++) {
      const res = await dispatch(sb.ctx, new Request("http://localhost:3000/api/github/webhook", { method: "POST", body, headers: { "x-hub-signature-256": "sha256=deadbeef", "x-github-delivery": crypto.randomUUID(), "x-github-event": "repository" } }));
      expect(res.status).toBe(401);
    }
    expect(await firing()).toContain("WEBHOOK_SIGNATURE_REJECTED_SPIKE");
  });
});

// ── helpers (local freshScenario that returns the browser + draft + a pending launch tx) ──
import { freshScenario as baseFreshScenario, signedLaunch } from "../helpers/scenario";
import { chainClients } from "../helpers/sandbox";
import { ponsV2LaunchFactoryAbi } from "@/shared/abis.generated";
import type { Hex } from "viem";

function freshScenario() {
  return baseFreshScenario(sb).then(async (s) => {
    const l = await signedLaunch(sb, s.browser, s.key, s.draft);
    const { wallet } = chainClients(sb.anvil.url, s.key);
    await rpc(sb.anvil.url, "evm_setAutomine", [false]);
    const pendingHash = await wallet.writeContract({
      address: sb.deployment.factory,
      abi: ponsV2LaunchFactoryAbi,
      functionName: "launchToken",
      args: [l.call.params, l.call.launchConfigId, l.call.pairToken, l.call.exemptions],
      value: l.call.value,
    });
    await rpc(sb.anvil.url, "evm_setAutomine", [true]);
    return { ...s, draft: l.draft, pendingHash: pendingHash as unknown as string, intentId: l.auth.json.intentId as string, auth: l.auth };
  });
}

describe("W07 alert reachability: emergency key revocation (runs LAST — it disables authority signing)", () => {
  it("revoking a signer key raises SIGNER_KEY_REVOKED and every later signing request stays refused (fail closed)", async () => {
    const address = sb.ctx.authority.address;
    expect(await firing()).not.toContain("SIGNER_KEY_REVOKED");
    await revokeSignerKey(sb.ctx.db, "authority", address, "w07-drill", "reachability drill: suspected compromise");
    expect(await firing()).toContain("SIGNER_KEY_REVOKED");
    // the revoked key never signs again (guard, fail closed, no custody call)
    await expect(
      sb.ctx.signers.guarded("authority")!.signTypedData(
        { domain: registryDomain(31337, sb.deployment.registry), types: bindingOpTypes, primaryType: "BindingOp", message: { githubRepoId: BigInt(++n), creator: zeroAddress, bindingExpiresAt: 4_000_000_000n, opDeadline: 4_000_000_000n, opNonce: BigInt(n), parentOpDigest: `0x${"00".repeat(32)}`, repoFullName: "o/r", revoke: false } },
        { requestedBy: "w07-monitoring", correlationId: `w07-revoked-${++n}` },
      ),
    ).rejects.toThrow(/is revoked/);
  });});
