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
  rule("WEBHOOK_DELIVERIES_FAILED", "high", "Webhook deliveries exhausted their retries (terminal)", "§D1/§D7", "immediate-offchain"),
  rule("WEBHOOK_SIGNATURE_REJECTED_SPIKE", "high", "Spike in rejected webhook signatures", "§D1", "observe"),
  rule("REVOCATION_SLO_BREACH", "critical", "On-chain revocation older than the SLO", "§D8", "onchain-confirmed"),
  rule("REVOCATION_RETRYING", "high", "Critical revocation jobs retrying", "§D8", "onchain-confirmed"),
  rule("REGISTRY_REBIND_ATTEMPTS", "medium", "Repeated refused (re)binding attempts", "§D2", "observe"),
  rule("ELIGIBILITY_SIGNING_REFUSALS", "high", "Spike in eligibility-signing refusals", "§D2", "immediate-offchain"),
  rule("AUTHORITY_SIGNING_REFUSALS", "high", "Repeated signing refusals from authority/on-chain inconsistency", "§D2/§D3", "immediate-offchain"),
  rule("UNAUTHORIZED_LAUNCH_ATTEMPTS", "high", "Launch attempts refused (lockdown, eligibility or consent)", "§D15", "immediate-offchain"),
  rule("LAUNCH_TX_FAILURES", "medium", "Launch transactions failed", "§D12", "observe"),
  rule("STUCK_LAUNCH_TRANSACTIONS", "high", "Launch transactions pending/submitted far too long", "§D12", "observe"),
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
  rule("MONITORING_FAULT", "medium", "Signal collection itself failed (monitoring-system fault, not an outage)", "§D11", "observe"),
  rule("WORKER_UNHEALTHY", "high", "A previously running worker stopped beating", "§D9", "immediate-offchain"),
  rule("DB_UNAVAILABLE", "critical", "PostgreSQL unreachable", "§D7", "immediate-offchain"),
  rule("RPC_UNAVAILABLE", "critical", "Primary RPC unreachable", "§D11", "immediate-offchain"),
  rule("SIGNER_KEY_REVOKED", "critical", "A custody signer key was revoked (emergency revocation)", "§D3/§D4", "immediate-offchain"),
  rule("SIGNER_ROLE_DISABLED", "critical", "A custody signer role was disabled (custody violation / verification failure)", "§D3", "immediate-offchain"),
  rule("SIGNER_KILL_SWITCH", "critical", "A signer kill switch is engaged", "§D4", "immediate-offchain"),
  rule("EMERGENCY_LOCKDOWN_ACTIVE", "high", "Emergency lockdown engaged", "§D15", "immediate-offchain"),
];

export interface Signals {
  at: string;
  dbOk: boolean;
  rpcOk: boolean;
  headBlock: string | null;
  indexerLagBlocks: number | null;
  webhookBacklog: number;
  oldestWebhookBacklogSeconds: number;
  webhookDeliveriesFailed: number;
  webhookSignatureRejected1h: number;
  verificationFailures1h: number;
  signingDenied1h: number;
  authoritySigningRefusals24h: number;
  rebindDenied24h: number;
  lockdownRefusals1h: number;
  launchFailures24h: number;
  stuckLaunchTxs: number;
  failedJobs: number;
  liveWorkers: number | null;
  revocation: { pending: number; oldestPendingSeconds: number; retrying: number; sloSeconds: number; breached: boolean };
  reorg: { events24h: number; deepest24h: number | null; alertDepthBlocks: number };
  finance: { reconciliation: string[]; provenance: string[]; deficits: number; available: boolean };
  governance24h: { ownership: number; recipient: number; rescue: number; feePolicy: number; suspiciousRecipient: number };
  signerAlerts24h: { keyRevoked: number; roleDisabled: number };
  signerKillSwitch: string | null;
  lockdown: boolean;
  /** Set when signal collection itself failed for a NON-connectivity reason (a monitoring fault, not an outage). */
  collectionFault?: string;
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
  if (s.collectionFault !== undefined) fire("MONITORING_FAULT", `signal collection failed: ${s.collectionFault}`);
  if (!s.dbOk) fire("DB_UNAVAILABLE", "database queries failed");
  if (!s.rpcOk) fire("RPC_UNAVAILABLE", "eth_blockNumber failed");
  if (s.webhookBacklog > 0 && s.oldestWebhookBacklogSeconds > 300) fire("WEBHOOK_BACKLOG", `${s.webhookBacklog} unprocessed, oldest ${s.oldestWebhookBacklogSeconds}s`);
  if (s.webhookDeliveriesFailed > 0) fire("WEBHOOK_DELIVERIES_FAILED", `${s.webhookDeliveriesFailed} terminal (exhausted retries)`);
  if (s.webhookSignatureRejected1h >= 20) fire("WEBHOOK_SIGNATURE_REJECTED_SPIKE", `${s.webhookSignatureRejected1h}/h`);
  if (s.verificationFailures1h >= 20) fire("GITHUB_VERIFICATION_FAILURES", `${s.verificationFailures1h}/h`);
  if (s.revocation.breached) fire("REVOCATION_SLO_BREACH", `oldest ${s.revocation.oldestPendingSeconds}s > ${s.revocation.sloSeconds}s`);
  if (s.revocation.retrying > 0) fire("REVOCATION_RETRYING", `${s.revocation.retrying} retrying`);
  if (s.rebindDenied24h >= 5) fire("REGISTRY_REBIND_ATTEMPTS", `${s.rebindDenied24h}/24h`);
  if (s.signingDenied1h >= 10) fire("ELIGIBILITY_SIGNING_REFUSALS", `${s.signingDenied1h}/h`);
  if (s.authoritySigningRefusals24h >= 3) fire("AUTHORITY_SIGNING_REFUSALS", `${s.authoritySigningRefusals24h}/24h`);
  if (s.lockdownRefusals1h > 0) fire("UNAUTHORIZED_LAUNCH_ATTEMPTS", `${s.lockdownRefusals1h} refused during lockdown /h`);
  if (s.launchFailures24h > 0) fire("LAUNCH_TX_FAILURES", `${s.launchFailures24h}/24h`);
  if (s.stuckLaunchTxs > 0) fire("STUCK_LAUNCH_TRANSACTIONS", `${s.stuckLaunchTxs} pending/submitted > 30 min`);
  if (s.indexerLagBlocks !== null && s.indexerLagBlocks > 50) fire("INDEXER_LAG", `${s.indexerLagBlocks} blocks`);
  // Every reorg is recorded as evidence (ALERT:reorg); the PAGE fires only when
  // the configured depth threshold is crossed.
  if (s.reorg.deepest24h !== null && s.reorg.deepest24h >= s.reorg.alertDepthBlocks) fire("DEEP_REORG", `${s.reorg.events24h} reorg(s)/24h, deepest ${s.reorg.deepest24h} blocks ≥ threshold ${s.reorg.alertDepthBlocks}`);
  if (s.finance.reconciliation.some((x) => x === "MISMATCH" || x.startsWith("READ_FAILED"))) fire("ESCROW_RECONCILIATION_MISMATCH", s.finance.reconciliation.join(","));
  if (s.finance.provenance.includes("RECONCILIATION_MISMATCH")) fire("ATTESTOR_DISCREPANCY", s.finance.provenance.join(","));
  if (s.finance.deficits > 0) fire("TREASURY_DEFICIT", `${s.finance.deficits} asset(s) in deficit`);
  if (s.governance24h.ownership > 0) fire("GOVERNANCE_CHANGE", `${s.governance24h.ownership} ownership events/24h`);
  if (s.governance24h.suspiciousRecipient > 0) fire("SUSPICIOUS_RECIPIENT_CHANGE", `${s.governance24h.suspiciousRecipient} recipient changes/24h`);
  if (s.governance24h.rescue > 0) fire("OWNER_RESCUE", `${s.governance24h.rescue} rescue/force events/24h`);
  if (s.governance24h.feePolicy > 0) fire("FEE_POLICY_CHANGE", `${s.governance24h.feePolicy} policy events/24h`);
  if (s.failedJobs > 0) fire("FAILED_WORKER_JOBS", `${s.failedJobs} failed`);
  if (s.liveWorkers === 0) fire("WORKER_UNHEALTHY", "no fresh worker heartbeat");
  if (s.signerAlerts24h.keyRevoked > 0) fire("SIGNER_KEY_REVOKED", `${s.signerAlerts24h.keyRevoked} key revocation(s)/24h`);
  if (s.signerAlerts24h.roleDisabled > 0) fire("SIGNER_ROLE_DISABLED", `${s.signerAlerts24h.roleDisabled} role disablement(s)/24h`);
  if (s.signerKillSwitch !== null) fire("SIGNER_KILL_SWITCH", `engaged: ${s.signerKillSwitch}`);
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
  const at = new Date().toISOString();
  const empty: Signals = {
    at,
    dbOk: false,
    rpcOk: head !== null,
    headBlock: head === null ? null : head.toString(),
    indexerLagBlocks: null,
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
    liveWorkers: null,
    revocation: { pending: 0, oldestPendingSeconds: 0, retrying: 0, sloSeconds: ctx.cfg.revocationSloSeconds, breached: false },
    reorg: { events24h: 0, deepest24h: null, alertDepthBlocks: ctx.cfg.reorgAlertDepthBlocks },
    finance: { reconciliation: [], provenance: [], deficits: 0, available: false },
    governance24h: { ownership: 0, recipient: 0, rescue: 0, feePolicy: 0, suspiciousRecipient: 0 },
    signerAlerts24h: { keyRevoked: 0, roleDisabled: 0 },
    signerKillSwitch: null,
    lockdown: false,
  };
  // W07: the database being unavailable is itself a signal. Every DB read runs
  // inside one guarded block; a failure yields a structured snapshot with
  // dbOk=false instead of an exception nobody can evaluate.
  try {
    const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0] ?? ({} as T);
    const cp = await one<{ last_block: string }>("SELECT last_block::text FROM indexer_checkpoints WHERE name = $1", [checkpointName(ctx)]);
    const wh = await one<{ n: string; oldest: string | null }>(
      "SELECT count(*)::text AS n, extract(epoch FROM now() - min(received_at))::text AS oldest FROM webhook_deliveries WHERE status = 'received'",
    );
    const wf = await one<{ n: string }>("SELECT count(*)::text AS n FROM webhook_deliveries WHERE status = 'failed'");
    const wr = await one<{ n: string }>("SELECT count(*)::text AS n FROM audit_events WHERE action = 'webhook_signature_rejected' AND at > now() - interval '1 hour'");
    const vf = await one<{ n: string }>("SELECT count(*)::text AS n FROM audit_events WHERE action = 'verification_failed' AND at > now() - interval '1 hour'");
    const sd = await one<{ n: string }>("SELECT count(*)::text AS n FROM signing_requests WHERE decision = 'denied' AND created_at > now() - interval '1 hour'");
    // Authority-inconsistency refusals are written by the signing guard into signer_audit
    // ("signer disabled: on-chain … mismatch", "fail closed", "kill switch", "… is revoked").
    const sa = await one<{ n: string }>(
      "SELECT count(*)::text AS n FROM signer_audit WHERE decision = 'denied' AND created_at > now() - interval '24 hours' AND (reason ILIKE '%mismatch%' OR reason ILIKE '%fail closed%' OR reason ILIKE '%signer disabled%' OR reason ILIKE '%authority%')",
    );
    const rb = await one<{ n: string }>("SELECT count(*)::text AS n FROM signing_requests WHERE decision = 'denied' AND kind = 'binding_bind' AND created_at > now() - interval '24 hours'");
    const lr = await one<{ n: string }>("SELECT count(*)::text AS n FROM audit_events WHERE action = 'lockdown_refusal' AND at > now() - interval '1 hour'");
    const lf = await one<{ n: string }>("SELECT count(*)::text AS n FROM launch_intents WHERE status = 'failed' AND updated_at > now() - interval '24 hours'");
    const st = await one<{ n: string }>("SELECT count(*)::text AS n FROM launch_intents WHERE status IN ('submitted','included') AND updated_at < now() - interval '30 minutes'");
    const fj = await one<{ n: string }>("SELECT count(*)::text AS n FROM jobs WHERE status = 'failed'");
    const ra = await one<{ events: string; deepest: string | null }>(
      "SELECT count(*)::text AS events, max((detail->>'depth')::numeric)::text AS deepest FROM audit_events WHERE action LIKE 'ALERT:reorg%' AND at > now() - interval '24 hours'",
    );    const rv = await db.query<{ n: string; oldest: string | null; retrying: string }>(
      "SELECT count(*)::text AS n, max(extract(epoch FROM now() - created_at))::text AS oldest, count(*) FILTER (WHERE attempts > 0)::text AS retrying FROM jobs WHERE status = 'pending' AND kind = 'registry_revoke'",
    );
    const lw = await db.query<{ live: string; seen: string }>(
      `SELECT count(*) FILTER (WHERE state <> 'stopped' AND beat_at > now() - ($1 || ' seconds')::interval)::text AS live, count(*)::text AS seen
         FROM worker_heartbeats`,
      [String(ctx.cfg.worker.heartbeatStaleSeconds)],
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
    const sig = await db.query<{ action: string; n: string }>(
      "SELECT action, count(*)::text AS n FROM audit_events WHERE action IN ('ALERT:signer_key_revoked', 'ALERT:signer_role_disabled') AND at > now() - interval '24 hours' GROUP BY action",
    );
    const signerAlerts24h = { keyRevoked: 0, roleDisabled: 0 };
    for (const r of sig.rows) {
      if (r.action === "ALERT:signer_key_revoked") signerAlerts24h.keyRevoked = num(r.n);
      if (r.action === "ALERT:signer_role_disabled") signerAlerts24h.roleDisabled = num(r.n);
    }
    const ks = await db.query<{ role: string }>("SELECT role FROM signer_kill_switch WHERE engaged ORDER BY role LIMIT 1");
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
    const deepest = ra.deepest !== undefined && ra.deepest !== null ? Number(ra.deepest) : null;
    return {
      ...empty,
      dbOk: true,
      // The indexer deliberately trails the head by `confirmations`; lag is measured against that safe head.
      indexerLagBlocks: head !== null && cp.last_block !== undefined ? Math.max(0, Number(head - BigInt(ctx.cfg.confirmations) - BigInt(cp.last_block))) : null,
      webhookBacklog: num(wh.n),
      oldestWebhookBacklogSeconds: Math.round(num(wh.oldest)),
      webhookDeliveriesFailed: num(wf.n),
      webhookSignatureRejected1h: num(wr.n),
      verificationFailures1h: num(vf.n),
      signingDenied1h: num(sd.n),
      authoritySigningRefusals24h: num(sa.n),
      rebindDenied24h: num(rb.n),
      lockdownRefusals1h: num(lr.n),
      launchFailures24h: num(lf.n),
      stuckLaunchTxs: num(st.n),
      failedJobs: num(fj.n),
      liveWorkers: num(lw.rows[0]?.seen) === 0 ? null : num(lw.rows[0]?.live),
      revocation: { pending: num(rv.rows[0]?.n), oldestPendingSeconds: Math.round(oldest), retrying: num(rv.rows[0]?.retrying), sloSeconds: ctx.cfg.revocationSloSeconds, breached: oldest > ctx.cfg.revocationSloSeconds },
      reorg: { events24h: num(ra.events), deepest24h: deepest, alertDepthBlocks: ctx.cfg.reorgAlertDepthBlocks },
      finance,
      governance24h: g,
      signerAlerts24h,
      signerKillSwitch: ks.rows[0]?.role ?? null,
      lockdown: lockdown.active,
    };
  } catch (e) {
    // W07 Correction A: not every collection failure is a database outage. True
    // connectivity failures (connection refused/reset/terminated, server shutdown)
    // classify as DB_UNAVAILABLE; anything else is a monitoring-system fault and is
    // reported as such — never as healthy-looking zeros, never as a false outage page.
    const msg = ((e as Error)?.message ?? String(e)).toLowerCase();
    const connectivity =
      /econnrefused|econnreset|etimedout|ehostunreach|enetunreach|connection terminated|connection refused|server closed|the session was terminated|too many clients|shut down/.test(msg) ||
      ((e as { code?: string })?.code ?? "").startsWith("E");
    if (connectivity) return { ...empty, dbOk: false };
    console.error("[forge-monitor] signal collection fault (not connectivity):", (e as Error)?.message?.split("\n")[0]);
    return { ...empty, collectionFault: (e as Error)?.message?.split("\n")[0]?.slice(0, 160) ?? "unknown" };
  }
}

/** Prometheus text exposition of the numeric signals (no labels carry secrets). */
export function toPrometheus(s: Signals, firing: FiringAlert[]): string {
  const lines: string[] = [];
  const g = (name: string, help: string, v: number | null) => {
    lines.push(`# HELP forge_${name} ${help}`, `# TYPE forge_${name} gauge`, `forge_${name} ${v === null ? "NaN" : v}`);
  };
  g("db_up", "1 when database queries succeed", s.dbOk ? 1 : 0);
  g("rpc_up", "1 when the primary RPC answered", s.rpcOk ? 1 : 0);
  g("indexer_lag_blocks", "chain head minus indexer checkpoint", s.indexerLagBlocks);
  g("webhook_backlog", "unprocessed GitHub webhook deliveries", s.webhookBacklog);
  g("webhook_deliveries_failed", "webhook deliveries that exhausted their retries", s.webhookDeliveriesFailed);
  g("webhook_signature_rejected_1h", "rejected webhook signatures in the last hour", s.webhookSignatureRejected1h);
  g("verification_failures_1h", "GitHub verification failures in the last hour", s.verificationFailures1h);
  g("signing_denied_1h", "eligibility signing refusals in the last hour", s.signingDenied1h);
  g("authority_signing_refusals_24h", "signing refusals from authority/on-chain inconsistency in 24h", s.authoritySigningRefusals24h);
  g("rebind_denied_24h", "refused binding attempts in 24h", s.rebindDenied24h);
  g("lockdown_refusals_1h", "launch actions refused by lockdown in the last hour", s.lockdownRefusals1h);
  g("launch_failures_24h", "failed launch transactions in 24h", s.launchFailures24h);
  g("stuck_launch_transactions", "launch transactions pending/submitted for more than 30 minutes", s.stuckLaunchTxs);
  g("failed_jobs", "permanently failed worker jobs", s.failedJobs);
  g("live_workers", "workers with a fresh heartbeat", s.liveWorkers);
  g("revocations_pending", "pending on-chain revocations", s.revocation.pending);
  g("revocation_oldest_pending_seconds", "age of the oldest pending revocation", s.revocation.oldestPendingSeconds);
  g("reorg_alerts_24h", "reorg evidence records in 24h", s.reorg.events24h);
  g("reorg_deepest_24h_blocks", "deepest reorg depth recorded in 24h (null = none)", s.reorg.deepest24h);
  g("reorg_alert_depth_blocks", "configured DEEP_REORG depth threshold", s.reorg.alertDepthBlocks);
  g("treasury_deficit_assets", "assets whose liabilities exceed holdings", s.finance.deficits);
  g("governance_events_24h", "ownership/governance events in 24h", s.governance24h.ownership);
  g("recipient_change_events_24h", "fee/treasury/attestor recipient change events in 24h", s.governance24h.recipient);
  g("rescue_events_24h", "owner rescue/force events in 24h", s.governance24h.rescue);
  g("fee_policy_events_24h", "fee-policy events in 24h", s.governance24h.feePolicy);
  g("signer_key_revocations_24h", "custody signer key revocations in 24h", s.signerAlerts24h.keyRevoked);
  g("signer_role_disablements_24h", "custody signer role disablements in 24h", s.signerAlerts24h.roleDisabled);
  g("emergency_lockdown", "1 when the emergency lockdown is engaged", s.lockdown ? 1 : 0);
  lines.push("# HELP forge_alert_firing firing alerts by rule", "# TYPE forge_alert_firing gauge");
  for (const r of ALERT_RULES) lines.push(`forge_alert_firing{rule="${r.id}",severity="${r.severity}"} ${firing.some((f) => f.id === r.id) ? 1 : 0}`);
  return lines.join("\n") + "\n";
}
