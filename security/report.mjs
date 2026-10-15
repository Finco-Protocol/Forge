#!/usr/bin/env node
/**
 * FINCO Forge unified security report (Slither + Aderyn + Semgrep CE [+ Sonar status]).
 *
 * Dependency-free on purpose (Node >= 20, no install step), so the report job costs seconds.
 *
 *   node security/report.mjs --root . --commit <sha> --out-dir <dir> \
 *        --slither slither.json --aderyn aderyn.json --semgrep semgrep.json \
 *        --versions slither=0.11.6,aderyn=0.6.8,semgrep=1.181.0 \
 *        [--baseline security/baseline.json] [--require slither,aderyn,semgrep] \
 *        [--print-untriaged] [--emit-baseline-skeleton <file>]
 *
 * Exit codes: 0 = policy pass, 1 = policy violation (a NEW, un-triaged critical/high finding in Forge-owned
 * code), 2 = scanner/report/config error. A scanner that crashed, produced no report, produced an invalid report,
 * or is missing from --require NEVER counts as a clean scan.
 *
 * Policy (security/policy.json): findings are normalised to {scanner, version, commit, scope, severity, priority,
 * rule, file, line, evidence, classification, baselineStatus, disposition, requiredFix}. Baseline entries
 * (security/baseline.json) are per-finding fingerprints with a reason; there is NO global or rule-wide
 * suppression of high/critical findings. Inherited, unmodified PONS source is reported and triaged but never
 * blocks (its bytes are deploy-time evidence and must not change).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export class ScannerReportError extends Error {}

/* ───────────────────────────── scope classification ───────────────────────────── */

const AUTH = new Set(["ForgeBindingRegistry.sol", "ForgeLaunchAuthorizer.sol", "IForgeLaunchAuthorizer.sol"]);
const REVENUE = new Set(["ForgeProtocolRevenueSplitter.sol", "IFincoBurnReserveExecutor.sol"]);

/** Scopes whose NEW critical/high findings block the PR. */
export const BLOCKING_SCOPES = new Set(["forge-authorization", "forge-revenue-treasury", "forge-modified-pons", "forge-new-other", "app-forge", "app-scripts", "ci-workflow"]);

const MODIFIED_MARGIN = 10; // conservative: a finding within 10 lines of a Forge change is attributed to Forge-modified code
const rangeCache = new Map();

/**
 * Line ranges (in the Forge copy) that differ from the byte-pinned deploy-time PONS file. null = unknown (treat the
 * whole file as modified: conservative). Uses `diff -U0`; exit status 1 just means "files differ".
 */
export function modifiedRanges(root, file) {
  const key = `${root}|${file}`;
  if (rangeCache.has(key)) return rangeCache.get(key);
  let ranges = null;
  try {
    let out = "";
    try {
      out = execFileSync("diff", ["-U0", path.join(root, file.replace("contractsV2-forge/", "contractsV2-deployed/")), path.join(root, file)], { encoding: "utf8", maxBuffer: 1 << 26 });
    } catch (e) {
      if (e.status !== 1) throw e;
      out = e.stdout;
    }
    ranges = [];
    for (const m of out.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
      const start = Number(m[1]);
      const len = m[2] === undefined ? 1 : Number(m[2]);
      ranges.push([start - MODIFIED_MARGIN, start + Math.max(len, 1) - 1 + MODIFIED_MARGIN]);
    }
  } catch {
    ranges = null;
  }
  rangeCache.set(key, ranges);
  return ranges;
}

/**
 * @param {string} file repo-relative path
 * @param {string} root repo root (used to compare PONS-derived files with the deploy-time tree)
 * @param {number} [line] 1-based line of the finding: in a modified PONS-derived file only lines inside (or within
 *   10 lines of) a changed hunk count as Forge-modified; the rest is inherited PONS code that merely lives in that file.
 */
export function scopeOf(file, root = ".", line = 0) {
  const p = file.replace(/\\/g, "/");
  if (/^(contractsV2-deployed|contractsV2|contractsV1)\/lib\//.test(p) || p.includes("node_modules/")) return "vendored-dependency";
  if (p.startsWith("contractsV2-forge/src/v2/forge/")) {
    const base = path.posix.basename(p);
    if (AUTH.has(base)) return "forge-authorization";
    if (REVENUE.has(base)) return "forge-revenue-treasury";
    return "forge-new-other";
  }
  if (p.startsWith("contractsV2-forge/src/")) {
    const deployed = path.join(root, p.replace("contractsV2-forge/", "contractsV2-deployed/"));
    const mine = path.join(root, p);
    if (!existsSync(deployed)) return "forge-new-other";
    if (!existsSync(mine)) return "forge-new-other";
    if (readFileSync(deployed).equals(readFileSync(mine))) return "inherited-pons";
    const ranges = modifiedRanges(root, p);
    if (ranges === null || line === 0) return "forge-modified-pons";
    return ranges.some(([a, b]) => line >= a && line <= b) ? "forge-modified-pons" : "inherited-pons";
  }
  if (p.startsWith("contractsV2-deployed/src/") || p.startsWith("contractsV2/src/") || p.startsWith("contractsV1/")) return "inherited-pons";
  if (p.startsWith("test-forge/")) return "forge-tests";
  if (p.startsWith("apps/forge-web/test/")) return "app-tests";
  if (p.startsWith("apps/forge-web/src/")) return "app-forge";
  if (p.startsWith("apps/forge-web/scripts/") || p.startsWith("scripts/") || p.startsWith("security/") || p.startsWith("semgrep/")) return "app-scripts";
  if (p.startsWith(".github/")) return "ci-workflow";
  return "other";
}

/* ───────────────────────────── helpers ───────────────────────────── */

const SEVERITIES = ["critical", "high", "medium", "low", "info"];
/** @param {string} sev */
export const priorityOf = (sev) => ({ critical: "P0", high: "P1", medium: "P2", low: "P3", info: "P3" })[sev] ?? "P3";

function readJson(file, scanner) {
  if (!file || !existsSync(file)) throw new ScannerReportError(`${scanner}: report file missing (${file ?? "not given"}) - a missing report is never a clean scan`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new ScannerReportError(`${scanner}: report is not valid JSON (${file}): ${e.message}`);
  }
}

const sourceCache = new Map();
function sourceLine(root, file, line) {
  const p = path.join(root, file);
  if (!sourceCache.has(p)) sourceCache.set(p, existsSync(p) ? readFileSync(p, "utf8").split("\n") : null);
  const lines = sourceCache.get(p);
  return lines && line >= 1 && line <= lines.length ? lines[line - 1] : "";
}
const norm = (s) => s.replace(/\s+/g, " ").trim();

/** @returns {import('./report.mjs').Finding[]} (see schema in docs/SECURITY-TOOLCHAIN.md) */
function finalize(raw, ctx) {
  const out = [];
  const seen = new Map();
  for (const f of raw.sort((a, b) => (a.file + a.rule).localeCompare(b.file + b.rule) || a.line - b.line)) {
    const anchor = norm(sourceLine(ctx.root, f.file, f.line)) || norm(f.evidence).slice(0, 120);
    const k = `${f.scanner}|${f.rule}|${f.file}|${anchor}`;
    const occ = seen.get(k) ?? 0;
    seen.set(k, occ + 1);
    const fingerprint = createHash("sha256").update(`${k}|${occ}`).digest("hex").slice(0, 16);
    const scope = scopeOf(f.file, ctx.root, f.line);
    out.push({
      fingerprint,
      scanner: f.scanner,
      scannerVersion: ctx.versions[f.scanner] ?? "unknown",
      commit: ctx.commit,
      scope,
      severity: f.severity,
      priority: priorityOf(f.severity),
      rule: f.rule,
      title: f.title,
      file: f.file,
      line: f.line,
      anchor,
      evidence: f.evidence,
      classification: "untriaged",
      baselineStatus: "new",
      disposition: "open",
      requiredFix: "",
      reason: "",
    });
  }
  return out;
}

/* ───────────────────────────── parsers ───────────────────────────── */

const SLITHER_SEV = { High: "high", Medium: "medium", Low: "low", Informational: "info", Optimization: "info" };

export function parseSlither(json) {
  if (!json || typeof json !== "object" || json.success !== true) throw new ScannerReportError(`slither: report says success=${json?.success} error=${json?.error ?? "n/a"}`);
  const detectors = json.results?.detectors;
  if (!Array.isArray(detectors)) throw new ScannerReportError("slither: report has no results.detectors array");
  const raw = [];
  for (const d of detectors) {
    const el = (d.elements ?? []).find((e) => e.source_mapping?.filename_relative) ?? null;
    if (!el) continue;
    raw.push({
      scanner: "slither",
      rule: d.check,
      title: d.check,
      severity: SLITHER_SEV[d.impact] ?? "info",
      file: el.source_mapping.filename_relative.replace(/\\/g, "/"),
      line: el.source_mapping.lines?.[0] ?? 0,
      evidence: norm(String(d.description ?? "")).slice(0, 400),
      confidence: d.confidence,
    });
  }
  return raw;
}

export function parseAderyn(json) {
  if (!json || typeof json !== "object" || !json.high_issues || !json.low_issues || !json.files_summary) throw new ScannerReportError("aderyn: report lacks high_issues/low_issues/files_summary");
  const raw = [];
  for (const [bucket, severity] of [["high_issues", "high"], ["low_issues", "low"]]) {
    for (const issue of json[bucket].issues ?? []) {
      for (const inst of issue.instances ?? []) {
        raw.push({
          scanner: "aderyn",
          rule: issue.detector_name,
          title: issue.title,
          severity,
          file: String(inst.contract_path).replace(/\\/g, "/"),
          line: inst.line_no ?? 0,
          evidence: norm(`${issue.title}: ${inst.hint ?? ""}`).slice(0, 400),
        });
      }
    }
  }
  return raw;
}

const SEMGREP_SEV = { ERROR: "high", WARNING: "medium", INFO: "low" };
/** Fatal Semgrep error types (a partial parse of one file is coverage loss, reported, but not a crash). */
const SEMGREP_NONFATAL = new Set(["PartialParsing", "Syntax error", "SyntaxError", "Lexical error", "LexicalError"]);

export function parseSemgrep(json) {
  if (!json || typeof json !== "object" || !Array.isArray(json.results) || !Array.isArray(json.errors)) throw new ScannerReportError("semgrep: report lacks results/errors arrays");
  const fatal = json.errors.filter((e) => {
    const t = Array.isArray(e.type) ? e.type[0] : e.type;
    return !SEMGREP_NONFATAL.has(t) && (e.level ?? "error") === "error";
  });
  if (fatal.length) throw new ScannerReportError(`semgrep: ${fatal.length} fatal scanner error(s): ${fatal.slice(0, 3).map((e) => String(e.message ?? e.type).split("\n")[0]).join(" | ")}`);
  const raw = json.results.map((r) => ({
    scanner: "semgrep",
    rule: String(r.check_id).split(".").slice(-1)[0],
    title: String(r.extra?.message ?? r.check_id).split("\n")[0].slice(0, 200),
    severity: SEMGREP_SEV[r.extra?.severity] ?? "low",
    file: String(r.path).replace(/\\/g, "/"),
    line: r.start?.line ?? 0,
    evidence: norm(String(r.extra?.lines ?? "")).slice(0, 300) || norm(String(r.extra?.message ?? "")).slice(0, 300),
  }));
  const partial = json.errors
    .filter((e) => SEMGREP_NONFATAL.has(Array.isArray(e.type) ? e.type[0] : e.type))
    .map((e) => String(e.path ?? "?"));
  return { raw, partial: [...new Set(partial)], version: json.version };
}

/* ───────────────────────────── baseline & policy ───────────────────────────── */

export const CLASSIFICATIONS = new Set(["confirmed-vulnerability", "confirmed-issue", "false-positive", "by-design", "informational", "inherited-accepted"]);
export const DISPOSITIONS = new Set(["open", "resolved", "accepted"]);

/** Validates the baseline file shape; rejects wildcard / rule-wide suppression of high+critical. */
export function validateBaseline(b) {
  if (!b || b.version !== 1 || !Array.isArray(b.entries)) throw new ScannerReportError("baseline: expected {version:1, entries:[]}");
  for (const e of b.entries) {
    if (!/^[0-9a-f]{16}$/.test(e.fingerprint ?? "")) throw new ScannerReportError(`baseline: entry without a 16-hex fingerprint (${JSON.stringify(e).slice(0, 80)}) - rule-wide/glob suppression is not allowed`);
    for (const k of ["scanner", "rule", "file", "classification", "disposition", "reason"]) if (!e[k]) throw new ScannerReportError(`baseline: ${e.fingerprint} missing ${k}`);
    if (!CLASSIFICATIONS.has(e.classification)) throw new ScannerReportError(`baseline: ${e.fingerprint} unknown classification ${e.classification}`);
    if (!DISPOSITIONS.has(e.disposition)) throw new ScannerReportError(`baseline: ${e.fingerprint} unknown disposition ${e.disposition}`);
    if (String(e.reason).trim().length < 20) throw new ScannerReportError(`baseline: ${e.fingerprint} reason must be a real justification (>= 20 chars)`);
    if (e.severityOverride && !SEVERITIES.includes(e.severityOverride)) throw new ScannerReportError(`baseline: ${e.fingerprint} bad severityOverride`);
  }
  const ids = b.entries.map((e) => e.fingerprint);
  if (new Set(ids).size !== ids.length) throw new ScannerReportError("baseline: duplicate fingerprints");
  return b;
}

export function applyBaseline(findings, baseline) {
  const by = new Map((baseline?.entries ?? []).map((e) => [e.fingerprint, e]));
  const matched = new Set();
  for (const f of findings) {
    const e = by.get(f.fingerprint);
    if (!e) continue;
    matched.add(f.fingerprint);
    f.baselineStatus = "baseline";
    f.classification = e.classification;
    f.disposition = e.disposition;
    f.requiredFix = e.requiredFix ?? "";
    f.reason = e.reason;
    if (e.severityOverride && e.severityOverride !== f.severity) {
      f.scannerSeverity = f.severity;
      f.severity = e.severityOverride;
      f.priority = priorityOf(f.severity);
    }
  }
  const stale = (baseline?.entries ?? []).filter((e) => !matched.has(e.fingerprint));
  return { stale };
}

/** Canonical digest of the triage entries; an independent approval must be bound to exactly this content. */
export function baselineDigest(baseline) {
  const canon = [...(baseline?.entries ?? [])].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

/**
 * Independent acceptance of the baseline. The baseline is written by the implementing agent; it counts as security
 * acceptance ONLY with a `review` block {approvedBy, approvedAt, entriesSha256} whose digest equals the current entries
 * (any later edit invalidates it). Nothing in the tooling or in CI ever writes that block.
 */
export function baselineAcceptance(baseline) {
  const r = baseline?.review;
  if (!r) return { status: "UNREVIEWED", granted: false, detail: "baseline has no independent review block; findings below are the implementing agent's proposed triage, NOT security acceptance" };
  if (!r.approvedBy || !r.approvedAt || !/^[0-9a-f]{64}$/.test(r.entriesSha256 ?? "")) return { status: "MALFORMED_REVIEW", granted: false, detail: "review block incomplete (approvedBy, approvedAt, entriesSha256 required)" };
  if (r.entriesSha256 !== baselineDigest(baseline)) return { status: "STALE_APPROVAL", granted: false, detail: "baseline entries changed after the recorded approval; re-review required" };
  return { status: "INDEPENDENTLY_APPROVED", granted: true, detail: `approved by ${r.approvedBy} at ${r.approvedAt}` };
}

/** OPEN / ACCEPTED / FALSE_POSITIVE / RESOLVED / UNTRIAGED label for a finding (UNTRIAGED = not in the baseline). */
export function triageStatus(f) {
  if (f.baselineStatus === "new") return "UNTRIAGED";
  if (f.classification === "false-positive" && f.disposition !== "open") return "FALSE_POSITIVE";
  if (f.classification === "inherited-accepted" && f.disposition !== "open") return "DEFERRED_EXTERNAL_AUDIT";
  if (f.disposition === "open") return "OPEN";
  if (f.disposition === "resolved") return "RESOLVED";
  return "ACCEPTED";
}
export const ownershipOf = (f) => (f.scope === "inherited-pons" ? "inherited-pons" : "forge-owned");

/** A finding blocks iff: new (not in baseline), critical/high, in a Forge-owned scope. */
export function isBlocking(f) {
  return f.baselineStatus === "new" && (f.severity === "critical" || f.severity === "high") && BLOCKING_SCOPES.has(f.scope);
}

/* ───────────────────────────── report assembly ───────────────────────────── */

const COUNT_ORDER = ["critical", "high", "medium", "low", "info"];

export function buildReport({ findings, stale, commit, versions, coverage, scannersRun, notConnected, acceptance }) {
  const blocking = findings.filter(isBlocking);
  const bySeverity = Object.fromEntries(COUNT_ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length]));
  const byScope = {};
  for (const f of findings) {
    byScope[f.scope] ??= { total: 0, new: 0, baseline: 0 };
    byScope[f.scope].total++;
    byScope[f.scope][f.baselineStatus]++;
  }
  const triage = {};
  for (const f of findings) {
    const t = (triage[triageStatus(f)] ??= { "inherited-pons": 0, "forge-owned": 0 });
    t[ownershipOf(f)]++;
  }
  const openHighForgeOwned = findings.filter((f) => triageStatus(f) === "OPEN" && (f.severity === "high" || f.severity === "critical") && ownershipOf(f) === "forge-owned");
  const openHighInherited = findings.filter((f) => triageStatus(f) === "OPEN" && (f.severity === "high" || f.severity === "critical") && ownershipOf(f) === "inherited-pons");
  const byScanner = {};
  for (const f of findings) byScanner[f.scanner] = (byScanner[f.scanner] ?? 0) + 1;
  return {
    schema: "finco-forge-security-report/1",
    commit,
    generatedAt: new Date().toISOString(),
    scannersRun,
    scannerVersions: versions,
    notConnected,
    coverage,
    summary: { total: findings.length, bySeverity, byScope, byScanner, new: findings.filter((f) => f.baselineStatus === "new").length, blocking: blocking.length, staleBaselineEntries: stale.length },
    acceptance: acceptance ?? baselineAcceptance(null),
    triage,
    openHighForgeOwned: openHighForgeOwned.map((f) => f.fingerprint),
    openHighInheritedPons: openHighInherited.map((f) => f.fingerprint),
    verdict: blocking.length ? "BLOCKED_NEW_CRITICAL_HIGH_IN_FORGE_OWNED_CODE" : "PASS",
    blocking: blocking.map((f) => f.fingerprint),
    findings: findings.map((f) => ({ ...f, triageStatus: triageStatus(f), ownership: ownershipOf(f) })),
    staleBaseline: stale.map((e) => ({ fingerprint: e.fingerprint, scanner: e.scanner, rule: e.rule, file: e.file, disposition: "resolved-or-moved" })),
  };
}

const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderMarkdown(r) {
  const L = [];
  L.push(`# FINCO Forge unified security report`, "");
  L.push(`- Commit analyzed: \`${r.commit}\``);
  L.push(`- Verdict: **${r.verdict}**`);
  L.push(`- Scanners run: ${r.scannersRun.map((s) => `${s} ${r.scannerVersions[s] ?? "?"}`).join(", ")}`);
  if (r.notConnected.length) L.push(`- NOT CONNECTED (cloud services awaiting administrator authorisation): ${r.notConnected.join(", ")}`);
  L.push(`- Security acceptance: **${r.acceptance.granted ? "GRANTED" : "NOT GRANTED"}** (baseline: ${r.acceptance.status}) - ${r.acceptance.detail}`);
  L.push(`- Findings: ${r.summary.total} (new: ${r.summary.new}, blocking: ${r.summary.blocking}, stale baseline entries: ${r.summary.staleBaselineEntries})`, "");
  L.push(`| Severity | Count |`, `|---|---|`);
  for (const s of COUNT_ORDER) L.push(`| ${s} (${priorityOf(s)}) | ${r.summary.bySeverity[s]} |`);
  L.push("", `## Triage status (OPEN / ACCEPTED / FALSE_POSITIVE; inherited PONS vs Forge-owned)`, "", `| Status | Inherited PONS | Forge-owned |`, `|---|---|---|`);
  for (const [k, v] of Object.entries(r.triage).sort()) L.push(`| ${k} | ${v["inherited-pons"]} | ${v["forge-owned"]} |`);
  L.push("", `OPEN high/critical: ${r.openHighForgeOwned.length} in Forge-owned code, ${r.openHighInheritedPons.length} in inherited PONS code (inherited code is not "safe" because it is unchanged; it needs the external audit).`);
  L.push("", `## Coverage`, "");
  for (const [k, v] of Object.entries(r.coverage)) L.push(`- **${k}**: ${v}`);
  L.push("", `## By scope`, "", `| Scope | Total | New | Baseline (triaged) |`, `|---|---|---|---|`);
  for (const [k, v] of Object.entries(r.summary.byScope).sort()) L.push(`| ${k} | ${v.total} | ${v.new} | ${v.baseline} |`);
  const interesting = r.findings.filter((f) => f.baselineStatus === "new" || f.severity === "critical" || f.severity === "high");
  L.push("", `## New findings and all critical/high findings (${interesting.length})`, "");
  if (!interesting.length) L.push("_none_");
  else {
    L.push(`| Pri | Scanner | Rule | Scope | Location | Status | Classification | Triage |`, `|---|---|---|---|---|---|---|---|`);
    for (const f of interesting.sort((a, b) => a.priority.localeCompare(b.priority) || a.file.localeCompare(b.file) || a.line - b.line)) {
      L.push(`| ${f.priority} | ${f.scanner} | \`${esc(f.rule)}\` | ${f.scope} | \`${esc(f.file)}:${f.line}\` | ${f.baselineStatus} | ${f.classification} | ${triageStatus(f)} (${ownershipOf(f)}) |`);
    }
  }
  if (r.staleBaseline.length) {
    L.push("", `## Stale baseline entries (resolved or moved; remove after review)`, "");
    for (const s of r.staleBaseline) L.push(`- \`${s.fingerprint}\` ${s.scanner}/${s.rule} ${s.file}`);
  }
  L.push("", `_Full per-finding detail (evidence, required fix, reason) is in security-report.json. Baseline entries are the implementing agent's proposals; they are not security acceptance until an independent reviewer records an approval bound to the baseline digest._`, "");
  return L.join("\n");
}

/* ───────────────────────────── CLI ───────────────────────────── */

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Parses the raw scanner reports into normalised findings (shared by the report and the baseline generator). */
export function collect({ root, commit, versions, files, required }) {
  const ctx = { root, commit, versions };
  const raw = [];
  const scannersRun = [];
  const coverage = {};
  for (const s of required) {
    const json = readJson(files[s], s);
    if (s === "slither") raw.push(...parseSlither(json));
    else if (s === "aderyn") raw.push(...parseAderyn(json));
    else if (s === "semgrep") {
      const r = parseSemgrep(json);
      raw.push(...r.raw);
      if (r.version) versions.semgrep = r.version;
      coverage.semgrep = `${json.paths?.scanned?.length ?? "?"} files scanned (app source, scripts, workflows, Python); partially parsed (coverage gap): ${r.partial.length ? r.partial.join(", ") : "none"}`;
    } else throw new ScannerReportError(`unknown scanner ${s}`);
    scannersRun.push(s);
  }
  for (const s of ["slither", "aderyn", "semgrep"]) if (!scannersRun.includes(s)) coverage[s] = "NOT RUN in this invocation";
  if (scannersRun.includes("slither")) coverage.slither = "full Foundry profile `forge` dependency graph analysed; vendored dependency paths excluded from the report (analysed, not reported)";
  if (scannersRun.includes("aderyn")) coverage.aderyn = "contractsV2-forge/src (Forge-owned + PONS-derived sources; vendored libraries are not ingested)";
  return { findings: finalize(raw, ctx), scannersRun, coverage };
}

export async function main(argv) {
  const root = path.resolve(arg(argv, "--root") ?? ".");
  const commit = arg(argv, "--commit") ?? "UNKNOWN";
  const outDir = arg(argv, "--out-dir") ?? "security-out";
  const required = (arg(argv, "--require") ?? "slither,aderyn,semgrep").split(",").filter(Boolean);
  const versions = Object.fromEntries((arg(argv, "--versions") ?? "").split(",").filter(Boolean).map((kv) => kv.split("=")));
  const files = { slither: arg(argv, "--slither"), aderyn: arg(argv, "--aderyn"), semgrep: arg(argv, "--semgrep") };
  const { findings, scannersRun, coverage } = collect({ root, commit, versions, files, required });
  const baselinePath = arg(argv, "--baseline");
  const baseline = baselinePath ? validateBaseline(readJson(baselinePath, "baseline")) : { version: 1, entries: [] };
  const { stale } = applyBaseline(findings, baseline);
  const notConnected = (arg(argv, "--not-connected") ?? "").split(",").filter(Boolean);
  const acceptance = baselineAcceptance(baseline);
  const report = buildReport({ findings, stale, commit, versions, coverage, scannersRun, notConnected, acceptance });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "security-report.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(path.join(outDir, "security-report.md"), renderMarkdown(report));
  const skeleton = arg(argv, "--emit-baseline-skeleton");
  if (skeleton) {
    const entries = findings
      .filter((f) => f.baselineStatus === "new" && f.scope !== "vendored-dependency")
      .map((f) => ({ fingerprint: f.fingerprint, scanner: f.scanner, rule: f.rule, file: f.file, line: f.line, scope: f.scope, severity: f.severity, anchor: f.anchor, classification: "", disposition: "", reason: "", requiredFix: "" }));
    writeFileSync(skeleton, JSON.stringify({ version: 1, entries }, null, 2) + "\n");
  }
  console.log(`SECURITY_REPORT commit=${commit} total=${report.summary.total} new=${report.summary.new} blocking=${report.summary.blocking} stale=${report.summary.staleBaselineEntries} verdict=${report.verdict} acceptance=${acceptance.status} openHighForgeOwned=${report.openHighForgeOwned.length} openHighInherited=${report.openHighInheritedPons.length}`);
  if (!acceptance.granted) console.log(`::warning::security baseline is ${acceptance.status}: this report is NOT independent security acceptance`);
  for (const f of findings.filter((x) => report.openHighForgeOwned.includes(x.fingerprint))) console.log(`::warning file=${f.file},line=${f.line}::OPEN ${f.priority} in Forge-owned code (baselined, unresolved): ${f.scanner}/${f.rule}`);
  for (const f of findings.filter(isBlocking)) console.log(`::error file=${f.file},line=${f.line}::[${f.priority}] ${f.scanner}/${f.rule} NEW in ${f.scope}: ${f.title}`);
  for (const s of stale) console.log(`::warning::stale baseline entry ${s.fingerprint} (${s.scanner}/${s.rule} ${s.file}) no longer matches - resolved or moved; remove after review`);
  return report.summary.blocking ? 1 : 0;
}

/** True when this module is the process entry point (handles encoded paths, symlinks, Windows paths). */
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`::error::SECURITY_TOOLCHAIN_ERROR ${e instanceof ScannerReportError ? e.message : e.stack}`);
      process.exit(2);
    },
  );
}
