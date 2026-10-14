/**
 * W05 release-gate negative tests (A–J) and invariants: the gate can at most
 * report ENGINEERING_PASS; production readiness is never decided by it, and
 * Class B/C evidence must be signed by an allowlisted key (registries are
 * EMPTY in this repository, so nothing can be self-approved).
 */
import { describe, expect, it } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { readFileSync } from "node:fs";
import path from "node:path";
import { evaluateGate, evidenceMessage, manifestIntegrity, type GateInputs, type ReadinessManifest, type SignedEvidence } from "@/release/gate";

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const items = JSON.parse(readFileSync(path.join(ROOT, "release", "readiness-items.json"), "utf8"));
const committed = JSON.parse(readFileSync(path.join(ROOT, "release", "readiness-manifest.json"), "utf8")) as ReadinessManifest;
const findings = JSON.parse(readFileSync(path.join(ROOT, "release", "security-findings.json"), "utf8")).findings;

function manifest(): ReadinessManifest {
  const m = { version: items.version, workflow: items.workflow, expectedFlags: items.expectedFlags, items: items.items } as Omit<ReadinessManifest, "integrity">;
  return { ...m, integrity: manifestIntegrity(m) };
}

function greenInputs(over: Partial<GateInputs> = {}): GateInputs {
  const m = manifest();
  const ciResults = Object.fromEntries(m.items.flatMap((i) => i.ciJobs ?? []).map((j) => [j, "success"]));
  return {
    manifest: m,
    ciResults,
    flags: { ...m.expectedFlags },
    findings: [],
    reconciliation: { status: "RECONCILED" },
    deployManifest: { verified: true, hookAddressSourceProven: true, v4WiringSupported: true },
    signerRoles: { separated: true },
    operatorEvidence: [],
    externalApprovals: [],
    operatorKeys: [],
    externalApproverKeys: [],
    ...over,
  };
}

async function signed(key: `0x${string}`, itemId: string): Promise<SignedEvidence> {
  const acct = privateKeyToAccount(key);
  const e = { itemId, statement: "approved", artifactHash: `0x${"ab".repeat(32)}` as const };
  return { ...e, signer: acct.address, signature: await acct.signMessage({ message: evidenceMessage(e) }) };
}

const has = (states: string[], s: string) => states.includes(s);

describe("W05 release gate", () => {
  it("the committed manifest is stamped from release/readiness-items.json (integrity matches)", () => {
    expect(committed.integrity).toBe(manifest().integrity);
    expect(manifestIntegrity(committed)).toBe(committed.integrity);
  });

  it("the committed findings register has no OPEN critical/high finding", () => {
    expect(findings.filter((f: { severity: string; status: string }) => ["critical", "high"].includes(f.severity) && f.status === "open")).toEqual([]);
  });

  it("all-green engineering yields ENGINEERING_PASS but still OPERATOR/AUDIT/LEGAL required and PRODUCTION_BLOCKED", async () => {
    const r = await evaluateGate(greenInputs());
    expect(r.engineering).toBe("PASS");
    expect(r.productionReady).toBe(false);
    expect(r.states).toEqual(["ENGINEERING_PASS", "OPERATOR_CONFIGURATION_REQUIRED", "EXTERNAL_AUDIT_REQUIRED", "LEGAL_APPROVAL_REQUIRED", "PRODUCTION_BLOCKED"]);
  });

  it("A. missing external audit never yields production-ready", async () => {
    const r = await evaluateGate(greenInputs());
    expect(has(r.states, "EXTERNAL_AUDIT_REQUIRED")).toBe(true);
    expect(r.items.find((i) => i.id === "C01_SMART_CONTRACT_AUDIT")!.status).toBe("MISSING_EVIDENCE");
    expect(r.productionReady).toBe(false);
  });

  it("B. missing legal approval never yields production-ready", async () => {
    const r = await evaluateGate(greenInputs());
    expect(has(r.states, "LEGAL_APPROVAL_REQUIRED")).toBe(true);
    expect(r.productionReady).toBe(false);
  });

  it("C. missing operator custody never yields production-ready", async () => {
    const r = await evaluateGate(greenInputs());
    expect(r.items.find((i) => i.id === "B02_SIGNER_CUSTODY")!.status).toBe("MISSING_EVIDENCE");
    expect(has(r.states, "OPERATOR_CONFIGURATION_REQUIRED")).toBe(true);
  });

  it("D. a failed financial reconciliation blocks release", async () => {
    for (const status of ["MISMATCH", "DEFICIT", "NOT_RUN"] as const) {
      const r = await evaluateGate(greenInputs({ reconciliation: { status } }));
      expect(r.engineering).toBe("FAIL");
      expect(r.blockers.join()).toMatch(new RegExp(`FINANCIAL_RECONCILIATION_${status}`));
    }
  });

  it("E. an unexpected open high-severity finding blocks release", async () => {
    const r = await evaluateGate(greenInputs({ findings: [{ id: "X-1", severity: "high", status: "open", title: "new" }] }));
    expect(r.engineering).toBe("FAIL");
    expect(r.blockers.join()).toMatch(/OPEN_HIGH_FINDING: X-1/);
    const c = await evaluateGate(greenInputs({ findings: [{ id: "X-2", severity: "critical", status: "open", title: "new" }] }));
    expect(c.blockers.join()).toMatch(/OPEN_CRITICAL_FINDING/);
  });

  it("F. unsupported V4 wiring blocks release", async () => {
    const r = await evaluateGate(greenInputs({ deployManifest: { verified: true, hookAddressSourceProven: true, v4WiringSupported: false } }));
    expect(r.blockers).toContain("V4_WIRING_UNSUPPORTED");
    const ci = greenInputs();
    ci.ciResults["w05: genuine Uniswap V4 integration (local)"] = "failure";
    expect((await evaluateGate(ci)).blockers.join()).toMatch(/CLASS_A_A06_GENUINE_V4_LOCAL/);
  });

  it("G. no source-proven hook address blocks deployment", async () => {
    const r = await evaluateGate(greenInputs({ deployManifest: { verified: true, hookAddressSourceProven: false, v4WiringSupported: true } }));
    expect(r.blockers).toContain("HOOK_ADDRESS_NOT_SOURCE_PROVEN");
    expect((await evaluateGate(greenInputs({ deployManifest: undefined }))).blockers).toContain("DEPLOY_PREFLIGHT_MISSING");
  });

  it("H. a tampered manifest (readiness or deployment) fails", async () => {
    const m = manifest();
    const tampered = { ...m, items: m.items.map((i) => (i.id === "C01_SMART_CONTRACT_AUDIT" ? { ...i, class: "A" as const, ciJobs: ["anything"] } : i)) };
    const r = await evaluateGate(greenInputs({ manifest: tampered }));
    expect(r.blockers.join()).toMatch(/MANIFEST_TAMPERED/);
    const d = await evaluateGate(greenInputs({ deployManifest: { verified: false, hookAddressSourceProven: true, v4WiringSupported: true, detail: "hash mismatch" } }));
    expect(d.blockers.join()).toMatch(/DEPLOY_MANIFEST_INVALID: hash mismatch/);
  });

  it("I. missing signer-role separation fails", async () => {
    const r = await evaluateGate(greenInputs({ signerRoles: { separated: false, detail: "authority == revenue attestor" } }));
    expect(r.blockers.join()).toMatch(/SIGNER_ROLE_SEPARATION_MISSING: authority == revenue attestor/);
    expect((await evaluateGate(greenInputs({ signerRoles: undefined }))).engineering).toBe("FAIL");
  });

  it("J. FINCO_BURN_ENABLED=true (or any safety-flag drift) fails", async () => {
    const r = await evaluateGate(greenInputs({ flags: { ...manifest().expectedFlags, FINCO_BURN_ENABLED: true } }));
    expect(r.blockers).toContain("FLAG_DRIFT: FINCO_BURN_ENABLED=true (required false)");
    const p = await evaluateGate(greenInputs({ flags: { ...manifest().expectedFlags, PRODUCTION_BLOCKED: false } }));
    expect(p.engineering).toBe("FAIL");
  });

  it("Class B/C evidence must be signed by an ALLOWLISTED key; an agent-made signature never passes", async () => {
    const rogue = generatePrivateKey();
    const ev = await signed(rogue, "C01_SMART_CONTRACT_AUDIT");
    const r = await evaluateGate(greenInputs({ externalApprovals: [ev] }));
    expect(r.items.find((i) => i.id === "C01_SMART_CONTRACT_AUDIT")!.status).toBe("INVALID_EVIDENCE");
    // A forged signer field (claims an allowlisted address, signed by another key) is rejected.
    const approver = privateKeyToAccount(generatePrivateKey());
    const forged = { ...ev, signer: approver.address };
    const f = await evaluateGate(greenInputs({ externalApprovals: [forged], externalApproverKeys: [approver.address] }));
    expect(f.items.find((i) => i.id === "C01_SMART_CONTRACT_AUDIT")!.status).toBe("INVALID_EVIDENCE");
  });

  it("even with EVERY Class B/C item validly signed, the gate still reports PRODUCTION_BLOCKED and productionReady=false", async () => {
    const opKey = generatePrivateKey();
    const extKey = generatePrivateKey();
    const m = manifest();
    const operatorEvidence = await Promise.all(m.items.filter((i) => i.class === "B").map((i) => signed(opKey, i.id)));
    const externalApprovals = await Promise.all(m.items.filter((i) => i.class === "C").map((i) => signed(extKey, i.id)));
    const r = await evaluateGate(greenInputs({ operatorEvidence, externalApprovals, operatorKeys: [privateKeyToAccount(opKey).address], externalApproverKeys: [privateKeyToAccount(extKey).address] }));
    expect(r.states).toEqual(["ENGINEERING_PASS", "PRODUCTION_BLOCKED"]);
    expect(r.productionReady).toBe(false);
  });

  it("a Class A item with a missing or failed CI job fails engineering", async () => {
    const i = greenInputs();
    delete i.ciResults["w03: browser E2E (Playwright, production build)"];
    const r = await evaluateGate(i);
    expect(r.engineering).toBe("FAIL");
    expect(r.items.find((x) => x.id === "A10_BROWSER_E2E_PROD_BUILD")!.detail).toMatch(/missing/);
  });
});
