/**
 * Collects exact-head check-run results from the GitHub API for the W05
 * release gate (Class A evidence = real CI outcomes on the commit under
 * review) and derives the gate's other engineering inputs from them.
 *
 *   GITHUB_TOKEN=… REPO=owner/name SHA=<head sha> DEPLOY_VERIFY_OK=1 tsx scripts/w05/collect-ci.ts --out dir
 *
 * It polls until every job named in release/readiness-manifest.json (except
 * the gate itself) has COMPLETED, or the deadline passes (then missing jobs
 * are reported as missing → the gate fails). Same-named checks from several
 * workflows must ALL succeed.
 *
 * Derived inputs (documented, not independently measured here):
 *   reconciliation  RECONCILED only if the jobs that assert ledger reconciliation on real contracts succeeded
 *   signers         role separation holds only if the integration suite (signer-custody, startup role checks) succeeded
 *   deploy          verified = the offline manifest verified in this very job; hook/V4 flags = the genuine-V4 jobs succeeded
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const SELF = "w05: release-readiness gate (ENGINEERING_PASS only; never production-ready)";
const ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");

async function checkRuns(repo: string, sha: string, token: string) {
  const all: Array<{ name: string; status: string; conclusion: string | null }> = [];
  for (let page = 1; page <= 5; page++) {
    const r = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    });
    if (!r.ok) throw new Error(`check-runs ${r.status}`);
    const j = (await r.json()) as { total_count: number; check_runs: typeof all };
    all.push(...j.check_runs);
    if (all.length >= j.total_count) break;
  }
  return all;
}

async function main() {
  const repo = need("REPO"), sha = need("SHA"), token = need("GITHUB_TOKEN");
  const out = arg("out") ?? "/tmp/gate";
  mkdirSync(out, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(ROOT, "release", "readiness-manifest.json"), "utf8")) as { items: Array<{ class: string; ciJobs?: string[] }> };
  const required = [...new Set(manifest.items.flatMap((i) => i.ciJobs ?? []))].filter((n) => n !== SELF);
  const deadline = Date.now() + 40 * 60_000;
  let runs = await checkRuns(repo, sha, token);
  const pending = () => required.filter((n) => { const m = runs.filter((r) => r.name === n); return m.length === 0 || m.some((r) => r.status !== "completed"); });
  while (pending().length && Date.now() < deadline) {
    console.log(`waiting for: ${pending().join(" | ")}`);
    await new Promise((r) => setTimeout(r, 30_000));
    runs = await checkRuns(repo, sha, token);
  }
  const ci: Record<string, string> = {};
  for (const n of required) {
    const m = runs.filter((r) => r.name === n);
    if (m.length === 0) continue; // missing → the gate reports it
    ci[n] = m.every((r) => r.status === "completed" && r.conclusion === "success") ? "success" : m.find((r) => r.conclusion !== "success")?.conclusion ?? "in_progress";
  }
  const ok = (n: string) => ci[n] === "success";
  const v4 = ok("w05: genuine Uniswap V4 integration (local)");
  writeFileSync(path.join(out, "ci-results.json"), JSON.stringify(ci, null, 2));
  writeFileSync(
    path.join(out, "reconciliation.json"),
    JSON.stringify(
      ok("w05: PostgreSQL production-mode suite") && ok("w03: API/security integration + acceptance (Anvil, real W02 contracts)") && v4
        ? { status: "RECONCILED", detail: "derived: integration, PostgreSQL and genuine-V4 suites (all assert RECONCILED ledgers) succeeded" }
        : { status: "NOT_RUN", detail: "a suite asserting reconciliation did not succeed" },
    ),
  );
  writeFileSync(path.join(out, "signers.json"), JSON.stringify(ok("w03: API/security integration + acceptance (Anvil, real W02 contracts)") ? { separated: true } : { separated: false, detail: "integration suite (signer role separation) did not succeed" }));
  writeFileSync(
    path.join(out, "deploy.json"),
    JSON.stringify({
      verified: process.env.DEPLOY_VERIFY_OK === "1",
      hookAddressSourceProven: v4,
      v4WiringSupported: v4 && ok("w03: Robinhood Chain 4663 V4 wiring (read-only RPC)") && ok("w05: Robinhood 4663 fork simulation (no broadcast)"),
      detail: v4 ? undefined : "genuine V4 / hook-mining suite did not succeed",
    }),
  );
  console.log(JSON.stringify(ci, null, 2));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
