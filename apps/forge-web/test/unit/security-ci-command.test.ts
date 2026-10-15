/**
 * Clean-run test for the exact shell command the CI report job executes (security/ci-report.sh):
 * the output directory is gitignored, so it does not exist on a fresh runner; the pipeline must create it
 * before `| tee`, and pipefail must preserve report.mjs's distinct exit codes (1 policy, 2 scanner error).
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SCRIPT = path.join(ROOT, "security", "ci-report.sh");
const SOL = "contractsV2-forge/src/v2/forge/ForgeProtocolRevenueSplitter.sol";

function fresh(files: Record<string, unknown>) {
  const dir = mkdtempSync(path.join(tmpdir(), "ci-report-"));
  mkdirSync(path.join(dir, path.dirname(SOL)), { recursive: true });
  writeFileSync(path.join(dir, SOL), "line1\n  bad();\nline3\n");
  mkdirSync(path.join(dir, "scan-in"));
  for (const [k, v] of Object.entries(files)) writeFileSync(path.join(dir, "scan-in", `${k}.json`), JSON.stringify(v));
  writeFileSync(path.join(dir, "baseline.json"), JSON.stringify({ version: 1, entries: [] }));
  return dir;
}
function ci(dir: string, required = "slither,aderyn,semgrep") {
  expect(existsSync(path.join(dir, "security-report"))).toBe(false); // exactly the fresh-runner precondition
  return spawnSync("bash", [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    env: ({
      PATH: process.env.PATH ?? "",
      REPORT_COMMIT: "deadbeef",
      REPORT_REQUIRED: required,
      REPORT_SCRIPT: path.join(ROOT, "security", "report.mjs"),
      REPORT_BASELINE: path.join(dir, "baseline.json"),
      SLITHER_VERSION: "0.11.6",
      ADERYN_VERSION: "0.6.8",
      SEMGREP_VERSION: "1.181.0",
    }) as unknown as NodeJS.ProcessEnv,
  });
}
const slither = { success: true, error: null, results: { detectors: [] } };
const semgrep = { version: "1.181.0", results: [], errors: [], paths: { scanned: [] } };
const aderyn = (sev: "high_issues" | "low_issues") => ({
  files_summary: {},
  files_details: {},
  high_issues: { issues: sev === "high_issues" ? [{ detector_name: "reentrancy-state-change", title: "t", instances: [{ contract_path: SOL, line_no: 2, hint: "h" }] }] : [] },
  low_issues: { issues: [] },
});

describe("CI report command on a clean runner (security-report/ absent)", () => {
  it("clean scan: creates the dir, tees policy.log, exits 0, writes the report artifacts", () => {
    const dir = fresh({ slither, aderyn: aderyn("low_issues"), semgrep });
    const r = ci(dir);
    expect(r.status).toBe(0);
    expect(existsSync(path.join(dir, "security-report", "policy.log"))).toBe(true);
    expect(existsSync(path.join(dir, "security-report", "security-report.md"))).toBe(true);
    expect(readFileSync(path.join(dir, "security-report", "policy.log"), "utf8").length).toBeGreaterThan(0);
  });
  it("new high in Forge-owned code: policy violation exit 1 survives the tee pipeline", () => {
    const dir = fresh({ slither, aderyn: aderyn("high_issues"), semgrep });
    expect(ci(dir).status).toBe(1);
    expect(existsSync(path.join(dir, "security-report", "policy.log"))).toBe(true);
  });
  it("missing required scanner artifact: scanner/config error exit 2, never a clean scan", () => {
    const dir = fresh({ slither, semgrep }); // aderyn.json absent
    expect(ci(dir).status).toBe(2);
  });
  it("crashed scanner output (unparseable JSON): exit 2", () => {
    const dir = fresh({ slither, aderyn: aderyn("low_issues"), semgrep });
    writeFileSync(path.join(dir, "scan-in", "semgrep.json"), "{not json");
    expect(ci(dir).status).toBe(2);
  });
  it("the workflow invokes exactly this script and keeps required inputs out of the shell text", () => {
    const wf = readFileSync(path.join(ROOT, ".github", "workflows", "security-toolchain.yml"), "utf8");
    expect(wf).toContain("run: bash security/ci-report.sh");
    expect(readFileSync(SCRIPT, "utf8")).toMatch(/set -euo pipefail[\s\S]*mkdir -p "\$OUT"[\s\S]*\| tee/);
  });
});
