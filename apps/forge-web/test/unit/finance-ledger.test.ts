import { describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";
import { buildLedger, derivedTreasuryReserve, verifiedEligibleRevenue, NATIVE, type LedgerEvent } from "@/server/finance/ledger";
import { provenanceStatus } from "@/server/finance/service";
import { verifyClaimContents, CLAIM_SELECTORS } from "@/server/finance/claims";
import { eligibleRevenueDigest } from "@/server/finance/attestor";
import { encodeFunctionData } from "viem";
import { forgeProtocolRevenueSplitterAbi, ponsV2FeeEscrowAbi } from "@/shared/abis.generated";
import type { AppContext } from "@/server/context";

const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`) as Address;
const FACTORY = A(0xf0);
const HOOK = A(0x2044);
const ESCROW = A(0xe5);
const VAULT = A(0xa7);
const SPLITTER = A(0x5b);
const TOKEN = A(0x70);
const CURVE = A(0xc0);
const CREATOR = A(0xc1);
const STRANGER = A(0xbad);
const ctx = { factory: FACTORY, hook: HOOK, escrow: ESCROW, vault: VAULT, splitter: SPLITTER };

let li = 0;
const ev = (block: number, address: Address, eventName: string, args: Record<string, string>, tx = `0x${block.toString(16).padStart(64, "0")}`): LedgerEvent => ({
  blockNumber: BigInt(block),
  blockHash: `0xb${block.toString(16).padStart(63, "0")}`,
  txHash: tx,
  logIndex: li++,
  address,
  eventName,
  args,
  blockTimestamp: BigInt(1_000 + block),
});

function scenario(): LedgerEvent[] {
  li = 0;
  return [
    ev(1, FACTORY, "TokenLaunched", { token: TOKEN, curve: CURVE, deployer: CREATOR, pairToken: NATIVE, launchConfigId: "0", graduationThreshold: "30" }),
    ev(2, CURVE, "CurveBuy", { buyer: STRANGER, recipient: STRANGER, quoteIn: "10000", tokensOut: "1", fee: "100", tax: "100" }),
    // sweep tx: curve credits protocol, then creator, then emits FeesSwept
    ev(3, ESCROW, "Credited", { recipient: SPLITTER, depositor: CURVE, amount: "30" }),
    ev(3, ESCROW, "Credited", { recipient: CREATOR, depositor: CURVE, amount: "170" }),
    ev(3, CURVE, "FeesSwept", { protocolAmount: "30", buybackAmount: "0", creatorAmount: "170" }),
    // a stranger credits the splitter's escrow key
    ev(4, ESCROW, "Credited", { recipient: SPLITTER, depositor: STRANGER, amount: "5" }),
    // the attestor raises the ceiling to the VERIFIED 30 only; the pull is bounded by it
    ev(5, SPLITTER, "EligibleRevenueAuthorized", { asset: NATIVE, cumulativeEligible: "30", nonce: "1", evidenceBlock: "4", evidenceBlockHash: `0xb${"4".padStart(63, "0")}`, attestor: A(0xa77) }),
    ev(5, ESCROW, "Claimed", { recipient: SPLITTER, amount: "30" }),
    ev(5, SPLITTER, "RevenueAllocated", { allocationId: "1", asset: NATIVE, escrowClaimed: "30", received: "30", toTreasury: "20", toReserve: "10", policyVersion: "1" }),
    ev(6, ESCROW, "Claimed", { recipient: CREATOR, amount: "170" }),
  ];
}

describe("W04 financial ledger (pure projection)", () => {
  it("attributes legs by sweep order and splits creator tax exactly", () => {
    const l = buildLedger(scenario(), ctx);
    const t = l.tokens.get(TOKEN)!;
    expect(t.curveBaseFees).toBe(100n);
    expect(t.curveCreatorTax).toBe(100n);
    expect(t.protocolCredited).toBe(30n);
    expect(t.creatorCredited).toBe(170n);
    expect(t.creatorBaseCredited).toBe(70n);
    expect(t.creatorTaxCredited).toBe(100n);
    const protocolRow = l.credits.find((c) => c.recipient === SPLITTER && c.depositor === CURVE)!;
    expect(protocolRow.cls).toBe("PROTOCOL_BASE_FEE");
  });

  it("never attributes a third-party escrow credit to a launch (27)", () => {
    const l = buildLedger(scenario(), ctx);
    const row = l.credits.find((c) => c.depositor === STRANGER)!;
    expect(row.cls).toBe("UNATTRIBUTED_CREDIT");
    expect(row.token).toBeNull();
    expect(l.exceptions.some((e) => e.kind === "THIRD_PARTY_CREDIT_TO_SPLITTER" && e.amount === "5")).toBe(true);
  });

  it("is identical under duplicate delivery and arbitrary input order (22)", () => {
    const base = buildLedger(scenario(), ctx);
    const shuffled = [...scenario()].reverse();
    const doubled = [...scenario(), ...scenario()];
    for (const input of [shuffled, doubled]) {
      const l = buildLedger(input, ctx);
      expect(l.credits).toEqual(base.credits);
      expect(l.claims).toEqual(base.claims);
      expect([...l.tokens.entries()]).toEqual([...base.tokens.entries()]);
      expect([...l.splitterTotals.entries()]).toEqual([...base.splitterTotals.entries()]);
      expect([...l.escrowBalances.entries()]).toEqual([...base.escrowBalances.entries()]);
    }
  });

  it("indexed escrow balances are credits minus claims (no double credit) (21)", () => {
    const l = buildLedger(scenario(), ctx);
    // The third-party 5 stays in the escrow under the splitter key; only the verified 30 was pulled.
    expect(l.escrowBalances.get(`${SPLITTER}:${NATIVE}`)).toBe(5n);
    expect(l.escrowBalances.get(`${CREATOR}:${NATIVE}`)).toBe(0n);
    expect(l.splitterTotals.get(NATIVE)!.revenueReceived).toBe(30n);
    expect(l.splitterTotals.get(NATIVE)!.escrowClaimed).toBe(30n);
    expect(l.splitterTotals.get(NATIVE)!.eligibleCeiling).toBe(30n);
  });

  it("a reorg is just fewer canonical events: dropping a block removes its effects (23)", () => {
    const l = buildLedger(scenario().filter((e) => e.blockNumber !== 5n), ctx);
    expect(l.allocations.length).toBe(0);
    expect(l.authorizations.length).toBe(0);
    expect(l.splitterTotals.get(NATIVE)?.eligibleCeiling ?? 0n).toBe(0n);
    expect(l.escrowBalances.get(`${SPLITTER}:${NATIVE}`)).toBe(35n);
  });

  it("an unmatched source credit is flagged, never guessed", () => {
    li = 0;
    const events = [
      ev(1, FACTORY, "TokenLaunched", { token: TOKEN, curve: CURVE, deployer: CREATOR, pairToken: NATIVE, launchConfigId: "0", graduationThreshold: "30" }),
      ev(2, ESCROW, "Credited", { recipient: SPLITTER, depositor: CURVE, amount: "7" }),
    ];
    const l = buildLedger(events, ctx);
    expect(l.credits[0]!.cls).toBe("UNATTRIBUTED_CREDIT");
    expect(l.exceptions.some((e) => e.kind === "UNMATCHED_SOURCE_CREDIT")).toBe(true);
  });

  it("derived 2:1 split conserves exactly and the reserve never exceeds a third (7)", () => {
    for (const p of [0n, 1n, 2n, 3n, 10n, 999_999_999_999_999_999n, 2n ** 128n + 1n]) {
      const d = derivedTreasuryReserve(p);
      expect(d.treasury + d.reserve).toBe(p);
      expect(d.reserve * 3n).toBeLessThanOrEqual(p);
    }
  });
});

describe("W04 Correction A: provenance (pure)", () => {
  const fakeCtx = (attestor: boolean) => ({ revenueAttestor: attestor ? {} : null }) as unknown as AppContext;

  it("verified eligible revenue counts only eligible-launch protocol legs from Forge sources, up to the evidence block", () => {
    const l = buildLedger(scenario(), ctx);
    expect(verifiedEligibleRevenue(l, SPLITTER, new Set([TOKEN]), null).get(NATIVE)).toBe(30n);
    expect(verifiedEligibleRevenue(l, SPLITTER, new Set(), null).get(NATIVE)).toBeUndefined(); // ineligible launch
    expect(verifiedEligibleRevenue(l, SPLITTER, new Set([TOKEN]), 2n).get(NATIVE)).toBeUndefined(); // before the sweep
  });

  it("provenance status: PROVEN_ELIGIBLE, PROVENANCE_BLOCKED, RECONCILIATION_MISMATCH", () => {
    expect(provenanceStatus(fakeCtx(true), 30n, { ceiling: 30n, escrowClaimed: 30n, revenue: 30n }, 30n).status).toBe("PROVEN_ELIGIBLE");
    expect(provenanceStatus(fakeCtx(true), 40n, { ceiling: 30n, escrowClaimed: 30n, revenue: 30n }, 30n).status).toBe("PROVENANCE_BLOCKED");
    expect(provenanceStatus(fakeCtx(false), 40n, { ceiling: 30n, escrowClaimed: 0n, revenue: 0n }, 30n).reason).toMatch(/fail closed/);
    expect(provenanceStatus(fakeCtx(true), 30n, { ceiling: 35n, escrowClaimed: 30n, revenue: 30n }, 35n).status).toBe("RECONCILIATION_MISMATCH");
    expect(provenanceStatus(fakeCtx(true), 30n, { ceiling: 30n, escrowClaimed: 30n, revenue: 31n }, 30n).status).toBe("RECONCILIATION_MISMATCH");
    expect(provenanceStatus(fakeCtx(true), 30n, { ceiling: 30n, escrowClaimed: 30n, revenue: 30n }, 20n).status).toBe("RECONCILIATION_MISMATCH");
  });

  it("EIP-712 EligibleRevenue digest binds chain and splitter", () => {
    const auth = { escrow: ESCROW, factory: FACTORY, asset: NATIVE, cumulativeEligible: 30n, nonce: 1n, deadline: 99n, evidenceBlock: 4n, evidenceBlockHash: `0x${"11".repeat(32)}` as const };
    const d = eligibleRevenueDigest(31337, SPLITTER, auth);
    expect(eligibleRevenueDigest(31338, SPLITTER, auth)).not.toBe(d);
    expect(eligibleRevenueDigest(31337, A(0x5c), auth)).not.toBe(d);
    expect(eligibleRevenueDigest(31337, SPLITTER, { ...auth, nonce: 2n })).not.toBe(d);
  });

  it("claim contents: exact selectors, decoded asset and amount, canonical target and sender", () => {
    expect(Object.values(CLAIM_SELECTORS.escrow).sort()).toEqual(["claim()", "claim(uint256)", "claimToken(address)", "claimToken(address,uint256)"]);
    const base = { chainId: 31337, wallet: CREATOR, kind: "escrow" as const, asset: NATIVE, target: ESCROW, nominal: null };
    const tx = (input: `0x${string}`, over: Record<string, unknown> = {}) => ({ chainId: 31337, from: CREATOR, to: ESCROW, input, value: 0n, ...over });
    const claimAll = encodeFunctionData({ abi: ponsV2FeeEscrowAbi, functionName: "claim", args: [] });
    expect(verifyClaimContents(tx(claimAll), base)).toMatchObject({ ok: true, nominal: 0n, signature: "claim()" });
    expect(verifyClaimContents(tx(claimAll, { chainId: 1 }), base)).toMatchObject({ ok: false, code: "WRONG_CHAIN" });
    expect(verifyClaimContents(tx(claimAll, { from: STRANGER }), base)).toMatchObject({ ok: false, code: "NOT_YOUR_TRANSACTION" });
    expect(verifyClaimContents(tx(claimAll, { to: SPLITTER }), base)).toMatchObject({ ok: false, code: "WRONG_RECIPIENT_CONTRACT" });
    expect(verifyClaimContents(tx(claimAll, { value: 1n }), base)).toMatchObject({ ok: false, code: "UNEXPECTED_VALUE" });
    const tokenPart = encodeFunctionData({ abi: ponsV2FeeEscrowAbi, functionName: "claimToken", args: [TOKEN, 5n] });
    expect(verifyClaimContents(tx(tokenPart), base)).toMatchObject({ ok: false, code: "WRONG_ASSET" });
    expect(verifyClaimContents(tx(tokenPart), { ...base, asset: TOKEN, nominal: 6n })).toMatchObject({ ok: false, code: "WRONG_AMOUNT" });
    expect(verifyClaimContents(tx(tokenPart), { ...base, asset: TOKEN, nominal: 5n })).toMatchObject({ ok: true, signature: "claimToken(address,uint256)" });
    const credit = encodeFunctionData({ abi: ponsV2FeeEscrowAbi, functionName: "credit", args: [CREATOR] });
    expect(verifyClaimContents(tx(credit), base)).toMatchObject({ ok: false, code: "WRONG_SELECTOR" });
    // A treasury claim is only valid against the splitter and only as claimTreasury.
    const tr = encodeFunctionData({ abi: forgeProtocolRevenueSplitterAbi, functionName: "claimTreasury", args: [NATIVE, 0n] });
    expect(verifyClaimContents(tx(tr, { to: SPLITTER }), { ...base, kind: "treasury", target: SPLITTER })).toMatchObject({ ok: true, nominal: 0n });
    expect(verifyClaimContents(tx(claimAll, { to: SPLITTER }), { ...base, kind: "treasury", target: SPLITTER })).toMatchObject({ ok: false, code: "WRONG_SELECTOR" });
  });
});
