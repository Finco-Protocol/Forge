/** High/critical triage requires the exact reviewed fingerprint (security/triage.mjs + make-baseline.mjs). */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
/* eslint-disable @typescript-eslint/no-explicit-any */
const T: Record<string, any> = await import(path.join(ROOT, "security", "triage.mjs"));
const R: Record<string, any> = await import(path.join(ROOT, "security", "report.mjs"));
const MAKE = path.join(ROOT, "security", "make-baseline.mjs");
const SOL = "contractsV2-forge/src/v2/forge/ForgeProtocolRevenueSplitter.sol";

const f = (o: Record<string, unknown> = {}) => ({ scanner: "aderyn", rule: "reentrancy-state-change", scope: "forge-revenue-treasury", file: SOL, severity: "high", fingerprint: "aaaaaaaaaaaaaaaa", ...o });
const decision = (match: Record<string, unknown>) => ({ match, classification: "false-positive", disposition: "accepted", reason: "reviewed: guarded by nonReentrant in the caller" });

describe("decision matching", () => {
  it("a high finding with the same rule but a different fingerprint is NOT matched", () => {
    const d = decision({ scanner: "aderyn", rule: "reentrancy-state-change", scope: "forge-revenue-treasury", fingerprints: ["aaaaaaaaaaaaaaaa"] });
    expect(T.findDecision([d], f({ fingerprint: "bbbbbbbbbbbbbbbb" }))).toBeUndefined();
  });
  it("a high finding with the exact reviewed fingerprint matches", () => {
    const d = decision({ scanner: "aderyn", rule: "reentrancy-state-change", scope: "forge-revenue-treasury", fingerprints: ["aaaaaaaaaaaaaaaa"] });
    expect(T.findDecision([d], f())).toBe(d);
  });
  it("rule-wide, scope-wide and catch-all decisions cannot approve high or critical findings", () => {
    for (const m of [{ rule: "reentrancy-state-change" }, { scope: "forge-revenue-treasury" }, { scanner: "aderyn" }, {}, { rules: ["reentrancy-state-change"], scopes: ["forge-revenue-treasury"] }]) {
      expect(T.findDecision([decision(m)], f()), JSON.stringify(m)).toBeUndefined();
      expect(T.findDecision([decision(m)], f({ severity: "critical" })), JSON.stringify(m)).toBeUndefined();
    }
  });
  it("the fingerprint does not widen the descriptor: it must still match scanner/rule/scope", () => {
    const d = decision({ scanner: "slither", rule: "x", fingerprints: ["aaaaaaaaaaaaaaaa"] });
    expect(T.findDecision([d], f())).toBeUndefined();
  });
  it("lower severities may still use a descriptive decision", () => {
    expect(T.findDecision([decision({ rule: "reentrancy-state-change" })], f({ severity: "low" }))).toBeDefined();
  });
  it("non-exact fingerprints (globs, short ids) are rejected in the decision file", () => {
    for (const fp of ["*", "aaaa", "AAAAAAAAAAAAAAAA", "aaaaaaaaaaaaaaa*"]) expect(() => T.validateDecisions({ decisions: [decision({ fingerprints: [fp] })] })).toThrow(/exact 16-hex/);
  });
});

describe("make-baseline end to end (deliberate regeneration)", () => {
  function sandbox(decisions: unknown[]) {
    const dir = mkdtempSync(path.join(tmpdir(), "mkb-"));
    mkdirSync(path.join(dir, "security"), { recursive: true });
    mkdirSync(path.join(dir, path.dirname(SOL)), { recursive: true });
    writeFileSync(path.join(dir, SOL), "line1\n  bad();\nline3\n");
    writeFileSync(path.join(dir, "security", "triage-decisions.json"), JSON.stringify({ reviewStatus: "PROPOSED_BY_AGENT_PENDING_INDEPENDENT_REVIEW", decisions }));
    const slither = { success: true, error: null, results: { detectors: [] } };
    const semgrep = { version: "1.181.0", results: [], errors: [], paths: { scanned: [] } };
    const aderyn = (line: number) => ({ files_summary: {}, files_details: {}, high_issues: { issues: [{ detector_name: "reentrancy-state-change", title: "t", instances: [{ contract_path: SOL, line_no: line, hint: "h" }] }] }, low_issues: { issues: [] } });
    const w = (n: string, v: unknown) => (writeFileSync(path.join(dir, n), JSON.stringify(v)), path.join(dir, n));
    return { dir, files: { slither: w("s.json", slither), semgrep: w("m.json", semgrep), a1: w("a1.json", aderyn(2)), a3: w("a3.json", aderyn(3)) } };
  }
  const run = (dir: string, files: Record<string, string>, aderyn: string) =>
    spawnSync("node", [MAKE, "--root", dir, "--commit", "x", "--slither", files.slither!, "--aderyn", aderyn, "--semgrep", files.semgrep!, "--versions", "slither=1,aderyn=1,semgrep=1"], { encoding: "utf8" });

  it("a new high under the same rule (new fingerprint) is UNTRIAGED and aborts; the reviewed one is accepted", () => {
    // find the reviewed fingerprint by scanning line 2
    const probe = sandbox([]);
    const first = run(probe.dir, probe.files, probe.files.a1!);
    expect(first.status).toBe(1);
    const fp1 = /UNTRIAGED ([0-9a-f]{16})/.exec(first.stderr)![1]!;
    const sb = sandbox([decision({ scanner: "aderyn", rule: "reentrancy-state-change", scope: "forge-revenue-treasury", fingerprints: [fp1] })]);
    const ok = run(sb.dir, sb.files, sb.files.a1!);
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(readFileSync(path.join(sb.dir, "security", "baseline.json"), "utf8")).entries[0].fingerprint).toBe(fp1);
    const fresh = run(sb.dir, sb.files, sb.files.a3!); // different line => different fingerprint, same rule/scope
    expect(fresh.status).toBe(1);
    expect(fresh.stderr).toMatch(/UNTRIAGED/);
  });
  it("a rule-wide decision without a fingerprint leaves the high finding UNTRIAGED", () => {
    const sb = sandbox([decision({ scanner: "aderyn", rule: "reentrancy-state-change", scope: "forge-revenue-treasury" })]);
    const r = run(sb.dir, sb.files, sb.files.a1!);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/UNTRIAGED/);
  });
});

describe("committed decisions", () => {
  it("every high/critical baseline entry is covered by a decision listing its exact fingerprint, and the baseline stays unreviewed", () => {
    const dec = JSON.parse(readFileSync(path.join(ROOT, "security", "triage-decisions.json"), "utf8"));
    const base = JSON.parse(readFileSync(path.join(ROOT, "security", "baseline.json"), "utf8"));
    const highs = base.entries.filter((e: any) => e.severity === "high" || e.severity === "critical");
    expect(highs.length).toBeGreaterThan(0);
    for (const e of highs) expect(T.findDecision(dec.decisions, { ...e }), e.fingerprint).toBeDefined();
    expect(base.review).toBeUndefined();
    expect(R.baselineAcceptance(base).granted).toBe(false);
  });
});
