/**
 * W05 authority-matrix drift gate: every state-changing function of every
 * Forge-owned contract (compiled ABI, out/forge) must be classified in
 * config/authority-matrix.json, with no stale rows, and every monitoring
 * event it names must exist on that contract.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { formatAbiItem } from "viem/utils";
import type { AbiFunction, AbiEvent } from "viem";
import { FORGE_OUT } from "../../scripts/artifacts";
import matrix from "../../config/authority-matrix.json";
import { renderAuthorityMatrix } from "../../scripts/w05/authority-matrix-md";

const ACCESS = new Set([
  "owner",
  "pending-owner",
  "anyone",
  "anyone-after-timelock",
  "self",
  "authorized-creator",
  "launch-forwarder",
  "creator-fee-recipient",
  "creator-or-owner-disable",
  "forge-factory",
  "pool-manager",
  "operator-or-creator",
  "authority-signature",
  "authority-or-owner",
  "attestor-signature",
  "treasury-recipient",
  "authorized-locker",
  "vest-beneficiary",
]);

function abiOf(name: string) {
  return JSON.parse(readFileSync(path.join(FORGE_OUT, `${name}.sol`, `${name}.json`), "utf8")).abi as Array<AbiFunction | AbiEvent | { type: string }>;
}

describe("W05 contract authority matrix", () => {
  const contracts = Object.entries(matrix.contracts);

  it("covers the whole Forge-owned stack", () => {
    expect(contracts.map(([c]) => c).sort()).toEqual(
      [
        "ForgeBindingRegistry",
        "ForgeLaunchAuthorizer",
        "ForgeProtocolRevenueSplitter",
        "PonsV2BuybackVault",
        "PonsV2FeeEscrow",
        "PonsV2GraduationExecutor",
        "PonsV2LaunchDeployer",
        "PonsV2LaunchFactory",
        "PonsV2LaunchLocker",
        "PonsV2MemeHook",
      ].sort(),
    );
  });

  for (const [name, entry] of contracts) {
    it(`${name}: every state-changing ABI function is classified exactly once, and nothing stale`, () => {
      const abi = abiOf(name);
      const fns = abi.filter((x): x is AbiFunction => x.type === "function" && (x as AbiFunction).stateMutability !== "view" && (x as AbiFunction).stateMutability !== "pure");
      const live = fns.map((f) => formatAbiItem(f)).sort();
      const listed = entry.functions.map((f) => f.signature).sort();
      expect(new Set(listed).size, "duplicate rows").toBe(listed.length);
      expect(listed.filter((s) => !live.includes(s)), "stale or mistyped rows").toEqual([]);
      expect(live.filter((s) => !listed.includes(s)), "UNCLASSIFIED privileged surface").toEqual([]);
    });

    it(`${name}: access classes are known and named monitoring events exist`, () => {
      const events = new Set(abiOf(name).filter((x): x is AbiEvent => x.type === "event").map((e) => e.name));
      for (const f of entry.functions) {
        expect(ACCESS.has(f.access), `${f.signature}: unknown access ${f.access}`).toBe(true);
        for (const ev of f.monitoringEvents) expect(events.has(ev), `${name}.${ev} (for ${f.signature})`).toBe(true);
      }
    });
  }

  it("every emergency control is owner-held and flagged for incident runbooks", () => {
    const emergency = contracts.flatMap(([c, e]) => e.functions.filter((f) => f.emergency).map((f) => `${c}.${f.signature.split("(")[0]}:${f.access}`));
    expect(emergency.sort()).toEqual(
      [
        "ForgeBindingRegistry.invalidatePendingOps:authority-or-owner",
        "ForgeBindingRegistry.setEligibilityAuthority:owner",
        "ForgeLaunchAuthorizer.setEligibilityAuthority:owner",
        "ForgeProtocolRevenueSplitter.revokeRevenueAttestor:owner",
        "ForgeProtocolRevenueSplitter.setPullsPaused:owner",
        "PonsV2LaunchFactory.forceSweptGraduation:owner",
        "PonsV2LaunchFactory.rescueCurveFees:owner",
        "PonsV2LaunchFactory.rescueSweptGraduation:owner",
        "PonsV2LaunchFactory.setLaunchEnabled:owner",
        "PonsV2MemeHook.rescuePoolFees:owner",
      ].sort(),
    );
  });

  it("renounceOwnership is exposed only where the W05 review recorded it", () => {
    const renounce = contracts.filter(([, e]) => e.functions.some((f) => f.signature === "renounceOwnership()")).map(([c]) => c);
    expect(renounce.sort()).toEqual(["ForgeBindingRegistry", "ForgeLaunchAuthorizer"]);
  });

  it("docs/W05-AUTHORITY-MATRIX.md is exactly the rendering of the JSON (no hand edits, no drift)", () => {
    const md = readFileSync(path.resolve(FORGE_OUT, "..", "..", "docs", "W05-AUTHORITY-MATRIX.md"), "utf8");
    expect(md).toBe(renderAuthorityMatrix(matrix as never) + "\n");
  });
});
