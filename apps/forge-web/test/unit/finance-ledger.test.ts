import { describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";
import { buildLedger, derivedTreasuryReserve, NATIVE, type LedgerEvent } from "@/server/finance/ledger";

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
    // splitter pulls 35 (fees + stranger credit are indistinguishable on chain)
    ev(5, ESCROW, "Claimed", { recipient: SPLITTER, amount: "35" }),
    ev(5, SPLITTER, "RevenueAllocated", { allocationId: "1", asset: NATIVE, received: "35", toTreasury: "24", toReserve: "11", policyVersion: "1" }),
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
    expect(l.escrowBalances.get(`${SPLITTER}:${NATIVE}`)).toBe(0n);
    expect(l.escrowBalances.get(`${CREATOR}:${NATIVE}`)).toBe(0n);
    expect(l.splitterTotals.get(NATIVE)!.revenueReceived).toBe(35n);
  });

  it("a reorg is just fewer canonical events: dropping a block removes its effects (23)", () => {
    const l = buildLedger(scenario().filter((e) => e.blockNumber !== 5n), ctx);
    expect(l.allocations.length).toBe(0);
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
