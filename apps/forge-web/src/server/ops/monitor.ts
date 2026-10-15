/**
 * W05 monitoring: signals, alert rules, severities and escalation.
 *
 * Signals are read from the platform's own durable state (DB tables the
 * services already write, the canonical chain_events projection and live
 * chain reads). Alert rules are pure functions of the signal snapshot so
 * they are unit-testable and replayable. Every firing alert names a runbook
 * section in docs/W05-INCIDENT-RUNBOOK.md and says whether its first
 * containment step is an IMMEDIATE (off-chain) control or needs a CONFIRMED
 * on-chain transaction (which, under a timelocked owner, waits the delay).
 */
import type { AppContext } from "../context";
import { checkpointName } from "../indexer/indexer";
import { readControl } from "./controls";

export type Severity = "critical" | "high" | "medium" | "low";

export interface AlertRule {
  id: string;
  severity: Severity;
  title: string;
  runbook: string;
  containment: "immediate-offchain" | "onchain-confirmed" | "observe";
  escalation: string;
}

/** Escalation policy per severity (contacts are Class B operator evidence). */
export const ESCALATION: Record<Severity, string> = {
  critical: "page on-call immediately; security lead + governance Safe signers within 15 min",
  high: "page on-call; security lead within 1 h",
  medium: "ticket to on-call queue; review within 1 business day",
  low: "dashboard only; weekly review",
};

const rule = (id: string, severity: Severity, title: string, runbook: string, containment: AlertRule["containment"]): AlertRule => ({
  id,
  severity,
  title,
  runbook,
  containment,
  escalation: ESCALATION[severity],
});

export const ALERT_RULES: AlertRule[] = [
  rule("GITHUB_VERIFICATION_FAILURES", "medium", "Elevated GitHub verification failures", "§D1", "observe"),
  rule("WEBHOOK_BACKLOG", "high", "GitHub webhook deliveries not processed", "§D1/§D7", "immediate-offchain"),
  rule("REVOCATION_SLO_BREACH", "critical", "On-chain revocation older than the SLO", "§D8", "onchain-confirmed"),
  rule("REVOCATION_RETRYING", "high", "Critical revocation jobs retrying", "§D8", "onchain-confirmed"),
  rule("REGISTRY_REBIND_ATTEMPTS", "medium", "Repeated refused (re)binding attempts", "§D2", "observe"),
  rule("ELIGIBILITY_SIGNING_REFUSALS", "high", "Spike in eligibility-signing refusals", "§D2", "immediate-offchain"),
  rule("UNAUTHORIZED_LAUNCH_ATTEMPTS", "high", "Launch attempts refused (lockdown, eligibility or consent)", "§D15", "immediate-offchain"),
  rule("LAUNCH_TX_FAILURES", "medium", "Launch transactions failed", "§D12", "observe"),
  rule("INDEXER_LAG", "high", "Indexer lagging the chain head", "§D9/§D11", "immediate-offchain"),
  rule("DEEP_REORG", "critical", "Chain reorganisation reached the indexer", "§D8/§D9", "immediate-offchain"),
  rule("ESCROW_RECONCILIATION_MISMATCH", "critical", "Escrow or splitter reconciliation mismatch", "§D10", "onchain-confirmed"),
  rule("ATTESTOR_DISCREPANCY", "critical", "Revenue attestor ceiling disagrees with verified evidence", "§D3", "onchain-confirmed"),
  rule("TREASURY_DEFICIT", "critical", "Treasury/reserve liabilities exceed holdings", "§D10", "onchain-confirmed"),
  rule("GOVERNANCE_CHANGE", "high", "Ownership / governance transaction observed", "§D6", "observe"),
  rule("SUSPICIOUS_RECIPIENT_CHANGE", "critical", "Protocol or creator fee recipient change proposed/applied", "§D6", "onchain-confirmed"),
  rule("OWNER_RESCUE", "high", "Owner rescue / force operation executed", "§D14", "observe"),
  rule("FEE_POLICY_CHANGE", "high", "Fee-policy parameter changed", "§D6", "observe"),
  rule("FAILED_WORKER_JOBS", "high", "Worker jobs failed permanently", "§D9", "immediate-offchain"),
  rule("RPC_UNAVAILABLE", "critical", "Primary RPC unreachable", "§D11", "immediate-offchain"),
  rule("EMERGENCY_LOCKDOWN_ACTIVE", "high", "Emergency lockdown engaged", "§D15", "immediate-offchain"),
];

export interface Signals {
  at: string;
  rpcOk: boolean;
  headBlock: string | null;
  indexerLagBlocks: number | null;
  webhookBacklog: number;
  oldestWebhookBacklogSeconds: number;
  verificationFailures1h: number;
  signingDenied1h: number;
  rebindDenied24h: number;
  lockdownRefusals1h: number;
  launchFailures24h: number;
  failedJobs: number;
  revocation: { pending: number; oldestPendingSeconds: number; retrying: number; sloSeconds: number; breached: boolean };
  reorgAlerts24h: number;
  finance: { reconciliation: string[]; provenance: string[]; deficits: number; available: boolean };
  governance24h: { ownership: number; recipient: number; rescue: number; feePolicy: number; suspiciousRecipient: number };
  lockdown: boolean;
}

export interface FiringAlert extends AlertRule {
  value: string;
}

/** Pure: which rules fire for a signal snapshot. */
export function evaluateAlerts(s: Signals): FiringAlert[] {
  const out: FiringAlert[] = [];
  const fire = (id: string, value: string) => {
    const r = ALERT_RULES.find((x) => x.id === id)!;
    out.push({ ...r, value });
  };
  if (!s.rpcOk) fire("RPC_UNAVAILABLE", "eth_blockNumber failed");
  if (s.webhookBacklog > 0 && s.oldestWebhookBacklogSeconds > 300) fire("WEBHOOK_BACKLOG", `${s.webhookBacklog} unprocessed, oldest ${s.oldestWebhookBacklogSeconds}s`);
  if (s.verificationFailures1h >= 20) fire("GITHUB_VERIFICATION_FAILURES", `${s.verificationFailures1h}/h`);
  if (s.revocation.breached) fire("REVOCATION_SLO_BREACH", `oldest ${s.revocation.oldestPendingSeconds}s > ${s.revocation.sloSeconds}s`);
  if (s.revocation.retrying > 0) fire("REVOCATION_RETRYING", `${s.revocation.retrying} retrying`);
  if (s.rebindDenied24h >= 5) fire("REGISTRY_REBIND_ATTEMPTS", `${s.rebindDenied24h}/24h`);
  if (s.signingDenied1h >= 10) fire("ELIGIBILITY_SIGNING_REFUSALS", `${s.signingDenied1h}/h`);
  if (s.lockdownRefusals1h > 0) fire("UNAUTHORIZED_LAUNCH_ATTEMPTS", `${s.lockdownRefusals1h} refused during lockdown /h`);
  if (s.launchFailures24h > 0) fire("LAUNCH_TX_FAILURES", `${s.launchFailures24h}/24h`);
  if (s.indexerLagBlocks !== null && s.indexerLagBlocks > 50) fire("INDEXER_LAG", `${s.indexerLagBlocks} blocks`);
  if (s.reorgAlerts24h > 0) fire("DEEP_REORG", `${s.reorgAlerts24h} reorg alerts/24h`);
  if (s.finance.reconciliation.some((x) => x === "MISMATCH" || x.startsWith("READ_FAILED"))) fire("ESCROW_RECONCILIATION_MISMATCH", s.finance.reconciliation.join(","));
  if (s.finance.provenance.includes("RECONCILIATION_MISMATCH")) fire("ATTESTOR_DISCREPANCY", s.finance.provenance.join(","));
  if (s.finance.deficits > 0) fire("TREASURY_DEFICIT", `${s.finance.deficits} asset(s) in deficit`);
  if (s.governance24h.ownership > 0) fire("GOVERNANCE_CHANGE", `${s.governance24h.ownership} ownership events/24h`);
  if (s.governance24h.suspiciousRecipient > 0) fire("SUSPICIOUS_RECIPIENT_CHANGE", `${s.governance24h.suspiciousRecipient} recipient changes/24h`);
  if (s.governance24h.rescue > 0) fire("OWNER_RESCUE", `${s.governance24h.rescue} rescue/force events/24h`);
  if (s.governance24h.feePolicy > 0) fire("FEE_POLICY_CHANGE", `${s.governance24h.feePolicy} policy events/24h`);
  if (s.failedJobs > 0) fire("FAILED_WORKER_JOBS", `${s.failedJobs} failed`);
  if (s.lockdown) fire("EMERGENCY_LOCKDOWN_ACTIVE", "engaged");
  return out;
}

const num = (v: unknown) => Number(v ?? 0);
const RECIPIENT_EVENTS = new Set(["CreatorFeeRecipientChangeProposed", "CreatorFeeRecipientUpdated", "ProtocolFeeRecipientUpdated", "TreasuryRecipientChangeProposed", "TreasuryRecipientUpdated", "RevenueAttestorChangeProposed", "RevenueAttestorUpdated"]);
const RESCUE_EVENTS = new Set(["FeesRescued", "PoolFeesRescued", "LaunchGraduationRescued", "LaunchForceSwept"]);
const POLICY_EVENTS = new Set(["ProtocolFeeShareUpdated", "BuybackBurnBpsUpdated", "HookFeeBpsUpdated", "MaxInternalPriceImpactUpdated", "LaunchFeeUpdated", "MaxCreatorTaxUpdated", "SnipeTaxStartBpsUpdated", "SnipeTaxSecondsUpdated", "PairTokenApprovalUpdated", "PairTokenEconomicsUpdated", "FeeSweepOperatorUpdated", "AssetApprovalUpdated", "PullsPausedUpdated"]);
const OWNERSHIP_EVENTS = new Set(["OwnershipTransferStarted", "OwnershipTransferred", "AuthorityUpdated", "EligibilityAuthorityUpdated"]);

/** Reads the live signal snapshot. `finance` is optional because it is the most expensive read. */
export async function collectSignals(ctx: AppContext, opts: { finance?: boolean } = {}): Promise<Signals> {
  const { db } = ctx;
  const head = await ctx.client.getBlockNumber({ cacheTime: 0 }).catch(() => null);
  const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0] ?? ({} as T);
  const cp = await one<{ last_block: string }>("SELECT last_block::text FROM indexer_checkpoints WHERE name = $1", [checkpointName(ctx)]);
  const wh = await one<{ n: string; oldest: string | null }>(
    "SELECT count(*)::text AS n, extract(epoch FROM now() - min(received_at))::text AS oldest FROM webhook_deliveries WHERE processed_at IS NULL",
  );
  const vf = await one<{ n: string }>("SELECT count(*)::text AS n FROM audit_events WHERE action = 'verification_failed' AND at > now() - interval '1 hour'");
  const sd = await one<{ n: string }>("SELECT count(*)::text AS n FROM signing_requests WHERE decision = 'denied' AND created_at > now() - interval '1 hour'");
  const rb = await one<{ n: string }>("SELECT count(*)::text AS n FROM signing_requests WHERE decision = 'denied' AND kind = 'binding_bind' AND created_at > now() - interval '24 hours'");
  const lr = await one<{ n: string }>("SELECT count(*)::text AS n FROM audit_events WHERE action = 'lockdown_refusal' AND at > now() - interval '1 hour'");
  const lf = await one<{ n: string }>("SELECT count(*)::text AS n FROM launch_intents WHERE status = 'failed' AND updated_at > now() - interval '24 hours'");
  const fj = await one<{ n: string }>("SELECT count(*)::text AS n FROM jobs WHERE status = 'failed'");
  const ra = await one<{ n: string }>("SELECT count(*)::text AS n FROM audit_events WHERE action LIKE 'ALERT:reorg%' AND at > now() - interval '24 hours'");
  const rv = await db.query<{ n: string; oldest: string | null; retrying: string }>(
    "SELECT count(*)::text AS n, max(extract(epoch FROM now() - created_at))::text AS oldest, count(*) FILTER (WHERE attempts > 0)::text AS retrying FROM jobs WHERE status = 'pending' AND kind = 'registry_revoke'",
  );
  const oldest = num(rv.rows[0]?.oldest);
  const gov = await db.query<{ event_name: string; n: string }>(
    "SELECT event_name, count(*)::text AS n FROM chain_events WHERE chain_id = $1 AND block_timestamp > extract(epoch FROM now() - interval '24 hours') GROUP BY event_name",
    [ctx.cfg.chainId],
  );
  const g = { ownership: 0, recipient: 0, rescue: 0, feePolicy: 0, suspiciousRecipient: 0 };
  for (const r of gov.rows) {
    const n = num(r.n);
    if (OWNERSHIP_EVENTS.has(r.event_name)) g.ownership += n;
    if (RECIPIENT_EVENTS.has(r.event_name)) {
      g.recipient += n;
      g.suspiciousRecipient += n;
    }
    if (RESCUE_EVENTS.has(r.event_name)) g.rescue += n;
    if (POLICY_EVENTS.has(r.event_name)) g.feePolicy += n;
  }
  let finance: Signals["finance"] = { reconciliation: [], provenance: [], deficits: 0, available: false };
  if (opts.finance) {
    try {
      const { treasuryReport } = await import("../finance/service");
      const t = await treasuryReport(ctx);
      finance = {
        reconciliation: t.accounting.map((a) => String(a.reconciliation)),
        provenance: t.accounting.map((a) => String(a.provenance.status)),
        deficits: t.accounting.filter((a) => a.onchainAtCheckpoint && a.onchainAtCheckpoint.deficit !== "0" && a.onchainAtCheckpoint.deficit !== null).length,
        available: true,
      };
    } catch (e) {
      finance = { reconciliation: [`READ_FAILED: ${(e as Error).message.split("\n")[0]}`], provenance: [], deficits: 0, available: false };
    }
  }
  const lockdown = await readControl(db, "emergency_lockdown");
  return {
    at: new Date().toISOString(),
    rpcOk: head !== null,
    headBlock: head === null ? null : head.toString(),
    // The indexer deliberately trails the head by `confirmations`; lag is measured against that safe head.
    indexerLagBlocks: head !== null && cp.last_block !== undefined ? Math.max(0, Number(head - BigInt(ctx.cfg.confirmations) - BigInt(cp.last_block))) : null,
    webhookBacklog: num(wh.n),
    oldestWebhookBacklogSeconds: Math.round(num(wh.oldest)),
    verificationFailures1h: num(vf.n),
    signingDenied1h: num(sd.n),
    rebindDenied24h: num(rb.n),
    lockdownRefusals1h: num(lr.n),
    launchFailures24h: num(lf.n),
    failedJobs: num(fj.n),
    revocation: { pending: num(rv.rows[0]?.n), oldestPendingSeconds: Math.round(oldest), retrying: num(rv.rows[0]?.retrying), sloSeconds: ctx.cfg.revocationSloSeconds, breached: oldest > ctx.cfg.revocationSloSeconds },
    reorgAlerts24h: num(ra.n),
    finance,
    governance24h: g,
    lockdown: lockdown.active,
  };
}

/** Prometheus text exposition of the numeric signals (no labels carry secrets). */
export function toPrometheus(s: Signals, firing: FiringAlert[]): string {
  const lines: string[] = [];
  const g = (name: string, help: string, v: number | null) => {
    lines.push(`# HELP forge_${name} ${help}`, `# TYPE forge_${name} gauge`, `forge_${name} ${v === null ? "NaN" : v}`);
  };
  g("rpc_up", "1 when the primary RPC answered", s.rpcOk ? 1 : 0);
  g("indexer_lag_blocks", "chain head minus indexer checkpoint", s.indexerLagBlocks);
  g("webhook_backlog", "unprocessed GitHub webhook deliveries", s.webhookBacklog);
  g("verification_failures_1h", "GitHub verification failures in the last hour", s.verificationFailures1h);
  g("signing_denied_1h", "eligibility signing refusals in the last hour", s.signingDenied1h);
  g("rebind_denied_24h", "refused binding attempts in 24h", s.rebindDenied24h);
  g("lockdown_refusals_1h", "launch actions refused by lockdown in the last hour", s.lockdownRefusals1h);
  g("launch_failures_24h", "failed launch transactions in 24h", s.launchFailures24h);
  g("failed_jobs", "permanently failed worker jobs", s.failedJobs);
  g("revocations_pending", "pending on-chain revocations", s.revocation.pending);
  g("revocation_oldest_pending_seconds", "age of the oldest pending revocation", s.revocation.oldestPendingSeconds);
  g("reorg_alerts_24h", "reorg alerts in 24h", s.reorgAlerts24h);
  g("treasury_deficit_assets", "assets whose liabilities exceed holdings", s.finance.deficits);
  g("governance_events_24h", "ownership/governance events in 24h", s.governance24h.ownership);
  g("recipient_change_events_24h", "fee/treasury/attestor recipient change events in 24h", s.governance24h.recipient);
  g("rescue_events_24h", "owner rescue/force events in 24h", s.governance24h.rescue);
  g("fee_policy_events_24h", "fee-policy events in 24h", s.governance24h.feePolicy);
  g("emergency_lockdown", "1 when the emergency lockdown is engaged", s.lockdown ? 1 : 0);
  lines.push("# HELP forge_alert_firing firing alerts by rule", "# TYPE forge_alert_firing gauge");
  for (const r of ALERT_RULES) lines.push(`forge_alert_firing{rule="${r.id}",severity="${r.severity}"} ${firing.some((f) => f.id === r.id) ? 1 : 0}`);
  return lines.join("\n") + "\n";
}
