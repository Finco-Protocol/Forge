import { describe, expect, it } from "vitest";
import { ALERT_RULES, evaluateAlerts, toPrometheus, type Signals } from "@/server/ops/monitor";

const quiet = (): Signals => ({
  at: "2026-01-01T00:00:00.000Z",
  rpcOk: true,
  headBlock: "100",
  indexerLagBlocks: 0,
  webhookBacklog: 0,
  oldestWebhookBacklogSeconds: 0,
  verificationFailures1h: 0,
  signingDenied1h: 0,
  rebindDenied24h: 0,
  lockdownRefusals1h: 0,
  launchFailures24h: 0,
  failedJobs: 0,
  revocation: { pending: 0, oldestPendingSeconds: 0, retrying: 0, sloSeconds: 300, breached: false },
  reorgAlerts24h: 0,
  finance: { reconciliation: ["RECONCILED"], provenance: ["PROVEN_ELIGIBLE"], deficits: 0, available: true },
  governance24h: { ownership: 0, recipient: 0, rescue: 0, feePolicy: 0, suspiciousRecipient: 0 },
  lockdown: false,
});

describe("W05 monitoring rules", () => {
  it("a quiet system fires nothing", () => {
    expect(evaluateAlerts(quiet())).toEqual([]);
  });

  it("every rule is reachable, has a runbook section and an escalation", () => {
    const loud: Signals = {
      ...quiet(),
      rpcOk: false,
      indexerLagBlocks: 500,
      webhookBacklog: 3,
      oldestWebhookBacklogSeconds: 900,
      verificationFailures1h: 50,
      signingDenied1h: 40,
      rebindDenied24h: 9,
      lockdownRefusals1h: 2,
      launchFailures24h: 1,
      failedJobs: 1,
      revocation: { pending: 1, oldestPendingSeconds: 900, retrying: 1, sloSeconds: 300, breached: true },
      reorgAlerts24h: 1,
      finance: { reconciliation: ["MISMATCH"], provenance: ["RECONCILIATION_MISMATCH"], deficits: 1, available: true },
      governance24h: { ownership: 1, recipient: 1, rescue: 1, feePolicy: 1, suspiciousRecipient: 1 },
      lockdown: true,
    };
    const fired = evaluateAlerts(loud).map((a) => a.id).sort();
    expect(fired).toEqual(ALERT_RULES.map((r) => r.id).sort());
    for (const r of ALERT_RULES) {
      expect(r.runbook).toMatch(/^§D\d+/);
      expect(r.escalation.length).toBeGreaterThan(10);
    }
    expect(ALERT_RULES.filter((r) => r.severity === "critical").map((r) => r.id)).toEqual(
      expect.arrayContaining(["TREASURY_DEFICIT", "ATTESTOR_DISCREPANCY", "ESCROW_RECONCILIATION_MISMATCH", "SUSPICIOUS_RECIPIENT_CHANGE", "REVOCATION_SLO_BREACH", "RPC_UNAVAILABLE"]),
    );
  });

  it("prometheus exposition carries no addresses or secrets, one series per rule", () => {
    const text = toPrometheus(quiet(), []);
    expect(text).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(text.match(/forge_alert_firing\{/g)!.length).toBe(ALERT_RULES.length);
  });
});
