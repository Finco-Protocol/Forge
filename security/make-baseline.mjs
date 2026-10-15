#!/usr/bin/env node
/**
 * Generates security/baseline.json from the CURRENT scanner reports and security/triage-decisions.json.
 *
 *   node security/make-baseline.mjs --root . --commit <sha> --slither s.json --aderyn a.json --semgrep m.json \
 *        --versions slither=..,aderyn=..,semgrep=.. [--out security/baseline.json]
 *
 * Every non-vendored finding must match a decision; an unmatched finding aborts with its fingerprint (forcing an
 * explicit triage decision). Run it deliberately; CI never regenerates the baseline.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { collect, validateBaseline } from "./report.mjs";

const argv = process.argv.slice(2);
const arg = (n) => (argv.indexOf(n) >= 0 ? argv[argv.indexOf(n) + 1] : undefined);
const root = path.resolve(arg("--root") ?? ".");
const versions = Object.fromEntries((arg("--versions") ?? "").split(",").filter(Boolean).map((kv) => kv.split("=")));
const { findings } = collect({
  root,
  commit: arg("--commit") ?? "UNKNOWN",
  versions,
  files: { slither: arg("--slither"), aderyn: arg("--aderyn"), semgrep: arg("--semgrep") },
  required: ["slither", "aderyn", "semgrep"],
});
const dec = JSON.parse(readFileSync(path.join(root, "security", "triage-decisions.json"), "utf8"));

const matches = (m, f) =>
  (!m.scanner || m.scanner === f.scanner) &&
  (!m.rule || m.rule === f.rule) &&
  (!m.rules || m.rules.includes(f.rule)) &&
  (!m.scope || m.scope === f.scope) &&
  (!m.scopes || m.scopes.includes(f.scope)) &&
  (!m.file || m.file === f.file);

const entries = [];
const unmatched = [];
for (const f of findings) {
  if (f.scope === "vendored-dependency") continue;
  // High/critical findings are only ever matched by decisions that NAME the rule(s) - never by a scope-wide catch-all.
  const high = f.severity === "high" || f.severity === "critical";
  const d = dec.decisions.find((x) => matches(x.match, f) && (!high || x.match.rule || x.match.rules));
  if (!d) {
    unmatched.push(f);
    continue;
  }
  entries.push({
    fingerprint: f.fingerprint,
    scanner: f.scanner,
    rule: f.rule,
    file: f.file,
    line: f.line,
    scope: f.scope,
    severity: f.severity,
    anchor: f.anchor,
    classification: d.classification,
    disposition: d.disposition,
    reason: d.reason,
    requiredFix: d.requiredFix,
  });
}
if (unmatched.length) {
  for (const f of unmatched) console.error(`UNTRIAGED ${f.fingerprint} ${f.priority} ${f.scanner}/${f.rule} ${f.scope} ${f.file}:${f.line}`);
  console.error(`${unmatched.length} finding(s) need a triage decision in security/triage-decisions.json`);
  process.exit(1);
}
entries.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule) || a.fingerprint.localeCompare(b.fingerprint));
const out = { version: 1, reviewStatus: dec.reviewStatus, generatedFrom: { commit: arg("--commit") ?? "UNKNOWN", versions }, entries };
validateBaseline(out);
writeFileSync(arg("--out") ?? path.join(root, "security", "baseline.json"), JSON.stringify(out, null, 1) + "\n");
console.log(`baseline: ${entries.length} entries (${entries.filter((e) => e.disposition === "open").length} open)`);
