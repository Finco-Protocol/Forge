/**
 * W08 independent financial oracle. Expectations use input economics, not
 * buildLedger's allocation, leg-attribution or reconciliation helpers.
 */
import { describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";
import { buildLedger, NATIVE, verifiedEligibleRevenue, type LedgerEvent } from "@/server/finance/ledger";

const addr = (n: number) => getAddress("0x" + n.toString(16).padStart(40, "0")) as Address;
const factory = addr(240), escrow = addr(229), splitter = addr(91), hook = addr(822), vault = addr(167);
const alice = addr(1001), bob = addr(1002), stranger = addr(1003);
const ctx = { factory, escrow, splitter, hook, vault };
const launches = [
  { token: addr(1101), curve: addr(2101), creator: alice, fee: 100n, tax: 40n },
  { token: addr(1102), curve: addr(2102), creator: bob, fee: 200n, tax: 50n },
  { token: addr(1103), curve: addr(2103), creator: alice, fee: 330n, tax: 60n },
];

function independentOracle() {
  let protocol = 0n;
  const creators = new Map<Address, bigint>();
  const rows = launches.map((x) => {
    const p = (3n * x.fee) / 10n;
    const creatorBase = x.fee - p;
    const creatorTotal = creatorBase + x.tax;
    creators.set(x.creator, (creators.get(x.creator) ?? 0n) + creatorTotal);
    protocol += p;
    return { ...x, protocol: p, creatorBase, creatorTotal };
  });
  return { rows, protocol, creators, treasury: protocol - protocol / 3n, reserve: protocol / 3n };
}

function events(withClaims = true): LedgerEvent[] {
  const oracle = independentOracle();
  const out: LedgerEvent[] = [];
  let index = 0;
  const emit = (block: number, tx: number, address: Address, eventName: string, args: Record<string, string>) => {
    out.push({
      blockNumber: BigInt(block),
      blockHash: "0x" + block.toString(16).padStart(64, "0"),
      txHash: "0x" + tx.toString(16).padStart(64, "0"),
      logIndex: index++, address, eventName, args,
      blockTimestamp: BigInt(1000 + block),
    });
  };
  oracle.rows.forEach((x, i) => {
    emit(1, 100 + i, factory, "TokenLaunched", {
      token: x.token, curve: x.curve, deployer: x.creator, pairToken: NATIVE,
      launchConfigId: "0", graduationThreshold: "30",
    });
    emit(2, 200 + i, x.curve, "CurveBuy", {
      buyer: stranger, recipient: stranger, quoteIn: "10000",
      tokensOut: "1", fee: x.fee.toString(), tax: x.tax.toString(),
    });
    emit(3, 300 + i, escrow, "Credited", {
      recipient: splitter, depositor: x.curve, amount: x.protocol.toString(),
    });
    emit(3, 300 + i, escrow, "Credited", {
      recipient: x.creator, depositor: x.curve, amount: x.creatorTotal.toString(),
    });
    emit(3, 300 + i, x.curve, "FeesSwept", {
      protocolAmount: x.protocol.toString(), creatorAmount: x.creatorTotal.toString(),
      buybackAmount: "0",
    });
  });
  emit(4, 400, escrow, "Credited", { recipient: splitter, depositor: stranger, amount: "9" });
  emit(5, 500, splitter, "EligibleRevenueAuthorized", {
    asset: NATIVE, cumulativeEligible: oracle.protocol.toString(), nonce: "1",
    evidenceBlock: "4", evidenceBlockHash: "0x" + "4".padStart(64, "0"),
    attestor: addr(177),
  });
  if (withClaims) {
    emit(6, 600, escrow, "Claimed", { recipient: splitter, amount: oracle.protocol.toString() });
    emit(6, 600, splitter, "RevenueAllocated", {
      allocationId: "1", asset: NATIVE, escrowClaimed: oracle.protocol.toString(),
      received: oracle.protocol.toString(), toTreasury: oracle.treasury.toString(),
      toReserve: oracle.reserve.toString(), policyVersion: "1",
    });
    [...oracle.creators].forEach(([creator, amount], i) =>
      emit(7, 700 + i, escrow, "Claimed", { recipient: creator, amount: amount.toString() }),
    );
  }
  return out;
}

describe("W08 independent oracle across 3 launches and 2 creators", () => {
  it("proves each base/tax attribution and the aggregate split against independent amounts", () => {
    const oracle = independentOracle(), l = buildLedger(events(), ctx);
    expect(l.tokens.size).toBe(3);
    for (const x of oracle.rows) {
      const t = l.tokens.get(x.token)!;
      expect(t.creator).toBe(x.creator);
      expect(t.curveBaseFees).toBe(x.fee);
      expect(t.curveCreatorTax).toBe(x.tax);
      expect(t.protocolCredited).toBe(x.protocol);
      expect(t.creatorCredited).toBe(x.creatorTotal);
      expect(t.creatorBaseCredited).toBe(x.creatorBase);
      expect(t.creatorTaxCredited).toBe(x.tax);
      const source = l.credits.filter((c) => c.depositor === x.curve);
      expect(source.map((c) => c.amount)).toEqual([x.protocol, x.creatorTotal]);
      expect(source.map((c) => c.cls)).toEqual(["PROTOCOL_BASE_FEE", "CREATOR_FEE"]);
    }
    const s = l.splitterTotals.get(NATIVE)!;
    expect(s.eligibleCeiling).toBe(oracle.protocol);
    expect(s.escrowClaimed).toBe(oracle.protocol);
    expect(s.revenueReceived).toBe(oracle.protocol);
    expect(s.treasuryAllocated).toBe(oracle.treasury);
    expect(s.reserveAllocated).toBe(oracle.reserve);
    expect(verifiedEligibleRevenue(l, splitter, new Set(launches.map((x) => x.token)), null).get(NATIVE)).toBe(oracle.protocol);
    expect(l.escrowBalances.get(splitter + ":" + NATIVE)).toBe(9n);
    for (const creator of oracle.creators.keys()) expect(l.escrowBalances.get(creator + ":" + NATIVE)).toBe(0n);
    expect(l.credits.find((c) => c.depositor === stranger)?.cls).toBe("UNATTRIBUTED_CREDIT");
    expect(l.exceptions.some((e) => e.kind === "THIRD_PARTY_CREDIT_TO_SPLITTER")).toBe(true);
  });

  it("models reorg before allocation: no claims, revenue remains escrowed", () => {
    const oracle = independentOracle(), l = buildLedger(events(false), ctx);
    expect(l.allocations).toHaveLength(0);
    expect(l.splitterTotals.get(NATIVE)!.eligibleCeiling).toBe(oracle.protocol);
    expect(l.escrowBalances.get(splitter + ":" + NATIVE)).toBe(oracle.protocol + 9n);
    for (const [creator, amount] of oracle.creators) expect(l.escrowBalances.get(creator + ":" + NATIVE)).toBe(amount);
  });

  it("shuffled duplicate events do not manufacture credited or claimed funds", () => {
    const e = events(), baseline = buildLedger(e, ctx);
    const repeated = buildLedger([...e].reverse().concat(e), ctx);
    expect(repeated.credits).toEqual(baseline.credits);
    expect(repeated.claims).toEqual(baseline.claims);
    expect(repeated.tokens).toEqual(baseline.tokens);
    expect(repeated.allocations).toEqual(baseline.allocations);
    expect(repeated.splitterTotals).toEqual(baseline.splitterTotals);
  });
});
