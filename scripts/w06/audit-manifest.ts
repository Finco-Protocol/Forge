/**
 * W06 audit source manifest (deterministic).
 *
 *   tsx scripts/w06/audit-manifest.ts            write docs/audit/source-manifest.json
 *   tsx scripts/w06/audit-manifest.ts --check    regenerate in memory; exit 1 on any drift
 *
 * The manifest lists every git-tracked Solidity file under the audit roots
 * with its sha256 (raw bytes) and line count, classified from the repository's
 * own provenance records (docs/MODIFICATION-REGISTER.md, provenance/,
 * FORK_PROVENANCE.md). It is sorted by path (byte order), contains no
 * timestamps, and depends only on tracked file content, so two runs on the
 * same tree are byte-identical. Node built-ins only (plus `git` on PATH).
 *
 * Schema 2 binds every entry to the recorded BASELINE_COMMIT: for each file the
 * manifest stores the sha256 of the bytes AT THAT COMMIT and whether the file
 * (a) is byte-identical to it, (b) was added after it, or (c) deliberately
 * differs from it (only allowed for entries in BASELINE_MODIFICATIONS_ALLOWED,
 * each with a documented reason). Generation and --check read the baseline
 * bytes from git (`git show <commit>:<path>`), never from the index or a
 * previous manifest, so a modified historical source can never ship as a green
 * gate merely by regenerating the manifest.
 *
 * This is a source inventory. It is NOT an audit, an approval or a claim of
 * production readiness (PRODUCTION_BLOCKED=true).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export const BASELINE_COMMIT = "f4fa5e8a02f77958a0552ccaa411f3f1b39b5c1f";

/**
 * Baseline files whose current bytes DELIBERATELY differ from BASELINE_COMMIT.
 * Empty today: no in-scope Solidity source has changed since the baseline.
 * Any entry must carry a documented reason and can only be added after review;
 * a modification that is not listed here fails generation and --check.
 */
export const BASELINE_MODIFICATIONS_ALLOWED: readonly { path: string; reason: string }[] = [
  {
    path: "contractsV2-forge/src/v2/forge/ForgeLaunchAuthorizer.sol",
    reason:
      "W07 D12 reconciliation: natspec-only correction of the false 'permanently revokes' claim on setEligibilityAuthority(0) — zero is owner-reversible (no latch), as the tests and docs already stated. Comments generate no bytecode or ABI change (runtime size and ABI verified unchanged); the claim itself was the defect.",
  },
  {
    path: "test-forge/ForgeLaunchAuth.t.sol",
    reason:
      "W07 D12: adds test_W07_zero_authority_is_owner_reversible_and_registry_refuses_zero, the explicit regression that the zero kill switch is owner-reversible and that the registry refuses zero (test-only; no contract change).",
  },
];

/**
 * Baseline files deliberately REMOVED from the tree after BASELINE_COMMIT.
 * Empty today: every baseline file is still tracked. A staged deletion would
 * otherwise silently shrink the manifest; any entry needs a documented,
 * reviewed reason.
 */
export const BASELINE_REMOVALS_ALLOWED: readonly { path: string; reason: string }[] = [];

/** Baseline paths that are no longer tracked (pure; unit-tested). */
export function baselineRemovals(baseline: Iterable<string>, tracked: Iterable<string>): string[] {
  const t = new Set(tracked);
  return [...baseline].filter((p) => !t.has(p)).sort(byteCompare);
}

/** Audit roots (tracked *.sol under these are listed). */
export const AUDIT_ROOTS = [
  "contractsV2-forge/src",
  "contractsV2-deployed/src",
  "contractsV2-deployed/lib",
  "test-forge",
  "test",
  "script",
] as const;

/** Trees deliberately outside the manifest; counted so the exclusion is visible. */
export const EXCLUDED_ROOTS = [
  {
    path: "contractsV1",
    reason: "V1 generation: legacy PONS engine, not the Forge candidate and not on the forge build path (profile `v1` only).",
  },
  {
    path: "contractsV2",
    reason:
      "Upstream PONS V2 git HEAD: does not compile as a whole (finding F-01, canary profile `default`), superseded by the recovered deploy-time tree; its lib/ trees back profiles `default`/`testable`, not `forge`. forge-std (submodule, test-only) lives here and is not tracked content.",
  },
] as const;

export const MANIFEST_RELATIVE_PATH = "docs/audit/source-manifest.json";

export type FileClass = "forge-owned" | "pons-vendored" | "pons-vendored-modified" | "third-party-vendored" | "test" | "mock" | "script";

/** How the file's current bytes relate to BASELINE_COMMIT. */
export type BaselineStatus = "identical" | "added" | "modified";

export interface BaselineBinding {
  status: BaselineStatus;
  /** sha256 of the file's bytes at BASELINE_COMMIT (absent for additions: no baseline blob exists). */
  sha256?: string;
}

export interface ManifestFile {
  path: string;
  sha256: string;
  lines: number;
  class: FileClass;
  /** Why the file got its class (derived from path + provenance docs). */
  basis: string;
  /** First SPDX-License-Identifier in the file ("NONE" if absent). */
  spdx: string;
  /** For contractsV2-forge/src files that exist in contractsV2-deployed/src: byte comparison. */
  deployedCounterpart?: "identical" | "differs";
  /** Binding of this entry to BASELINE_COMMIT (schema 2). */
  baseline: BaselineBinding;
}

export interface Manifest {
  schema: 2;
  baselineCommit: string;
  hashAlgorithm: "sha256";
  lineCountDefinition: string;
  baselineDefinition: string;
  generator: string;
  roots: readonly string[];
  excludedRoots: Array<{ path: string; reason: string; trackedSolFiles: number }>;
  summary: {
    totalFiles: number;
    totalLines: number;
    byClass: Record<string, { files: number; lines: number }>;
    byBaseline: Record<BaselineStatus, { files: number; lines: number }>;
  };
  files: ManifestFile[];
}

// Works both as a tsx entry point (CommonJS, because the repo root has no package.json
// "type") and when imported by vitest (ESM): `__dirname` exists in the first case,
// `import.meta.dirname` in the second.
const HERE: string = typeof __dirname !== "undefined" ? __dirname : import.meta.dirname;
const ROOT = path.resolve(HERE, "..", "..");

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function gitBytes(args: string[]): Buffer {
  return execFileSync("git", args, { cwd: ROOT, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }) as Buffer;
}

function assertBaselineCommitExists(): void {
  const have = (): boolean => {
    try {
      execFileSync("git", ["cat-file", "-e", `${BASELINE_COMMIT}^{commit}`], { cwd: ROOT, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  if (have()) return;
  // Shallow CI/local checkouts do not contain the baseline commit. Fetch exactly the
  // pinned commit (content-addressed: the SHA is the binding, so this cannot weaken
  // the gate) with its full tree, then verify it is the recorded commit.
  console.error(`audit-manifest: ${BASELINE_COMMIT} not present (shallow checkout?); fetching the pinned baseline commit`);
  try {
    execFileSync("git", ["fetch", "--no-tags", "--depth", "1", "origin", BASELINE_COMMIT], { cwd: ROOT, stdio: "ignore" });
  } catch (e) {
    throw new Error(`audit-manifest: BASELINE_COMMIT ${BASELINE_COMMIT} is not reachable and fetching it failed (${(e as Error).message.split("\n")[0]}); the manifest cannot bind sources to it from this checkout.`);
  }
  if (!have()) {
    throw new Error(`audit-manifest: BASELINE_COMMIT ${BASELINE_COMMIT} could not be fetched into this repository; the manifest cannot bind sources to it.`);
  }
}

/** Tracked .sol paths under `roots` AT the baseline commit (the commit's tree, not the index). */
export function listBaselineSolFiles(commit: string, roots: readonly string[]): Set<string> {
  const out = execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", commit, "--", ...roots], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return new Set(out.split("\0").filter((p) => p.endsWith(".sol")));
}

const baselineShaCache = new Map<string, string>();

/** sha256 of a path's raw bytes AT the baseline commit (read from git, never from the working tree). */
export function baselineSha256(commit: string, p: string): string {
  const key = `${commit}:${p}`;
  let v = baselineShaCache.get(key);
  if (v === undefined) {
    v = createHash("sha256").update(gitBytes(["show", `${commit}:${p}`])).digest("hex");
    baselineShaCache.set(key, v);
  }
  return v;
}

function listTracked(roots: readonly string[]): string[] {
  const out = git(["ls-files", "-z", "--", ...roots.map((r) => `${r}`)]);
  return out
    .split("\0")
    .filter((p) => p.endsWith(".sol"))
    .sort(byteCompare);
}

export function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Number of lines = number of "\n"-separated segments, ignoring one trailing newline. 0 for an empty file. */
export function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let n = 0;
  for (const b of buf) if (b === 0x0a) n++;
  return buf[buf.length - 1] === 0x0a ? n : n + 1;
}

export function spdxOf(text: string): string {
  const m = /SPDX-License-Identifier:\s*([^\r\n]*)/.exec(text);
  if (!m) return "NONE";
  return (m[1] ?? "").replace(/\*\/\s*$/, "").trim() || "NONE";
}

/** Class + basis from the path alone (pure; unit-tested). */
export function classify(p: string): { class: FileClass; basis: string } {
  if (p.startsWith("contractsV2-forge/src/v2/forge/")) {
    return { class: "forge-owned", basis: "Forge-authored additive contracts (docs/MODIFICATION-REGISTER.md section 3 and 8)" };
  }
  if (p === "contractsV2-forge/src/v2/PonsV2LaunchFactory.sol") {
    return { class: "pons-vendored-modified", basis: "Deploy-time PONS factory plus the M-ELIG change (docs/MODIFICATION-REGISTER.md section 2 and 7); only PONS file that differs from contractsV2-deployed" };
  }
  if (p.startsWith("contractsV2-forge/src/")) {
    return { class: "pons-vendored", basis: "Byte-identical to the Sourcify-recovered deploy-time PONS source in contractsV2-deployed/src when deployedCounterpart is `identical` (docs/MODIFICATION-REGISTER.md section 1)" };
  }
  if (p.startsWith("contractsV2-deployed/src/")) {
    return { class: "pons-vendored", basis: "Deploy-time PONS V2 source recovered from Sourcify; runtime parity evidence in provenance/ (docs/W02-SOURCE-RECOVERY.md)" };
  }
  if (p.startsWith("contractsV2-deployed/lib/")) {
    return { class: "third-party-vendored", basis: "Vendored OpenZeppelin / Uniswap v4 / Permit2 dependency tree compiled by profile `forge` (provenance/forge-additions.txt, provenance/tree-integrity-gate.sh)" };
  }
  if (p.startsWith("test-forge/mocks/") || p.startsWith("test/mocks/")) {
    return { class: "mock", basis: "Test-only mock; never part of a deployable stack" };
  }
  if (p.startsWith("test-forge/") || p.startsWith("test/")) {
    return { class: "test", basis: "Foundry test or harness (profiles `forge` / `testable`)" };
  }
  if (p.startsWith("script/")) {
    return { class: "script", basis: "Local/test deployment script; never pointed at chain 4663" };
  }
  throw new Error(`audit-manifest: no classification rule for ${p}`);
}

export function generateManifest(): Manifest {
  assertBaselineCommitExists();
  const tracked = listTracked(AUDIT_ROOTS);
  const baselineFiles = listBaselineSolFiles(BASELINE_COMMIT, AUDIT_ROOTS);
  // A baseline file that is no longer tracked must not silently shrink the manifest.
  const allowedRemovals = new Map(BASELINE_REMOVALS_ALLOWED.map((r) => [r.path, r.reason]));
  for (const p of baselineRemovals(baselineFiles, tracked)) {
    if (!allowedRemovals.has(p)) {
      throw new Error(
        `audit-manifest: ${p} exists at the recorded baseline ${BASELINE_COMMIT} but is no longer tracked in this tree. ` +
          `Either restore the file, or — only after review — record the removal in BASELINE_REMOVALS_ALLOWED ` +
          `(scripts/w06/audit-manifest.ts) with a reason and update the provenance claims.`,
      );
    }
  }
  const allowedModifications = new Map(BASELINE_MODIFICATIONS_ALLOWED.map((m) => [m.path, m.reason]));
  const hashes = new Map<string, string>();
  const byBaseline: Record<BaselineStatus, { files: number; lines: number }> = { identical: { files: 0, lines: 0 }, added: { files: 0, lines: 0 }, modified: { files: 0, lines: 0 } };
  const files: ManifestFile[] = tracked.map((p) => {
    const buf = readFileSync(path.join(ROOT, p));
    const sha256 = createHash("sha256").update(buf).digest("hex");
    hashes.set(p, sha256);
    // Commit-to-source binding: read the baseline bytes from the stated commit.
    let baseline: BaselineBinding;
    if (!baselineFiles.has(p)) {
      baseline = { status: "added" };
    } else {
      const baselineHash = baselineSha256(BASELINE_COMMIT, p);
      if (baselineHash === sha256) baseline = { status: "identical", sha256: baselineHash };
      else {
        const reason = allowedModifications.get(p);
        if (!reason) {
          throw new Error(
            `audit-manifest: ${p} differs from the recorded baseline ${BASELINE_COMMIT} ` +
              `(baseline sha256 ${baselineHash}, current sha256 ${sha256}). The manifest binds its ` +
              `bytes to that commit, so a changed historical source cannot pass this gate. Either restore ` +
              `the baseline bytes, or — only after review — record the change in BASELINE_MODIFICATIONS_ALLOWED ` +
              `(scripts/w06/audit-manifest.ts) with a reason and update the provenance claims.`,
          );
        }
        baseline = { status: "modified", sha256: baselineHash };
      }
    }
    byBaseline[baseline.status].files++;
    byBaseline[baseline.status].lines += countLines(buf);
    const c = classify(p);
    const f: ManifestFile = { path: p, sha256, lines: countLines(buf), class: c.class, basis: c.basis, spdx: spdxOf(buf.toString("utf8")), baseline };
    return f;
  });
  for (const f of files) {
    if (f.path.startsWith("contractsV2-forge/src/") && !f.path.startsWith("contractsV2-forge/src/v2/forge/")) {
      const counterpart = f.path.replace("contractsV2-forge/src/", "contractsV2-deployed/src/");
      const other = hashes.get(counterpart);
      if (other !== undefined) f.deployedCounterpart = other === f.sha256 ? "identical" : "differs";
    }
  }
  const byClass: Record<string, { files: number; lines: number }> = {};
  let totalLines = 0;
  for (const f of files) {
    const s = (byClass[f.class] ??= { files: 0, lines: 0 });
    s.files++;
    s.lines += f.lines;
    totalLines += f.lines;
  }
  const sortedByClass: Record<string, { files: number; lines: number }> = {};
  for (const k of Object.keys(byClass).sort(byteCompare)) sortedByClass[k] = byClass[k] as { files: number; lines: number };
  const excludedRoots = EXCLUDED_ROOTS.map((e) => ({ path: e.path, reason: e.reason, trackedSolFiles: listTracked([e.path]).length }));
  return {
    schema: 2,
    baselineCommit: BASELINE_COMMIT,
    hashAlgorithm: "sha256",
    lineCountDefinition: "count of LF-terminated lines, plus one when the file does not end with LF; 0 for an empty file",
    baselineDefinition:
      "per file: sha256 of the raw bytes at baselineCommit read from git (`git show baselineCommit:path`); " +
      "`identical` when equal to the current tracked bytes, `added` when the file does not exist at the commit, " +
      "`modified` only for entries listed in BASELINE_MODIFICATIONS_ALLOWED with a documented reason",
    generator: "scripts/w06/audit-manifest.ts",
    roots: AUDIT_ROOTS,
    excludedRoots,
    summary: { totalFiles: files.length, totalLines, byClass: sortedByClass, byBaseline },
    files,
  };
}

export function renderManifest(m: Manifest): string {
  return `${JSON.stringify(m, null, 2)}\n`;
}

/** Human-readable differences between two manifests (first few). */
export function diffManifests(committed: Manifest, fresh: Manifest): string[] {
  const out: string[] = [];
  const a = new Map(committed.files.map((f) => [f.path, f]));
  const b = new Map(fresh.files.map((f) => [f.path, f]));
  for (const [p, f] of b) {
    const old = a.get(p);
    if (!old) out.push(`ADDED   ${p}`);
    else if (old.sha256 !== f.sha256) out.push(`CHANGED ${p} (sha256 ${old.sha256.slice(0, 12)} -> ${f.sha256.slice(0, 12)})`);
    else if (old.class !== f.class || old.lines !== f.lines || old.spdx !== f.spdx || old.deployedCounterpart !== f.deployedCounterpart) out.push(`METADATA ${p}`);
    else if (JSON.stringify(old.baseline) !== JSON.stringify(f.baseline)) out.push(`BASELINE ${p} (${JSON.stringify(old.baseline)} -> ${JSON.stringify(f.baseline)})`);
  }
  for (const p of a.keys()) if (!b.has(p)) out.push(`REMOVED ${p}`);
  if (committed.baselineCommit !== fresh.baselineCommit) out.push(`baselineCommit ${committed.baselineCommit} -> ${fresh.baselineCommit}`);
  // Excluded-root and root drift must surface as real differences: a tracked
  // Solidity file added under an excluded root changes only trackedSolFiles
  // here, and the "formatting-only" fallback below must never hide it.
  if (JSON.stringify(committed.roots) !== JSON.stringify(fresh.roots)) out.push(`ROOTS ${JSON.stringify(committed.roots)} -> ${JSON.stringify(fresh.roots)}`);
  const freshExcluded = new Map(fresh.excludedRoots.map((e) => [e.path, e]));
  for (const e of committed.excludedRoots) {
    const now = freshExcluded.get(e.path);
    if (!now) out.push(`EXCLUDED_ROOT ${e.path} removed`);
    else if (now.trackedSolFiles !== e.trackedSolFiles) out.push(`EXCLUDED_ROOT ${e.path} trackedSolFiles ${e.trackedSolFiles} -> ${now.trackedSolFiles}`);
    else if (now.reason !== e.reason) out.push(`EXCLUDED_ROOT ${e.path} reason changed`);
  }
  for (const e of fresh.excludedRoots) if (!committed.excludedRoots.some((x) => x.path === e.path)) out.push(`EXCLUDED_ROOT ${e.path} added`);
  return out;
}

function main(argv: string[]): number {
  const check = argv.includes("--check");
  const target = path.join(ROOT, MANIFEST_RELATIVE_PATH);
  const fresh = generateManifest();
  const text = renderManifest(fresh);
  if (check) {
    if (!existsSync(target)) {
      console.error(`AUDIT_MANIFEST_DRIFT: ${MANIFEST_RELATIVE_PATH} does not exist; run: tsx scripts/w06/audit-manifest.ts`);
      return 1;
    }
    const committedText = readFileSync(target, "utf8");
    if (committedText === text) {
      console.log(`AUDIT_MANIFEST_OK files=${fresh.summary.totalFiles} lines=${fresh.summary.totalLines}`);
      return 0;
    }
    let diffs: string[] = [];
    try {
      diffs = diffManifests(JSON.parse(committedText) as Manifest, fresh);
    } catch {
      diffs = ["committed manifest is not valid JSON"];
    }
    console.error("AUDIT_MANIFEST_DRIFT: committed manifest differs from the tracked sources.");
    for (const d of (diffs.length ? diffs : ["(formatting-only difference)"]).slice(0, 25)) console.error(`  ${d}`);
    console.error("Regenerate with: tsx scripts/w06/audit-manifest.ts");
    return 1;
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
  console.log(`wrote ${MANIFEST_RELATIVE_PATH}: files=${fresh.summary.totalFiles} lines=${fresh.summary.totalLines}`);
  return 0;
}

if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
