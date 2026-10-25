import { describe, expect, it } from "vitest";
import { ALERT_RULES, evaluateAlerts, toPrometheus, type Signals } from "@/server/ops/monitor";

const quiet = (): Signals => ({
  at: "2026-01-01T00:00:00.000Z",
  dbOk: true,
  rpcOk: true,
  headBlock: "100",
  indexerLagBlocks: 0,
  webhookBacklog: 0,
  oldestWebhookBacklogSeconds: 0,
  webhookDeliveriesFailed: 0,
  webhookSignatureRejected1h: 0,
  verificationFailures1h: 0,
  signingDenied1h: 0,
  authoritySigningRefusals24h: 0,
  rebindDenied24h: 0,
  lockdownRefusals1h: 0,
  launchFailures24h: 0,
  stuckLaunchTxs: 0,
  failedJobs: 0,
  liveWorkers: 1,
  revocation: { pending: 0, oldestPendingSeconds: 0, retrying: 0, sloSeconds: 300, breached: false },
  reorg: { events24h: 0, deepest24h: null, alertDepthBlocks: 2 },
  finance: { reconciliation: ["RECONCILED"], provenance: ["PROVEN_ELIGIBLE"], deficits: 0, available: true },
  governance24h: { ownership: 0, recipient: 0, rescue: 0, feePolicy: 0, suspiciousRecipient: 0 },
  signerAlerts24h: { keyRevoked: 0, roleDisabled: 0 },
  signerKillSwitch: null,
  lockdown: false,
});

describe("W05 monitoring rules", () => {
  it("a quiet system fires nothing", () => {
    expect(evaluateAlerts(quiet())).toEqual([]);
  });

  it("every rule is reachable, has a runbook section and an escalation", () => {
    const loud: Signals = {
      ...quiet(),
      dbOk: false,
      rpcOk: false,
      indexerLagBlocks: 500,
      webhookBacklog: 3,
      oldestWebhookBacklogSeconds: 900,
      webhookDeliveriesFailed: 1,
      webhookSignatureRejected1h: 50,
      verificationFailures1h: 50,
      signingDenied1h: 40,
      authoritySigningRefusals24h: 5,
      rebindDenied24h: 9,
      lockdownRefusals1h: 2,
      launchFailures24h: 1,
      stuckLaunchTxs: 1,
      failedJobs: 1,
      liveWorkers: 0,
      revocation: { pending: 1, oldestPendingSeconds: 900, retrying: 1, sloSeconds: 300, breached: true },
      reorg: { events24h: 1, deepest24h: 9, alertDepthBlocks: 2 },
      finance: { reconciliation: ["MISMATCH"], provenance: ["RECONCILIATION_MISMATCH"], deficits: 1, available: true },
      governance24h: { ownership: 1, recipient: 1, rescue: 1, feePolicy: 1, suspiciousRecipient: 1 },
      signerAlerts24h: { keyRevoked: 1, roleDisabled: 1 },
      signerKillSwitch: "authority",
      lockdown: true,
    };
    const fired = evaluateAlerts(loud).map((a) => a.id).sort();
    expect(fired).toEqual(ALERT_RULES.map((r) => r.id).sort());
    for (const r of ALERT_RULES) {
      expect(r.runbook).toMatch(/^§D\d+/);
      expect(r.escalation.length).toBeGreaterThan(10);
    }
    expect(ALERT_RULES.filter((r) => r.severity === "critical").map((r) => r.id)).toEqual(
      expect.arrayContaining(["TREASURY_DEFICIT", "ATTESTOR_DISCREPANCY", "ESCROW_RECONCILIATION_MISMATCH", "SUSPICIOUS_RECIPIENT_CHANGE", "REVOCATION_SLO_BREACH", "RPC_UNAVAILABLE", "DB_UNAVAILABLE", "SIGNER_KEY_REVOKED", "SIGNER_ROLE_DISABLED", "SIGNER_KILL_SWITCH"]),
    );
  });

  it("DEEP_REORG fires only past the configured depth threshold; shallow reorgs stay evidence-only", () => {
    const shallow = evaluateAlerts({ ...quiet(), reorg: { events24h: 3, deepest24h: 1, alertDepthBlocks: 2 } }).map((a) => a.id);
    expect(shallow).not.toContain("DEEP_REORG");
    const deep = evaluateAlerts({ ...quiet(), reorg: { events24h: 3, deepest24h: 2, alertDepthBlocks: 2 } }).map((a) => a.id);
    expect(deep).toContain("DEEP_REORG");
    const none = evaluateAlerts({ ...quiet(), reorg: { events24h: 0, deepest24h: null, alertDepthBlocks: 2 } }).map((a) => a.id);
    expect(none).not.toContain("DEEP_REORG");
  });

  it("worker silence is only an alert when a worker was expected (heartbeats exist)", () => {
    expect(evaluateAlerts({ ...quiet(), liveWorkers: null }).map((a) => a.id)).not.toContain("WORKER_UNHEALTHY");
    expect(evaluateAlerts({ ...quiet(), liveWorkers: 0 }).map((a) => a.id)).toContain("WORKER_UNHEALTHY");
  });

  it("prometheus exposition carries no addresses or secrets, one series per rule", () => {
    const text = toPrometheus(quiet(), []);
    expect(text).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(text.match(/forge_alert_firing\{/g)!.length).toBe(ALERT_RULES.length);
  });
});
