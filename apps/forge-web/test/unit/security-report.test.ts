/**
 * Free security toolchain (Slither, Aderyn, Semgrep CE) - unified report, scope classification and policy.
 * The report tool is dependency-free ESM (security/report.mjs) so the CI report job needs no install step.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
/* eslint-disable @typescript-eslint/no-explicit-any */
const R: Record<string, any> = await import(path.join(ROOT, "security", "report.mjs"));
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), "sec-"));
  mkdirSync(path.join(dir, "contractsV2-forge", "src", "v2", "forge"), { recursive: true });
  writeFileSync(path.join(dir, "contractsV2-forge", "src", "v2", "forge", "ForgeProtocolRevenueSplitter.sol"), "line1\n  bad();\nline3\n");
  return dir;
}
const aderyn = (line: number, rule = "reentrancy-state-change", sev: "high_issues" | "low_issues" = "high_issues", file = "contractsV2-forge/src/v2/forge/ForgeProtocolRevenueSplitter.sol") => ({
  files_summary: {},
  files_details: {},
  high_issues: { issues: sev === "high_issues" ? [{ detector_name: rule, title: rule, instances: [{ contract_path: file, line_no: line, hint: "h" }] }] : [] },
  low_issues: { issues: sev === "low_issues" ? [{ detector_name: rule, title: rule, instances: [{ contract_path: file, line_no: line, hint: "h" }] }] : [] },
});
const slitherOk = { success: true, error: null, results: { detectors: [] } };
const semgrepOk = { version: "1.181.0", results: [], errors: [], paths: { scanned: [] } };

function runMain(dir: string, files: Record<string, unknown>, extra: string[] = []) {
  const f: string[] = [];
  for (const [k, v] of Object.entries(files)) {
    const p = path.join(dir, `${k}.json`);
    writeFileSync(p, JSON.stringify(v));
    f.push(`--${k}`, p);
  }
  return R.main(["--root", dir, "--commit", "deadbeef", "--out-dir", path.join(dir, "out"), ...f, ...extra]);
}

describe("scanner failures are never a clean scan", () => {
  it("a crashed Slither run (success=false), a missing report and an invalid report all abort with ScannerReportError", () => {
    expect(() => R.parseSlither({ success: false, error: "crytic-compile failed", results: {} })).toThrow(/success=false/);
    expect(() => R.parseSlither({ success: true, results: {} })).toThrow(/no results\.detectors/);
    expect(() => R.parseAderyn({ foo: 1 })).toThrow(/lacks high_issues/);
    expect(() => R.parseSemgrep({ results: [] })).toThrow(/lacks results\/errors/);
  });
  it("fatal Semgrep errors abort; a partial parse is reported as a coverage gap, not as a crash", () => {
    expect(() => R.parseSemgrep({ results: [], errors: [{ type: ["InvalidRuleSchemaError"], level: "error", message: "bad rule" }] })).toThrow(/fatal scanner error/);
    const r = R.parseSemgrep({ results: [], errors: [{ type: ["PartialParsing", []], level: "warn", path: "a.ts" }], version: "1" });
    expect(r.partial).toEqual(["a.ts"]);
  });
  it("main() exits 2 for a missing required report and for a crashed scanner", async () => {
    const dir = sandbox();
    await expect(runMain(dir, { slither: slitherOk, aderyn: aderyn(2, "x", "low_issues") })).rejects.toThrow(/semgrep: report file missing/);
    await expect(runMain(dir, { slither: { success: false, error: "boom" }, aderyn: aderyn(2), semgrep: semgrepOk })).rejects.toThrow(/slither: report says success=false/);
  });
});

describe("scope classification (inherited vs modified vs new Forge code)", () => {
  it("classifies every Forge contract group from the real repository", () => {
    const s = (f: string, line = 0) => R.scopeOf(f, ROOT, line);
    expect(s("contractsV2-forge/src/v2/forge/ForgeBindingRegistry.sol")).toBe("forge-authorization");
    expect(s("contractsV2-forge/src/v2/forge/ForgeLaunchAuthorizer.sol")).toBe("forge-authorization");
    expect(s("contractsV2-forge/src/v2/forge/ForgeProtocolRevenueSplitter.sol")).toBe("forge-revenue-treasury");
    expect(s("contractsV2-forge/src/v2/PonsV2FeeEscrow.sol")).toBe("inherited-pons"); // byte-identical to deployed
    expect(s("contractsV2-forge/src/v2/hooks/PonsV2MemeHook.sol", 10)).toBe("inherited-pons");
    expect(s("contractsV2-deployed/lib/v4-core/src/PoolManager.sol")).toBe("vendored-dependency");
    expect(s("apps/forge-web/src/server/crypto.ts")).toBe("app-forge");
    expect(s("apps/forge-web/scripts/w05/deploy-plan.ts")).toBe("app-scripts");
    expect(s(".github/workflows/w05.yml")).toBe("ci-workflow");
  });
  it("in the modified PONS factory only lines near a Forge change are Forge-modified; the rest is inherited", () => {
    const f = "contractsV2-forge/src/v2/PonsV2LaunchFactory.sol";
    expect(R.scopeOf(f, ROOT, 379)).toBe("forge-modified-pons"); // constructor wiring added by Forge
    expect(R.scopeOf(f, ROOT, 1177)).toBe("inherited-pons"); // untouched PONS code in the same file
    expect(R.scopeOf(f, ROOT, 0)).toBe("forge-modified-pons"); // unknown line: conservative
  });
});

describe("fingerprints, baseline and blocking policy", () => {
  it("fingerprints survive line movement (anchored on the source line text), and change when that line is edited", async () => {
    const a = sandbox();
    const b = sandbox();
    writeFileSync(path.join(b, "contractsV2-forge/src/v2/forge/ForgeProtocolRevenueSplitter.sol"), "x\ny\nz\nline1\n  bad();\nline3\n");
    const fp = (dir: string, line: number) => R.collect({ root: dir, commit: "c", versions: {}, files: { aderyn: (writeFileSync(path.join(dir, "a.json"), JSON.stringify(aderyn(line))), path.join(dir, "a.json")) }, required: ["aderyn"] }).findings[0].fingerprint;
    expect(fp(a, 2)).toBe(fp(b, 5));
    const c = sandbox(); // the source cache is per process, so the edited variant gets its own tree
    writeFileSync(path.join(c, "contractsV2-forge/src/v2/forge/ForgeProtocolRevenueSplitter.sol"), "x\ny\nz\nline1\n  worse();\nline3\n");
    expect(fp(a, 2)).not.toBe(fp(c, 5));
  });

  it("a NEW high finding in Forge-owned code blocks (exit 1); once triaged in the baseline it passes (exit 0)", async () => {
    const dir = sandbox();
    const files = { slither: slitherOk, aderyn: aderyn(2), semgrep: semgrepOk };
    expect(await runMain(dir, files)).toBe(1);
    const fp = JSON.parse(readFileSync(path.join(dir, "out", "security-report.json"), "utf8")).findings[0].fingerprint;
    const baseline = { version: 1, entries: [{ fingerprint: fp, scanner: "aderyn", rule: "reentrancy-state-change", file: "contractsV2-forge/src/v2/forge/ForgeProtocolRevenueSplitter.sol", classification: "false-positive", disposition: "accepted", reason: "view call before a guarded state write (test)" }] };
    writeFileSync(path.join(dir, "baseline.json"), JSON.stringify(baseline));
    expect(await runMain(dir, files, ["--baseline", path.join(dir, "baseline.json")])).toBe(0);
    const rep = JSON.parse(readFileSync(path.join(dir, "out", "security-report.json"), "utf8"));
    expect(rep.findings[0]).toMatchObject({ baselineStatus: "baseline", classification: "false-positive", priority: "P1" });
  });

  it("new medium/low findings, inherited-unmodified findings and vendored findings never block; stale baseline entries only warn", async () => {
    const dir = sandbox();
    expect(await runMain(dir, { slither: slitherOk, aderyn: aderyn(2, "centralization-risk", "low_issues"), semgrep: semgrepOk })).toBe(0);
    mkdirSync(path.join(dir, "contractsV2-deployed/src/v2"), { recursive: true });
    mkdirSync(path.join(dir, "contractsV2-forge/src/v2"), { recursive: true });
    writeFileSync(path.join(dir, "contractsV2-deployed/src/v2/P.sol"), "same\n");
    writeFileSync(path.join(dir, "contractsV2-forge/src/v2/P.sol"), "same\n");
    expect(await runMain(dir, { slither: slitherOk, aderyn: aderyn(1, "reentrancy-state-change", "high_issues", "contractsV2-forge/src/v2/P.sol"), semgrep: semgrepOk })).toBe(0);
    expect(JSON.parse(readFileSync(path.join(dir, "out", "security-report.json"), "utf8")).findings[0].scope).toBe("inherited-pons");
    writeFileSync(path.join(dir, "stale.json"), JSON.stringify({ version: 1, entries: [{ fingerprint: "0123456789abcdef", scanner: "aderyn", rule: "r", file: "f", classification: "by-design", disposition: "accepted", reason: "obsolete entry for a finding that no longer exists" }] }));
    expect(await runMain(dir, { slither: slitherOk, aderyn: aderyn(2, "x", "low_issues"), semgrep: semgrepOk }, ["--baseline", path.join(dir, "stale.json")])).toBe(0);
    expect(JSON.parse(readFileSync(path.join(dir, "out", "security-report.json"), "utf8")).summary.staleBaselineEntries).toBe(1);
  });

  it("the baseline format refuses rule-wide/glob suppression, empty justifications and unknown classifications", () => {
    const e = { fingerprint: "0123456789abcdef", scanner: "s", rule: "r", file: "f", classification: "by-design", disposition: "accepted", reason: "a real justification text here" };
    expect(() => R.validateBaseline({ version: 1, entries: [{ ...e, fingerprint: "*" }] })).toThrow(/16-hex fingerprint/);
    expect(() => R.validateBaseline({ version: 1, entries: [{ ...e, reason: "ok" }] })).toThrow(/real justification/);
    expect(() => R.validateBaseline({ version: 1, entries: [{ ...e, classification: "whatever" }] })).toThrow(/classification/);
    expect(() => R.validateBaseline({ version: 1, entries: [e, e] })).toThrow(/duplicate/);
    expect(R.validateBaseline({ version: 1, entries: [e] }).entries).toHaveLength(1);
  });
});

describe("committed security configuration", () => {
  it("security/baseline.json is valid, every entry has a justification, and no high/critical Forge-owned entry is accepted without a specific classification", () => {
    const b = R.validateBaseline(JSON.parse(read("security/baseline.json")));
    expect(b.entries.length).toBeGreaterThan(0);
    expect(b.reviewStatus).toBe("PROPOSED_BY_AGENT_PENDING_INDEPENDENT_REVIEW");
    for (const e of b.entries) {
      expect(e.scope).not.toBe("vendored-dependency");
      if ((e.severity === "high" || e.severity === "critical") && e.scope !== "inherited-pons") {
        expect(["false-positive", "by-design", "confirmed-issue"]).toContain(e.classification);
        expect(e.reason.length).toBeGreaterThan(60);
      }
    }
  });
  it("the workflow uses Slither --fail-none (crash != findings), no Semgrep token, metrics off, and gates on the unified report", () => {
    const w = read(".github/workflows/security-toolchain.yml");
    expect(w).toMatch(/slither \. .*--fail-none/s);
    expect(w).toContain("--metrics=off");
    expect(w).not.toMatch(/SEMGREP_APP_TOKEN|semgrep ci|semgrep login/);
    expect(w).toMatch(/node security\/report\.mjs/);
    expect(w).toMatch(/permissions:\n\s+contents: read/);
  });
  it("SonarQube Cloud config invents no organisation or project key, and CodeRabbit is repo-scoped config only", () => {
    const sp = read("sonar-project.properties");
    expect(sp).not.toMatch(/^sonar\.(organization|projectKey)\s*=/m);
    expect(sp).not.toMatch(/^sonar\.token/m);
    expect(read(".github/workflows/sonarqube-cloud.yml")).toContain("SONARQUBE_CLOUD_NOT_CONNECTED");
    expect(read(".coderabbit.yaml")).toContain("schema.v2.json");
  });
});
