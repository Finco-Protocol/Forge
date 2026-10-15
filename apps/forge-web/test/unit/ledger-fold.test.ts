/**
 * W05 equivalence properties: the resumable fold (with snapshot cut points,
 * serialization round trips, duplicate / reordered / re-delivered events and
 * reorg truncations) deep-equals the W04 reference buildLedger(all events).
 */
import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { buildLedger, NATIVE, type Ledger, type LedgerEvent } from "@/server/finance/ledger";
import {
  applyEvents,
  cloneFoldState,
  createFoldState,
  decodeFoldState,
  encodeFoldState,
  finalizeFold,
  foldAll,
  ledgerDigest,
  NonIncrementalHistoryError,
  type LedgerFoldState,
} from "@/server/finance/ledger-fold";
import { generateHistory, mulberry32, shuffled, SYN, SYN_CONTEXT } from "../../scripts/w05/synthetic-history";

const SEEDS = Array.from({ length: 30 }, (_, i) => 1000 + i * 7919);

function blocksOf(events: LedgerEvent[]): number[] {
  return [...new Set(events.map((e) => Number(e.blockNumber)))].sort((a, b) => a - b);
}

/** Random block-boundary cut points. */
function cuts(lastBlock: number, n: number, rnd: () => number): number[] {
  const out = new Set<number>();
  for (let i = 0; i < n; i++) out.add(1 + Math.floor(rnd() * lastBlock));
  out.add(lastBlock);
  return [...out].sort((a, b) => a - b);
}

/**
 * Incremental fold over `events`, cut at the given blocks; each batch is
 * delivered duplicated, shuffled, plus re-delivered events from earlier
 * batches; the state goes through a serialization round trip at each cut
 * (= a persisted snapshot). Returns the snapshots taken at each cut.
 */
function incremental(events: LedgerEvent[], cutBlocks: number[], seed: number, start?: { state: LedgerFoldState }): { state: LedgerFoldState; snapshots: Map<number, string> } {
  const rnd = mulberry32(seed);
  let state = start ? start.state : createFoldState();
  const snapshots = new Map<number, string>();
  let prev = state.cursor === null ? 0 : Number(state.cursor);
  const delivered: LedgerEvent[] = [];
  for (const cut of cutBlocks) {
    if (cut <= prev) continue;
    const batch = events.filter((e) => Number(e.blockNumber) > prev && Number(e.blockNumber) <= cut);
    const dupes = batch.filter(() => rnd() < 0.2);
    const redelivered = delivered.filter(() => rnd() < 0.05);
    applyEvents(state, shuffled([...batch, ...dupes, ...redelivered], seed + cut), SYN_CONTEXT, BigInt(cut));
    delivered.push(...batch);
    const text = encodeFoldState(state);
    snapshots.set(cut, text);
    state = decodeFoldState(text);
    prev = cut;
  }
  return { state, snapshots };
}

function expectSame(actual: Ledger, reference: Ledger) {
  expect(ledgerDigest(actual)).toBe(ledgerDigest(reference));
  expect(actual).toEqual(reference);
}

describe("W05 resumable ledger fold ≡ buildLedger (reference)", () => {
  it("single-batch fold equals buildLedger on randomized histories", () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const h = generateHistory({ seed, targetEvents: 600 });
      expectSame(finalizeFold(foldAll(h.events, h.ctx)), buildLedger(h.events, h.ctx));
    }
  });

  it("incremental fold with random snapshot cut points, duplicates, reordering and re-delivery equals buildLedger(all)", () => {
    for (const seed of SEEDS) {
      const h = generateHistory({ seed, targetEvents: 400 + (seed % 900) });
      const rnd = mulberry32(seed);
      const reference = buildLedger(h.events, h.ctx);
      const { state } = incremental(h.events, cuts(h.lastBlock, 2 + Math.floor(rnd() * 25), rnd), seed);
      expectSame(finalizeFold(state), reference);
      expect(state.eventCount).toBe(new Set(h.events.map((e) => `${e.blockHash}:${e.logIndex}`)).size);
    }
  });

  it("every block boundary as a cut point (finest granularity)", () => {
    const h = generateHistory({ seed: 77, targetEvents: 500 });
    const { state } = incremental(h.events, blocksOf(h.events), 77);
    expectSame(finalizeFold(state), buildLedger(h.events, h.ctx));
  });

  it("buildLedger itself is invariant under duplicate delivery and arbitrary order (reference sanity)", () => {
    const h = generateHistory({ seed: 5, targetEvents: 800 });
    const ref = buildLedger(h.events, h.ctx);
    expectSame(buildLedger(shuffled([...h.events, ...h.events.slice(0, 200)], 9), h.ctx), ref);
  });

  it("reorg truncation: restore the newest snapshot at or below the fork block, apply the new branch → buildLedger(new branch)", () => {
    for (const seed of SEEDS.slice(0, 15)) {
      const a = generateHistory({ seed, targetEvents: 900 });
      const forkBlock = Math.max(2, Math.floor(a.lastBlock * (0.3 + (seed % 5) / 10)));
      const b = generateHistory({ seed, targetEvents: 900, fork: { block: forkBlock, salt: `reorg-${seed}` } });
      // Identical through the fork block, different after.
      expect(b.events.filter((e) => Number(e.blockNumber) <= forkBlock)).toEqual(a.events.filter((e) => Number(e.blockNumber) <= forkBlock));
      expect(b.blockHashes.get(forkBlock + 1)).not.toBe(a.blockHashes.get(forkBlock + 1));
      const rnd = mulberry32(seed);
      const { snapshots } = incremental(a.events, cuts(a.lastBlock, 12, rnd), seed);
      // Reorg-aware rollback: snapshots above the fork are discarded.
      const usable = [...snapshots.keys()].filter((k) => k <= forkBlock);
      const base = usable.length ? decodeFoldState(snapshots.get(Math.max(...usable))!) : createFoldState();
      const { state } = incremental(b.events, cuts(b.lastBlock, 8, rnd), seed + 1, { state: base });
      expectSame(finalizeFold(state), buildLedger(b.events, b.ctx));
      // And the stale branch-A snapshot above the fork would NOT be equivalent (the guard is necessary).
      const stale = [...snapshots.keys()].filter((k) => k > forkBlock);
      if (stale.length && a.events.some((e) => Number(e.blockNumber) > forkBlock && Number(e.blockNumber) <= Math.min(...stale))) {
        const wrong = decodeFoldState(snapshots.get(Math.min(...stale))!);
        applyEvents(wrong, b.events, b.ctx, BigInt(b.lastBlock));
        expect(ledgerDigest(finalizeFold(wrong))).not.toBe(ledgerDigest(buildLedger(b.events, b.ctx)));
      }
    }
  });

  it("serialization is lossless and stable (bigints, Map/Set insertion order)", () => {
    const h = generateHistory({ seed: 3, targetEvents: 700 });
    const s = foldAll(h.events, h.ctx);
    const text = encodeFoldState(s);
    expect(encodeFoldState(decodeFoldState(text))).toBe(text);
    expect(cloneFoldState(s)).toEqual(s);
    const tokens = [...decodeFoldState(text).ledger.tokens.keys()];
    expect(tokens).toEqual([...s.ledger.tokens.keys()]);
  });

  it("refuses a history whose earlier batch referenced a curve/pool announced later (falls back to one batch = buildLedger)", () => {
    const h = generateHistory({ seed: 11, targetEvents: 300 });
    const launch = h.events.find((e) => e.eventName === "TokenLaunched" && e.blockNumber > 1n) ?? h.events.find((e) => e.eventName === "TokenLaunched")!;
    const curve = launch.args.curve as Address;
    // A (synthetic, not chain-possible) curve event BEFORE its launch block.
    const early: LedgerEvent = { ...launch, blockNumber: 0n, blockHash: "0xearly", txHash: "0xearlytx", logIndex: 0, address: curve, eventName: "CurveBuy", args: { fee: "5", tax: "1" } };
    const events = [early, ...h.events];
    const s = createFoldState();
    applyEvents(s, [early], SYN_CONTEXT, 0n);
    expect(() => applyEvents(s, h.events, SYN_CONTEXT, BigInt(h.lastBlock))).toThrow(NonIncrementalHistoryError);
    expectSame(finalizeFold(foldAll(events, SYN_CONTEXT)), buildLedger(events, SYN_CONTEXT));
  });

  it("asset and project isolation: no cross-asset or cross-launch contamination", () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const h = generateHistory({ seed, targetEvents: 1500 });
      const { state } = incremental(h.events, cuts(h.lastBlock, 10, mulberry32(seed)), seed);
      const l = finalizeFold(state);
      const raw = buildLedger(h.events, h.ctx);
      expectSame(l, raw);
      // Escrow balance per (recipient, asset) = raw Σ credits − Σ claims of THAT asset only.
      const expectBal = new Map<string, bigint>();
      for (const e of h.events) {
        if (e.address !== SYN.escrow) continue;
        const asset = e.eventName === "Credited" || e.eventName === "Claimed" ? NATIVE : (e.args.token as Address);
        const sign = e.eventName.startsWith("Credited") ? 1n : -1n;
        const k = `${e.args.recipient}:${asset}`;
        expectBal.set(k, (expectBal.get(k) ?? 0n) + sign * BigInt(e.args.amount!));
      }
      expect(l.escrowBalances).toEqual(expectBal);
      for (const t of l.tokens.values()) {
        // Curve fees only from this launch's own curve.
        const fees = h.events.filter((e) => e.address === t.curve && (e.eventName === "CurveBuy" || e.eventName === "CurveSell")).reduce((a, e) => a + BigInt(e.args.fee!), 0n);
        expect(t.curveBaseFees).toBe(fees);
      }
      for (const c of l.credits) {
        if (c.token === null || c.source === "vault") continue;
        const t = l.tokens.get(c.token)!;
        expect(c.asset).toBe(t.pairToken); // fee credits are in the launch's own quote asset
        if (c.source === "curve") expect(c.depositor).toBe(t.curve);
        if (c.source === "hook") {
          const sweep = h.events.find((e) => e.txHash === c.txHash && e.eventName === "PoolFeesSwept");
          expect(String(sweep!.args.poolId).toLowerCase()).toBe(t.poolId);
        }
      }
      // Splitter totals per asset = raw allocations of that asset.
      for (const [asset, st] of l.splitterTotals) {
        const recv = h.events.filter((e) => e.eventName === "RevenueAllocated" && e.args.asset === asset).reduce((a, e) => a + BigInt(e.args.received!), 0n);
        expect(st.revenueReceived).toBe(recv);
      }
    }
  });

  it("no duplicate fee recognition: each escrow credit is recognised at most once, under duplicate delivery too", () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const h = generateHistory({ seed, targetEvents: 1200 });
      const doubled = [...h.events, ...shuffled(h.events, seed)];
      const { state } = incremental(doubled.sort((a, b) => Number(a.blockNumber - b.blockNumber)), cuts(h.lastBlock, 9, mulberry32(seed)), seed);
      const l = finalizeFold(state);
      const ids = l.credits.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBe(h.events.filter((e) => e.address === SYN.escrow && e.eventName.startsWith("Credited")).length);
      const recognised = l.credits.filter((c) => c.cls === "PROTOCOL_BASE_FEE" || c.cls === "CREATOR_FEE");
      for (const c of recognised) expect(c.token).not.toBeNull();
      const perToken = [...l.tokens.values()].reduce((a, t) => a + t.protocolCredited + t.creatorCredited, 0n);
      expect(perToken).toBe(recognised.reduce((a, c) => a + c.amount, 0n));
      // Base + tax + unsplit = creator credited, per launch.
      for (const t of l.tokens.values()) expect(t.creatorBaseCredited + t.creatorTaxCredited + t.creatorUnsplitCredited).toBe(t.creatorCredited);
      // Third-party credits are never attributed.
      for (const c of l.credits.filter((x) => x.source === "third_party")) expect(c.token).toBeNull();
      expectSame(l, buildLedger(h.events, h.ctx));
    }
  });

  it("the generator exercises every template (coverage of the property inputs)", () => {
    const h = generateHistory({ seed: 42, targetEvents: 3000 });
    const names = new Set(h.events.map((e) => e.eventName));
    for (const n of ["TokenLaunched", "CurveBuy", "CurveSell", "SnipeTaxCharged", "BuybackLocked", "FeesSwept", "PoolRegistered", "HookFeeCollected", "PoolFeesSwept", "PoolConversionSkipped", "Locked", "Released", "Credited", "CreditedToken", "Claimed", "ClaimedToken", "EligibleRevenueAuthorized", "RevenueAllocated", "NonRevenueReceived", "TreasuryClaimed", "FeesRescued", "PoolFeesRescued"]) {
      expect(names, n).toContain(n);
    }
    const l = buildLedger(h.events, h.ctx);
    const kinds = new Set(l.exceptions.map((x) => x.kind));
    for (const k of ["THIRD_PARTY_CREDIT_TO_SPLITTER", "UNMATCHED_SOURCE_CREDIT", "SWEEP_CREDIT_MISMATCH", "OWNER_RESCUE_CURVE"]) expect(kinds, k).toContain(k);
    expect(l.credits.some((c) => c.cls === "CREATOR_FEE" && c.base === null)).toBe(true); // an unsplit (converted) hook sweep
    expect(new Set(l.credits.map((c) => c.asset)).size).toBeGreaterThanOrEqual(3);
  });
});
