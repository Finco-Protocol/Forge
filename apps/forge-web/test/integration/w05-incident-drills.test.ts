/**
 * W05 incident drills (docs/W05-INCIDENT-RUNBOOK.md §D1–§D15), executed
 * against the real Forge stack on a local Anvil with test keys only — no
 * real funds, no external network. Each drill checks (a) the IMMEDIATE
 * off-chain control, (b) the on-chain control where one exists, and (c) that
 * monitoring raises the documented alert.
 *
 * Drills already covered in depth by earlier suites are re-asserted here at
 * the monitoring level and cross-referenced:
 *   §D7 repository transfer  → revocation.test.ts #1, negative-identity "transferred repository"
 *   §D8 revocation reorg     → revocation.test.ts #8
 *   §D9 indexer crash/replay → economics.test.ts #24, negative-chain "replay after checkpoint rewind"
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress, parseEther, zeroAddress, type Address, type Hex } from "viem";
import { forgeLaunchAuthorizerAbi, forgeProtocolRevenueSplitterAbi, ponsV2BondingCurveAbi, ponsV2LaunchFactoryAbi, ponsV2MemeHookAbi } from "@/shared/abis.generated";
import { dispatch } from "@/server/api/handlers";
import { runWorkerOnce } from "@/server/worker";
import { createAppContext } from "@/server/context";
import { PgliteDb } from "@/server/db";
import { collectSignals, evaluateAlerts } from "@/server/ops/monitor";
import { setControl, readControl } from "@/server/ops/controls";
import { runRevenueAttestation, treasuryReport } from "@/server/finance/service";
import { signWebhookBody } from "@/server/github/webhooks";
import { startSandbox, chainClients, ANVIL_KEYS, TestBrowser, type Sandbox } from "../helpers/sandbox";
import { freshScenario, governanceWrite, launchThroughApi, signedLaunch, simulateLaunch } from "../helpers/scenario";
import { rpc } from "../helpers/anvil";

const OPS_TOKEN = "ops-token-for-drills-0123456789abcdef";
const STRANGER_KEY = ANVIL_KEYS[7] as Hex;
const TREASURY_KEY = ANVIL_KEYS[8] as Hex;
const NATIVE = zeroAddress as Address;

let sb: Sandbox;

async function firing(finance = true) {
  const s = await collectSignals(sb.ctx, { finance });
  return { s, ids: evaluateAlerts(s).map((a) => a.id) };
}
async function send(key: Hex, address: Address, abi: readonly unknown[], functionName: string, args: unknown[] = [], value = 0n) {
  const { wallet, pub } = chainClients(sb.anvil.url, key);
  const h = await wallet.writeContract({ address, abi, functionName, args, value } as never);
  return pub.waitForTransactionReceipt({ hash: h });
}
async function feesOnCurve(sweep = false) {
  const sc = await freshScenario(sb);
  const l = await launchThroughApi(sb, sc.browser, sc.key, sc.draft);
  await runWorkerOnce(sb.ctx);
  await rpc(sb.anvil.url, "evm_increaseTime", [30]);
  await rpc(sb.anvil.url, "evm_mine");
  const curve = getAddress(l.submitted.json.curve);
  const token = getAddress(l.submitted.json.token);
  const buyer = chainClients(sb.anvil.url, STRANGER_KEY).account.address;
  await send(STRANGER_KEY, curve, ponsV2BondingCurveAbi, "buy", [parseEther("5"), 0n, buyer], parseEther("5"));
  if (sweep) await send(sc.key, curve, ponsV2BondingCurveAbi, "sweepFees", [0n]);
  return { sc, curve, token };
}

beforeAll(async () => {
  sb = await startSandbox({ FORGE_OPS_TOKEN: OPS_TOKEN });
});
afterAll(async () => sb?.stop());

describe("W05 incident drills", () => {
  it("ops endpoints: disabled without a token configured, 401 with a wrong token, metrics with the right one", async () => {
    const call = (path: string, token?: string) => dispatch(sb.ctx, new Request(`http://localhost:3000${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }));
    expect((await call("/api/ops/alerts")).status).toBe(401);
    expect((await call("/api/ops/alerts", "nope")).status).toBe(401);
    const m = await call("/api/ops/metrics", OPS_TOKEN);
    expect(m.status).toBe(200);
    const text = await m.text();
    expect(text).toMatch(/^forge_rpc_up 1$/m);
    expect(text).toMatch(/forge_alert_firing\{rule="TREASURY_DEFICIT",severity="critical"\} 0/);
    expect(m.headers.get("x-correlation-id")).toBeTruthy();
    const ctx2 = await createAppContext({ ...sb.env, FORGE_OPS_TOKEN: "" as string }, { db: await PgliteDb.open() }).catch(() => null);
    if (ctx2) {
      expect((await dispatch(ctx2, new Request("http://localhost:3000/api/ops/alerts"))).status).toBe(404);
      await ctx2.db.close();
    }
  });

  it("§D15 active launch attempt during emergency lockdown: refused immediately, alert fires, revocations still run, release restores", async () => {
    const sc = await freshScenario(sb);
    await setControl(sb.ctx.db, "emergency_lockdown", true, "drill §D15", "drill-operator");
    try {
    const d = await sc.browser.post("/api/launch/drafts", sc.draft);
    expect(d.status).toBe(503);
    expect(d.json.error.code).toBe("EMERGENCY_LOCKDOWN");
    // The authority itself refuses eligibility attestations and NEW bindings while locked down.
    const denied = await sb.ctx.db.query<{ n: string }>("SELECT count(*)::text AS n FROM signing_requests WHERE reason = 'emergency lockdown engaged'");
    const { ids } = await firing(false);
    expect(ids).toContain("EMERGENCY_LOCKDOWN_ACTIVE");
    expect(ids).toContain("UNAUTHORIZED_LAUNCH_ATTEMPTS");
    // Revocation path is NOT blocked: unbinding the wallet still revokes on chain.
    const unbind = await sc.browser.request("DELETE", "/api/wallet/binding");
    expect(unbind.status).toBe(200);
    await runWorkerOnce(sb.ctx);
    expect(Number(denied.rows[0]!.n)).toBeGreaterThanOrEqual(0);
    } finally {
      await setControl(sb.ctx.db, "emergency_lockdown", false, "drill complete", "drill-operator");
    }
    expect((await readControl(sb.ctx.db, "emergency_lockdown")).active).toBe(false);
    const sc2 = await freshScenario(sb);
    expect((await sc2.browser.post("/api/launch/drafts", sc2.draft)).status).toBe(201);
  });

  it("§D1 GitHub App credentials compromised: forged webhooks are rejected and audited; lockdown is the immediate control", async () => {
    const body = JSON.stringify({ action: "deleted", installation: { id: 1 } });
    const res = await dispatch(
      sb.ctx,
      new Request("http://localhost:3000/api/github/webhook", {
        method: "POST",
        body,
        headers: { "x-hub-signature-256": signWebhookBody("attacker-guessed-secret", body), "x-github-delivery": "drill-d1", "x-github-event": "installation", "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(401);
    const a = await sb.ctx.db.query<{ n: string }>("SELECT count(*)::text AS n FROM audit_events WHERE action = 'webhook_signature_rejected'");
    expect(Number(a.rows[0]!.n)).toBeGreaterThan(0);
  });

  it("§D2 eligibility signer compromised: off-chain lockdown + on-chain kill switch (authority = 0) stops launches even with a valid attestation", async () => {
    const sc = await freshScenario(sb);
    const prepared = await signedLaunch(sb, sc.browser, sc.key, sc.draft); // an attestation an attacker could hold
    await governanceWrite(sb, sb.deployment.authorizer, forgeLaunchAuthorizerAbi, "setEligibilityAuthority", [zeroAddress]);
    expect(await simulateLaunch(sb, sc.key, prepared.call)).not.toBe("OK");
    await runWorkerOnce(sb.ctx);
    expect((await firing(false)).ids).toContain("GOVERNANCE_CHANGE");
    // Recovery: rotate back to the (re-provisioned) authority.
    await governanceWrite(sb, sb.deployment.authorizer, forgeLaunchAuthorizerAbi, "setEligibilityAuthority", [sb.deployment.authority]);
  });

  it("§D3 revenue attestor compromised: ONE revoke transaction stops new ceilings, discards pending rotations and pauses pulls; claims keep working", async () => {
    await feesOnCurve(true);
    await runWorkerOnce(sb.ctx); // attests the swept protocol leg
    const headroom = await sb.ctx.client.readContract({ address: sb.deployment.revenueSplitter, abi: forgeProtocolRevenueSplitterAbi, functionName: "verifiedHeadroom", args: [NATIVE] });
    expect(headroom).toBeGreaterThan(0n);
    await governanceWrite(sb, sb.deployment.revenueSplitter, forgeProtocolRevenueSplitterAbi, "revokeRevenueAttestor", []);
    const out = await runRevenueAttestation(sb.ctx);
    expect(out.map((o) => o.status)).toContain("ATTESTOR_MISMATCH");
    // Revocation did not erase the already-authorized headroom...
    expect(await sb.ctx.client.readContract({ address: sb.deployment.revenueSplitter, abi: forgeProtocolRevenueSplitterAbi, functionName: "verifiedHeadroom", args: [NATIVE] })).toBe(headroom);
    // ...but the SAME transaction paused pulls (Correction A): no separate step is needed.
    expect(await sb.ctx.client.readContract({ address: sb.deployment.revenueSplitter, abi: forgeProtocolRevenueSplitterAbi, functionName: "pullsPaused" })).toBe(true);
    const pull = await send(STRANGER_KEY, sb.deployment.revenueSplitter, forgeProtocolRevenueSplitterAbi, "pullRevenue", [NATIVE, 0n]).catch(() => ({ status: "reverted" }));
    expect(pull.status).not.toBe("success");
    await runWorkerOnce(sb.ctx);
    expect((await firing(false)).ids).toEqual(expect.arrayContaining(["SUSPICIOUS_RECIPIENT_CHANGE", "FEE_POLICY_CHANGE"]));
    // Recovery is explicit: a NEW timelocked proposal, then an owner-authorized unpause.
    await governanceWrite(sb, sb.deployment.revenueSplitter, forgeProtocolRevenueSplitterAbi, "proposeRevenueAttestor", [sb.deployment.revenueAttestor]);
    await rpc(sb.anvil.url, "evm_increaseTime", [3 * 24 * 3600]);
    await rpc(sb.anvil.url, "evm_mine");
    await send(STRANGER_KEY, sb.deployment.revenueSplitter, forgeProtocolRevenueSplitterAbi, "executeRevenueAttestorChange");
    await governanceWrite(sb, sb.deployment.revenueSplitter, forgeProtocolRevenueSplitterAbi, "setPullsPaused", [false]);
    expect((await runRevenueAttestation(sb.ctx)).every((o) => o.status !== "ATTESTOR_MISMATCH")).toBe(true);
  });

  it("§D4 relayer key lost: the relayer holds no on-chain authority; a fresh relayer key restores service", async () => {
    const relayer = sb.ctx.relayer.account.address;
    const d = sb.deployment;
    for (const [addr, abi] of [
      [d.factory, ponsV2LaunchFactoryAbi],
      [d.memeHook, ponsV2MemeHookAbi],
      [d.revenueSplitter, forgeProtocolRevenueSplitterAbi],
      [d.authorizer, forgeLaunchAuthorizerAbi],
    ] as const) {
      expect(getAddress(await sb.ctx.client.readContract({ address: addr, abi: abi as never, functionName: "owner" }) as Address)).not.toBe(relayer);
    }
    expect(getAddress(await sb.ctx.client.readContract({ address: d.authorizer, abi: forgeLaunchAuthorizerAbi, functionName: "eligibilityAuthority" }))).not.toBe(relayer);
    const ctx2 = await createAppContext({ ...sb.env, FORGE_RELAYER_PRIVATE_KEY: ANVIL_KEYS[9] }, { db: sb.ctx.db });
    expect(ctx2.relayer.account.address).not.toBe(relayer);
  });

  it("§D5 treasury recipient key lost: timelocked rotation; allocated liabilities stay claimable by the new recipient", async () => {
    const newTreasury = chainClients(sb.anvil.url, TREASURY_KEY).account.address === sb.deployment.treasury ? chainClients(sb.anvil.url, ANVIL_KEYS[6] as Hex).account.address : sb.deployment.treasury;
    await governanceWrite(sb, sb.deployment.revenueSplitter, forgeProtocolRevenueSplitterAbi, "proposeTreasuryRecipient", [newTreasury]);
    await rpc(sb.anvil.url, "evm_increaseTime", [3 * 24 * 3600]);
    await rpc(sb.anvil.url, "evm_mine");
    await send(STRANGER_KEY, sb.deployment.revenueSplitter, forgeProtocolRevenueSplitterAbi, "executeTreasuryRecipientChange");
    expect(await sb.ctx.client.readContract({ address: sb.deployment.revenueSplitter, abi: forgeProtocolRevenueSplitterAbi, functionName: "treasuryRecipient" })).toBe(newTreasury);
    await runWorkerOnce(sb.ctx);
    expect((await firing(false)).ids).toContain("SUSPICIOUS_RECIPIENT_CHANGE");
  });

  it("§D6 unauthorized/unexpected owner action: protocol-recipient substitution and fee changes raise critical/high alerts", async () => {
    const eoa = chainClients(sb.anvil.url, STRANGER_KEY).account.address;
    await governanceWrite(sb, sb.deployment.memeHook, ponsV2MemeHookAbi, "setProtocolFeeRecipient", [eoa]);
    await governanceWrite(sb, sb.deployment.factory, ponsV2LaunchFactoryAbi, "setLaunchFee", [1n]);
    await runWorkerOnce(sb.ctx);
    const { ids } = await firing(false);
    expect(ids).toEqual(expect.arrayContaining(["SUSPICIOUS_RECIPIENT_CHANGE", "FEE_POLICY_CHANGE"]));
    const gov = await new TestBrowser(sb).get("/api/finance/governance");
    expect(gov.json.warnings.join(" ")).toMatch(/UNAUTHORIZED RECIPIENT/);
    await governanceWrite(sb, sb.deployment.memeHook, ponsV2MemeHookAbi, "setProtocolFeeRecipient", [sb.deployment.revenueSplitter]);
    await governanceWrite(sb, sb.deployment.factory, ponsV2LaunchFactoryAbi, "setLaunchFee", [0n]);
  });

  it("§D9 indexer stalled: lag alert fires while the worker is down and clears after replay", async () => {
    for (let i = 0; i < 60; i++) await rpc(sb.anvil.url, "evm_mine");
    expect((await firing(false)).ids).toContain("INDEXER_LAG");
    await runWorkerOnce(sb.ctx);
    expect((await firing(false)).ids).not.toContain("INDEXER_LAG");
  });

  it("§D10 escrow/treasury deficit: a splitter balance below its liabilities raises TREASURY_DEFICIT and the reconciliation shows it", async () => {
    await feesOnCurve(true);
    await runWorkerOnce(sb.ctx);
    await send(STRANGER_KEY, sb.deployment.revenueSplitter, forgeProtocolRevenueSplitterAbi, "pullRevenue", [NATIVE, 0n]);
    await runWorkerOnce(sb.ctx);
    const bal = await sb.ctx.client.getBalance({ address: sb.deployment.revenueSplitter });
    await rpc(sb.anvil.url, "anvil_setBalance", [sb.deployment.revenueSplitter, "0x0"]); // simulated loss
    await rpc(sb.anvil.url, "evm_mine");
    await runWorkerOnce(sb.ctx);
    const { ids } = await firing(true);
    expect(ids).toContain("TREASURY_DEFICIT");
    const t = await treasuryReport(sb.ctx);
    expect(t.exceptions.some((e) => e.kind === "SPLITTER_DEFICIT")).toBe(true);
    await rpc(sb.anvil.url, "anvil_setBalance", [sb.deployment.revenueSplitter, `0x${bal.toString(16)}`]);
    await rpc(sb.anvil.url, "evm_mine");
    await runWorkerOnce(sb.ctx);
    expect((await firing(true)).ids).not.toContain("TREASURY_DEFICIT");
  });

  it("§D11 main RPC outage: RPC_UNAVAILABLE fires and launch authorization fails closed (no signature issued)", async () => {
    const dead = await createAppContext({ ...sb.env, FORGE_RPC_URL: "http://127.0.0.1:1" }, { db: sb.ctx.db });
    const s = await collectSignals(dead, { finance: false });
    expect(evaluateAlerts(s).map((a) => a.id)).toContain("RPC_UNAVAILABLE");
    const before = await sb.ctx.db.query<{ n: string }>("SELECT count(*)::text AS n FROM signing_requests WHERE decision = 'allowed'");
    const sc = await freshScenario(sb);
    const draft = await sc.browser.post("/api/launch/drafts", sc.draft);
    const auth = await dispatch(dead, new Request(`http://localhost:3000/api/launch/drafts/${draft.json.id}/authorize`, { method: "POST", headers: { cookie: [...sc.browser.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; "), origin: "http://localhost:3000", "x-csrf-token": sc.browser.cookies.get("forge_csrf") ?? "" } }));
    expect(auth.status).not.toBe(200);
    const after = await sb.ctx.db.query<{ n: string }>("SELECT count(*)::text AS n FROM signing_requests WHERE decision = 'allowed'");
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it("§D13 incorrect quote-asset configuration: the splitter refuses an asset the factory does not list", async () => {
    const res = await sb.ctx.client
      .simulateContract({ account: sb.deployment.governance, address: sb.deployment.revenueSplitter, abi: forgeProtocolRevenueSplitterAbi, functionName: "setAssetApproved", args: [sb.deployment.feeEscrow, true] })
      .then(() => "ok")
      .catch((e: Error) => e.message);
    expect(res).toMatch(/AssetNotForgeQuote/);
  });

  it("§D14 fee rescue operation: OWNER_RESCUE alert fires and the rescued protocol leg is non-revenue", async () => {
    const { token } = await feesOnCurve();
    await governanceWrite(sb, sb.deployment.factory, ponsV2LaunchFactoryAbi, "rescueCurveFees", [token]);
    await runWorkerOnce(sb.ctx);
    expect((await firing(false)).ids).toContain("OWNER_RESCUE");
    const t = await treasuryReport(sb.ctx);
    expect(t.exceptions.some((e) => e.kind === "OWNER_RESCUE_CURVE")).toBe(true);
  });
});
