/**
 * W06 audit source manifest: determinism, classification rules, drift
 * against the committed docs/audit/source-manifest.json, and the schema-2
 * commit-to-source binding (baseline bytes are read from BASELINE_COMMIT, so
 * tampered historical sources cannot pass by regenerating the manifest).
 * The manifest is a source inventory, not an audit or an approval.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  AUDIT_ROOTS,
  BASELINE_COMMIT,
  MANIFEST_RELATIVE_PATH,
  byteCompare,
  classify,
  countLines,
  diffManifests,
  generateManifest,
  renderManifest,
  spdxOf,
  type Manifest,
} from "../../../../scripts/w06/audit-manifest";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const gitAvailable = (() => {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: REPO_ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const committed = (): Manifest => JSON.parse(readFileSync(path.join(REPO_ROOT, MANIFEST_RELATIVE_PATH), "utf8")) as Manifest;

describe("audit manifest helpers", () => {
  it("counts lines with and without a trailing newline", () => {
    expect(countLines(Buffer.from(""))).toBe(0);
    expect(countLines(Buffer.from("a\n"))).toBe(1);
    expect(countLines(Buffer.from("a\nb"))).toBe(2);
    expect(countLines(Buffer.from("a\n\nb\n"))).toBe(3);
  });

  it("extracts the first SPDX identifier", () => {
    expect(spdxOf("// SPDX-License-Identifier: MIT\npragma solidity ^0.8.30;")).toBe("MIT");
    expect(spdxOf("// SPDX-License-Identifier: BUSL-1.1\n")).toBe("BUSL-1.1");
    expect(spdxOf("/* SPDX-License-Identifier: GPL-2.0-or-later */")).toBe("GPL-2.0-or-later");
    expect(spdxOf("contract A {}")).toBe("NONE");
  });

  it("classifies by provenance rules", () => {
    expect(classify("contractsV2-forge/src/v2/forge/ForgeProtocolRevenueSplitter.sol").class).toBe("forge-owned");
    expect(classify("contractsV2-forge/src/v2/PonsV2LaunchFactory.sol").class).toBe("pons-vendored-modified");
    expect(classify("contractsV2-forge/src/v2/PonsV2BondingCurve.sol").class).toBe("pons-vendored");
    expect(classify("contractsV2-forge/src/v2/hooks/PonsV2MemeHook.sol").class).toBe("pons-vendored");
    expect(classify("contractsV2-deployed/src/v2/PonsV2FeeEscrow.sol").class).toBe("pons-vendored");
    expect(classify("contractsV2-deployed/lib/v4-core/src/libraries/Pool.sol").class).toBe("third-party-vendored");
    expect(classify("test-forge/W05OwnerPowers.t.sol").class).toBe("test");
    expect(classify("test-forge/mocks/MiniPoolManager.sol").class).toBe("mock");
    expect(classify("test/mocks/MockERC20.sol").class).toBe("mock");
    expect(classify("script/DeployForgeW02.s.sol").class).toBe("script");
    expect(() => classify("contractsV1/src/PonsLaunchFactory.sol")).toThrow(/no classification rule/);
  });

  it("detects added, changed and removed files when diffing", () => {
    const base = committed();
    const fresh: Manifest = JSON.parse(JSON.stringify(base));
    fresh.files = fresh.files.filter((f) => f.path !== fresh.files[0]!.path);
    fresh.files[0]!.sha256 = "0".repeat(64);
    fresh.files.push({ ...base.files[0]!, path: "test/ZZZ.t.sol" });
    const d = diffManifests(base, fresh);
    expect(d.some((x) => x.startsWith("REMOVED"))).toBe(true);
    expect(d.some((x) => x.startsWith("CHANGED"))).toBe(true);
    expect(d.some((x) => x.startsWith("ADDED"))).toBe(true);
  });
});

describe("committed audit manifest", () => {
  it("is sorted by path, unique, well-formed and carries no timestamps", () => {
    const m = committed();
    expect(m.schema).toBe(2);
    expect(m.baselineCommit).toBe(BASELINE_COMMIT);
    expect(m.baselineCommit).toMatch(/^[0-9a-f]{40}$/);
    const paths = m.files.map((f) => f.path);
    expect([...paths].sort(byteCompare)).toEqual(paths);
    expect(new Set(paths).size).toBe(paths.length);
    for (const f of m.files) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.lines).toBeGreaterThan(0);
      expect(f.path.endsWith(".sol")).toBe(true);
      expect(AUDIT_ROOTS.some((r) => f.path.startsWith(`${r}/`))).toBe(true);
      expect(f.baseline, `${f.path} must carry a baseline binding`).toBeTruthy();
      expect(["identical", "added", "modified"]).toContain(f.baseline.status);
      if (f.baseline.status === "identical" || f.baseline.status === "modified") expect(f.baseline.sha256).toMatch(/^[0-9a-f]{64}$/);
      else expect(f.baseline.sha256).toBeUndefined();
    }
    const raw = JSON.stringify(m);
    expect(raw).not.toMatch(/generatedAt|timestamp|"date"/i);
    expect(m.summary.totalFiles).toBe(m.files.length);
    expect(m.summary.totalLines).toBe(m.files.reduce((n, f) => n + f.lines, 0));
    for (const s of Object.values(m.summary.byBaseline)) {
      expect(s.files).toBeGreaterThanOrEqual(0);
    }
    expect(Object.values(m.summary.byBaseline).reduce((n, s) => n + s.files, 0)).toBe(m.summary.totalFiles);
    expect(Object.values(m.summary.byBaseline).reduce((n, s) => n + s.lines, 0)).toBe(m.summary.totalLines);
  });

  it("keeps the PONS-vs-Forge boundary exactly as the modification register states", () => {
    const m = committed();
    const forgeSrc = m.files.filter((f) => f.path.startsWith("contractsV2-forge/src/"));
    const owned = forgeSrc.filter((f) => f.class === "forge-owned").map((f) => f.path.split("/").pop());
    expect(owned.sort()).toEqual([
      "ForgeBindingRegistry.sol",
      "ForgeLaunchAuthorizer.sol",
      "ForgeProtocolRevenueSplitter.sol",
      "IFincoBurnReserveExecutor.sol",
      "IForgeLaunchAuthorizer.sol",
    ]);
    // Exactly one PONS file differs from the deploy-time tree: the factory (M-ELIG).
    const differing = forgeSrc.filter((f) => f.deployedCounterpart === "differs").map((f) => f.path);
    expect(differing).toEqual(["contractsV2-forge/src/v2/PonsV2LaunchFactory.sol"]);
    for (const f of forgeSrc.filter((x) => x.class === "pons-vendored")) expect(f.deployedCounterpart).toBe("identical");
  });

  it("flags the two BUSL-1.1 files and nothing else as non-MIT", () => {
    const m = committed();
    const nonMit = m.files.filter((f) => f.spdx !== "MIT").map((f) => f.path).sort();
    expect(nonMit).toEqual([
      "contractsV2-deployed/lib/v4-core/src/libraries/Pool.sol",
      "contractsV2-deployed/lib/v4-core/src/libraries/Position.sol",
    ]);
    for (const f of m.files.filter((x) => x.spdx !== "MIT")) expect(f.spdx).toBe("BUSL-1.1");
  });

  it("never lists the excluded generations", () => {
    const m = committed();
    expect(m.files.some((f) => f.path.startsWith("contractsV1/") || f.path.startsWith("contractsV2/"))).toBe(false);
    expect(m.excludedRoots.map((e) => e.path)).toEqual(["contractsV1", "contractsV2"]);
  });
});

describe.skipIf(!gitAvailable)("manifest regeneration", () => {
  it("is deterministic: two generations are byte-identical", () => {
    expect(renderManifest(generateManifest())).toBe(renderManifest(generateManifest()));
  });

  it("matches the committed file (fails on drift; regenerate with `tsx scripts/w06/audit-manifest.ts`)", () => {
    const fresh = generateManifest();
    const text = readFileSync(path.join(REPO_ROOT, MANIFEST_RELATIVE_PATH), "utf8");
    expect(diffManifests(JSON.parse(text) as Manifest, fresh)).toEqual([]);
    expect(renderManifest(fresh)).toBe(text);
  });
});

describe.skipIf(!gitAvailable)("baseline binding (schema 2): the manifest proves its bytes come from BASELINE_COMMIT", () => {
  // Independent reproduction of the binding: hash the baseline blob straight from git.
  const gitShowSha = (p: string) =>
    createHash("sha256")
      .update(execFileSync("git", ["show", `${BASELINE_COMMIT}:${p}`], { cwd: REPO_ROOT, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }))
      .digest("hex");

  it("binds identical files to the baseline bytes read from git, not the index or a prior manifest", () => {
    const m = generateManifest();
    const identical = m.files.filter((f) => f.baseline.status === "identical");
    expect(identical.length).toBeGreaterThan(100); // the whole PONS/lib/test inventory predates the baseline
    for (const f of [identical[0]!, m.files.find((f) => f.path === "contractsV2-forge/src/v2/forge/ForgeProtocolRevenueSplitter.sol")!, m.files.find((f) => f.path === "test/mocks/MockERC20.sol")!]) {
      expect(f.baseline.status).toBe("identical");
      expect(f.baseline.sha256).toBe(f.sha256);
      expect(f.baseline.sha256).toBe(gitShowSha(f.path)); // independent: `git show <commit>:<path>` | sha256
    }
  });

  it("records post-baseline files as explicitly documented additions, and only those", () => {
    const m = generateManifest();
    const added = m.files.filter((f) => f.baseline.status === "added");
    expect(added.map((f) => f.path)).toEqual(["test-forge/W06FinancialAcceptance.t.sol"]); // the W06 financial acceptance test
    expect(m.summary.byBaseline.added.files).toBe(1);
    expect(m.summary.byBaseline.identical.files).toBe(m.summary.totalFiles - 1);
    expect(m.summary.byBaseline.modified.files).toBe(0); // no in-scope source has deliberately changed since the baseline
  });

  it("FAILS THE GATE when a baseline file's bytes are tampered with (deliberate source mutation)", () => {
    const target = "test/mocks/MockERC20.sol";
    const original = readFileSync(path.join(REPO_ROOT, target));
    const tampered = Buffer.concat([original, Buffer.from("\n// TAMPER: deliberate source mutation for the audit-manifest regression test\n")]);
    try {
      writeFileSync(path.join(REPO_ROOT, target), tampered);
      expect(() => generateManifest()).toThrow(/differs from the recorded baseline/);
      expect(() => generateManifest()).toThrow(/BASELINE_MODIFICATIONS_ALLOWED/);
    } finally {
      writeFileSync(path.join(REPO_ROOT, target), original); // restore before anything else runs
    }
    // the restored tree regenerates cleanly again
    expect(() => generateManifest()).not.toThrow();
  });

  it("flags a committed manifest that still associates old baseline bytes with modified source (no silent regeneration)", () => {
    const fresh = generateManifest();
    const stale = JSON.parse(JSON.stringify(fresh)) as Manifest;
    const victim = stale.files.find((f) => f.baseline.status === "identical")!;
    // The tamper scenario: current bytes changed, but the committed manifest still claims the old sha pair.
    victim.sha256 = "0".repeat(64);
    victim.lines += 1;
    const d = diffManifests(stale, fresh);
    expect(d.some((x) => x.startsWith(`CHANGED ${victim.path}`))).toBe(true);
    // ...and if only the recorded baseline hash were hand-edited, that drift surfaces too.
    const stale2 = JSON.parse(JSON.stringify(fresh)) as Manifest;
    stale2.files[0]!.baseline = { status: "identical", sha256: "1".repeat(64) };
    expect(diffManifests(stale2, fresh).some((x) => x.startsWith(`BASELINE ${stale2.files[0]!.path}`))).toBe(true);
  });
});

describe("drift reporting", () => {
  it("reports excluded-root drift as a real difference instead of a formatting-only one", () => {
    const base = committed();
    const fresh: Manifest = JSON.parse(JSON.stringify(base));
    fresh.excludedRoots[0]!.trackedSolFiles += 1; // a tracked .sol added under contractsV1/
    const d = diffManifests(base, fresh);
    expect(d.some((x) => x.startsWith(`EXCLUDED_ROOT ${fresh.excludedRoots[0]!.path} trackedSolFiles`))).toBe(true);
  });

  it("reports excluded-root reason changes, additions and audit-root changes", () => {
    const base = committed();
    const withReason: Manifest = JSON.parse(JSON.stringify(base));
    withReason.excludedRoots[1]!.reason = "changed reason";
    expect(diffManifests(base, withReason).some((x) => x.startsWith("EXCLUDED_ROOT contractsV2 reason"))).toBe(true);
    const withNew: Manifest = JSON.parse(JSON.stringify(base));
    withNew.excludedRoots.push({ path: "contractsV3", reason: "x", trackedSolFiles: 0 });
    expect(diffManifests(base, withNew).some((x) => x === "EXCLUDED_ROOT contractsV3 added")).toBe(true);
    const withRoots: Manifest = JSON.parse(JSON.stringify(base));
    withRoots.roots = [...withRoots.roots, "extra"];
    expect(diffManifests(base, withRoots).some((x) => x.startsWith("ROOTS "))).toBe(true);
  });
});
