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
 * This is a source inventory. It is NOT an audit, an approval or a claim of
 * production readiness (PRODUCTION_BLOCKED=true).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export const BASELINE_COMMIT = "f4fa5e8a02f77958a0552ccaa411f3f1b39b5c1f";

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
}

export interface Manifest {
  schema: 1;
  baselineCommit: string;
  hashAlgorithm: "sha256";
  lineCountDefinition: string;
  generator: string;
  roots: readonly string[];
  excludedRoots: Array<{ path: string; reason: string; trackedSolFiles: number }>;
  summary: { totalFiles: number; totalLines: number; byClass: Record<string, { files: number; lines: number }> };
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
  const tracked = listTracked(AUDIT_ROOTS);
  const hashes = new Map<string, string>();
  const files: ManifestFile[] = tracked.map((p) => {
    const buf = readFileSync(path.join(ROOT, p));
    const sha256 = createHash("sha256").update(buf).digest("hex");
    hashes.set(p, sha256);
    const c = classify(p);
    const f: ManifestFile = { path: p, sha256, lines: countLines(buf), class: c.class, basis: c.basis, spdx: spdxOf(buf.toString("utf8")) };
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
    schema: 1,
    baselineCommit: BASELINE_COMMIT,
    hashAlgorithm: "sha256",
    lineCountDefinition: "count of LF-terminated lines, plus one when the file does not end with LF; 0 for an empty file",
    generator: "scripts/w06/audit-manifest.ts",
    roots: AUDIT_ROOTS,
    excludedRoots,
    summary: { totalFiles: files.length, totalLines, byClass: sortedByClass },
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
  }
  for (const p of a.keys()) if (!b.has(p)) out.push(`REMOVED ${p}`);
  if (committed.baselineCommit !== fresh.baselineCommit) out.push(`baselineCommit ${committed.baselineCommit} -> ${fresh.baselineCommit}`);
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
