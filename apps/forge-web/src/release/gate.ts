/**
 * W05 release-readiness gate. A PURE evaluator over:
 *   - the committed readiness manifest (release/readiness-manifest.json),
 *   - Class A engineering results (CI job outcomes or local check results),
 *   - Class B operator evidence and Class C external approvals, each of
 *     which must be SIGNED by a key in the corresponding approver registry,
 *   - the live safety flags, security-findings register, financial
 *     reconciliation status and deployment-manifest integrity.
 *
 * It can return ENGINEERING_PASS at most. It never returns a production-ready
 * state: `productionReady` is the constant `false`, and only a separately
 * approved later release workflow may change that. A green CI run therefore
 * can never enable mainnet transactions.
 */
import { hashMessage, keccak256, recoverMessageAddress, stringToHex, type Address, type Hex } from "viem";

export type EvidenceClass = "A" | "B" | "C";
export type ReadinessState =
  | "ENGINEERING_PASS"
  | "ENGINEERING_FAIL"
  /** Some Class A scope is explicitly NOT VERIFIED (deferred): ENGINEERING_PASS covers only what actually executed. */
  | "EVIDENCE_INCOMPLETE"
  | "OPERATOR_CONFIGURATION_REQUIRED"
  | "EXTERNAL_AUDIT_REQUIRED"
  | "LEGAL_APPROVAL_REQUIRED"
  | "PRODUCTION_BLOCKED";

export interface GateItem {
  id: string;
  class: EvidenceClass;
  title: string;
  /** Class A: CI job id(s) whose success is required. */
  ciJobs?: string[];
  /** Class B/C: which readiness state a missing item maps to. */
  blocks?: "OPERATOR_CONFIGURATION_REQUIRED" | "EXTERNAL_AUDIT_REQUIRED" | "LEGAL_APPROVAL_REQUIRED";
  /** What acceptable evidence must contain (documented for operators/approvers). */
  evidenceRequired?: string;
  /**
   * Class A scope that is KNOWN NOT to be verified (e.g. test steps skipped in a harness that cannot run them).
   * A deferred item can never PASS and can never be satisfied by a CI result: it reports NOT_VERIFIED and adds
   * EVIDENCE_INCOMPLETE. It closes only by a reviewed manifest change that replaces it with a real, mapped job.
   */
  deferred?: { reason: string; steps?: number[]; coveredBy?: string[] };
}

export interface ReadinessManifest {
  version: number;
  workflow: string;
  expectedFlags: Record<string, boolean>;
  items: GateItem[];
  /** keccak256 of the canonical JSON of `items` + `expectedFlags`; tamper check. */
  integrity: Hex;
}

/** An approval/evidence statement signed (EIP-191 personal_sign) by an allowlisted key. */
export interface SignedEvidence {
  itemId: string;
  statement: string;
  /** e.g. audit report hash, Safe address + owners, custody ceremony record hash */
  artifactHash: Hex;
  signer: Address;
  signature: Hex;
}

export interface Finding {
  id: string;
  severity: "critical" | "high" | "medium" | "low" | "informational";
  status: "open" | "fixed" | "accepted-by-external-review" | "disclosed-owner-trust";
  title: string;
}

export interface GateInputs {
  manifest: ReadinessManifest;
  /** CI job id → result ("success" | "failure" | "cancelled" | "skipped" | missing). */
  ciResults: Record<string, string | undefined>;
  flags: Record<string, boolean>;
  findings: Finding[];
  reconciliation: { status: "RECONCILED" | "MISMATCH" | "DEFICIT" | "NOT_RUN"; detail?: string };
  deployManifest?: { verified: boolean; hookAddressSourceProven: boolean; v4WiringSupported: boolean; detail?: string };
  signerRoles?: { separated: boolean; detail?: string };
  operatorEvidence: SignedEvidence[];
  externalApprovals: SignedEvidence[];
  /** Approver registries. EMPTY in this repository: nothing can be self-approved. */
  operatorKeys: Address[];
  externalApproverKeys: Address[];
}

export interface GateItemResult {
  id: string;
  class: EvidenceClass;
  status: "PASS" | "FAIL" | "MISSING_EVIDENCE" | "INVALID_EVIDENCE" | "NOT_VERIFIED";
  detail: string;
}

export interface GateResult {
  states: ReadinessState[];
  engineering: "PASS" | "FAIL";
  productionReady: false;
  items: GateItemResult[];
  blockers: string[];
  /** What the engineering pass does and does not cover (item ids). */
  evidenceScope: { verified: string[]; notVerified: string[] };
}

/** Canonical JSON (sorted keys) so the integrity hash is stable. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function manifestIntegrity(m: Pick<ReadinessManifest, "items" | "expectedFlags">): Hex {
  return keccak256(stringToHex(canonicalJson({ expectedFlags: m.expectedFlags, items: m.items })));
}

/** The exact message an approver signs for an item. */
export function evidenceMessage(e: Pick<SignedEvidence, "itemId" | "statement" | "artifactHash">) {
  return `FINCO Forge release evidence\nitem: ${e.itemId}\nartifact: ${e.artifactHash}\nstatement: ${e.statement}`;
}

async function validSignature(e: SignedEvidence, allow: Address[]): Promise<boolean> {
  if (!allow.map((a) => a.toLowerCase()).includes(e.signer.toLowerCase())) return false;
  try {
    const rec = await recoverMessageAddress({ message: evidenceMessage(e), signature: e.signature });
    return rec.toLowerCase() === e.signer.toLowerCase();
  } catch {
    return false;
  }
}

export const PRODUCTION_READY = false as const;

export async function evaluateGate(i: GateInputs): Promise<GateResult> {
  const items: GateItemResult[] = [];
  const blockers: string[] = [];
  let engineering: "PASS" | "FAIL" = "PASS";
  const fail = (why: string) => {
    engineering = "FAIL";
    blockers.push(why);
  };

  // Manifest integrity (H: a tampered manifest fails).
  if (manifestIntegrity(i.manifest) !== i.manifest.integrity) fail("MANIFEST_TAMPERED: readiness manifest integrity hash mismatch");

  // Hard safety flags (J: FINCO_BURN_ENABLED=true fails; any drift fails).
  for (const [k, want] of Object.entries(i.manifest.expectedFlags)) {
    if (i.flags[k] !== want) fail(`FLAG_DRIFT: ${k}=${String(i.flags[k])} (required ${String(want)})`);
  }

  // E: any unexpected (open) critical/high finding blocks.
  for (const f of i.findings) {
    if ((f.severity === "critical" || f.severity === "high") && f.status === "open") fail(`OPEN_${f.severity.toUpperCase()}_FINDING: ${f.id} ${f.title}`);
  }

  // D: a failed financial reconciliation blocks.
  if (i.reconciliation.status !== "RECONCILED") fail(`FINANCIAL_RECONCILIATION_${i.reconciliation.status}${i.reconciliation.detail ? `: ${i.reconciliation.detail}` : ""}`);

  // F / G / H(deploy): deployment preflight.
  if (!i.deployManifest) fail("DEPLOY_PREFLIGHT_MISSING");
  else {
    if (!i.deployManifest.verified) fail(`DEPLOY_MANIFEST_INVALID${i.deployManifest.detail ? `: ${i.deployManifest.detail}` : ""}`);
    if (!i.deployManifest.hookAddressSourceProven) fail("HOOK_ADDRESS_NOT_SOURCE_PROVEN");
    if (!i.deployManifest.v4WiringSupported) fail("V4_WIRING_UNSUPPORTED");
  }

  // I: signer-role separation.
  if (!i.signerRoles?.separated) fail(`SIGNER_ROLE_SEPARATION_MISSING${i.signerRoles?.detail ? `: ${i.signerRoles.detail}` : ""}`);

  const states = new Set<ReadinessState>();
  for (const item of i.manifest.items) {
    if (item.deferred) {
      // Deferred scope is reported, never passed. A CI mapping on a deferred item is a manifest error (it would
      // let a green unrelated job masquerade as the missing evidence).
      if ((item.ciJobs ?? []).length) fail(`DEFERRED_ITEM_HAS_CI_MAPPING: ${item.id}`);
      items.push({ id: item.id, class: item.class, status: "NOT_VERIFIED", detail: item.deferred.reason });
      states.add("EVIDENCE_INCOMPLETE");
      continue;
    }
    if (item.class === "A") {
      const jobs = item.ciJobs ?? [];
      const bad = jobs.filter((j) => i.ciResults[j] !== "success");
      const ok = jobs.length > 0 && bad.length === 0;
      items.push({ id: item.id, class: "A", status: ok ? "PASS" : "FAIL", detail: ok ? `jobs: ${jobs.join(", ")}` : `not successful: ${(bad.length ? bad : ["<no jobs mapped>"]).map((j) => `${j}=${i.ciResults[j] ?? "missing"}`).join(", ")}` });
      if (!ok) fail(`CLASS_A_${item.id}`);
      continue;
    }
    const pool = item.class === "B" ? i.operatorEvidence : i.externalApprovals;
    const keys = item.class === "B" ? i.operatorKeys : i.externalApproverKeys;
    const mine = pool.filter((e) => e.itemId === item.id);
    let status: GateItemResult["status"] = "MISSING_EVIDENCE";
    let detail = item.class === "B" ? "operator evidence required" : "independent external approval required";
    if (mine.length) {
      const valid = await Promise.all(mine.map((e) => validSignature(e, keys)));
      if (valid.some(Boolean)) {
        status = "PASS";
        detail = "signed evidence from an allowlisted key";
      } else {
        status = "INVALID_EVIDENCE";
        detail = "evidence present but not signed by an allowlisted approver key";
      }
    }
    items.push({ id: item.id, class: item.class, status, detail });
    if (status !== "PASS") states.add(item.blocks ?? (item.class === "B" ? "OPERATOR_CONFIGURATION_REQUIRED" : "EXTERNAL_AUDIT_REQUIRED"));
  }

  const out: ReadinessState[] = [engineering === "PASS" ? "ENGINEERING_PASS" : "ENGINEERING_FAIL"];
  for (const s of ["EVIDENCE_INCOMPLETE", "OPERATOR_CONFIGURATION_REQUIRED", "EXTERNAL_AUDIT_REQUIRED", "LEGAL_APPROVAL_REQUIRED"] as const) if (states.has(s)) out.push(s);
  // Production readiness is never decided here.
  out.push("PRODUCTION_BLOCKED");
  const evidenceScope = {
    verified: items.filter((x) => x.class === "A" && x.status === "PASS").map((x) => x.id),
    notVerified: items.filter((x) => x.status === "NOT_VERIFIED").map((x) => x.id),
  };
  return { states: out, engineering, productionReady: PRODUCTION_READY, items, blockers, evidenceScope };
}

/** Hash helper exposed for evidence preparation tooling. */
export const evidenceDigest = (e: Pick<SignedEvidence, "itemId" | "statement" | "artifactHash">) => hashMessage(evidenceMessage(e));
