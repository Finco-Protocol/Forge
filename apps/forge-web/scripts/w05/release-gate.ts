/**
 * W05 release-gate CLI.
 *
 *   tsx scripts/w05/release-gate.ts manifest            # restamp release/readiness-manifest.json
 *   tsx scripts/w05/release-gate.ts evaluate --ci <ci-results.json> [--reconciliation <json>]
 *        [--deploy <json>] [--signers <json>] [--out <report.json>]
 *
 * `evaluate` exits 0 only on ENGINEERING_PASS. It can never report
 * production readiness (see src/release/gate.ts).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { evaluateGate, manifestIntegrity, type ReadinessManifest, type SignedEvidence } from "../../src/release/gate";
import { currentFlags } from "../../src/release/flags";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const REL = path.join(ROOT, "release");
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const cmd = process.argv[2];
  if (cmd === "manifest") {
    const src = readJson<Omit<ReadinessManifest, "integrity"> & { $comment?: string }>(path.join(REL, "readiness-items.json"));
    const m: ReadinessManifest = { version: src.version, workflow: src.workflow, expectedFlags: src.expectedFlags, items: src.items, integrity: "0x" };
    m.integrity = manifestIntegrity(m);
    writeFileSync(path.join(REL, "readiness-manifest.json"), JSON.stringify(m, null, 2) + "\n");
    console.log(`readiness manifest integrity ${m.integrity}`);
    return;
  }
  if (cmd !== "evaluate") throw new Error("usage: release-gate.ts manifest | evaluate --ci <file> ...");
  const manifest = readJson<ReadinessManifest>(path.join(REL, "readiness-manifest.json"));
  const ciFile = arg("--ci");
  const ciResults = ciFile ? readJson<Record<string, string>>(ciFile) : {};
  const optional = <T>(flag: string): T | undefined => {
    const f = arg(flag);
    return f && existsSync(f) ? readJson<T>(f) : undefined;
  };
  const approvals = (name: string) => (existsSync(path.join(REL, name)) ? readJson<{ evidence: SignedEvidence[] }>(path.join(REL, name)).evidence : []);
  const registry = readJson<{ operatorKeys: `0x${string}`[]; externalApproverKeys: `0x${string}`[] }>(path.join(REL, "approver-registry.json"));
  const r = await evaluateGate({
    manifest,
    ciResults,
    flags: currentFlags(),
    findings: readJson<{ findings: never[] }>(path.join(REL, "security-findings.json")).findings,
    reconciliation: optional("--reconciliation") ?? { status: "NOT_RUN" },
    deployManifest: optional("--deploy"),
    signerRoles: optional("--signers"),
    operatorEvidence: approvals("operator-evidence.json"),
    externalApprovals: approvals("external-approvals.json"),
    operatorKeys: registry.operatorKeys,
    externalApproverKeys: registry.externalApproverKeys,
  });
  const out = arg("--out");
  if (out) writeFileSync(out, JSON.stringify(r, null, 2) + "\n");
  console.log(`READINESS_STATES=${r.states.join(",")}`);
  console.log(`PRODUCTION_READY=${String(r.productionReady)}`);
  for (const i of r.items) console.log(`${i.class} ${i.id.padEnd(30)} ${i.status.padEnd(18)} ${i.detail}`);
  for (const b of r.blockers) console.log(`::error::${b}`);
  process.exit(r.engineering === "PASS" ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
