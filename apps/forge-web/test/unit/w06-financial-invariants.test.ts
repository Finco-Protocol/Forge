/**
 * W06 financial acceptance — independently written invariant regression.
 *
 * This file deliberately does NOT reuse scripts/w05/synthetic-history.ts. It
 * contains its own seeded world generator AND its own arithmetic oracle (plain
 * bigint bookkeeping that never calls the product code), then asserts that the
 * product ledger agrees with the oracle and that the money-safety invariants
 * hold at EVERY block prefix of randomized histories. No fee policy, maths or
 * contract is changed; sandbox/synthetic events only (SANDBOX_NOT_EVIDENCE for
 * production).
 */
import { describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { buildLedger, derivedTreasuryReserve, NATIVE, verifiedEligibleRevenue, type LedgerContext, type LedgerEvent } from "@/server/finance/ledger";
import { applyEvents, decodeFoldState, encodeFoldState, finalizeFold, foldAll, ledgerDigest } from "@/server/finance/ledger-fold";
import { eligibility, ELIGIBLE_PROTOCOL_SHARE_BPS } from "@/server/finance/service";
import { verifyClaimContents, type ClaimTx } from "@/server/finance/claims";
import { forgeProtocolRevenueSplitterAbi, ponsV2FeeEscrowAbi } from "@/shared/abis.generated";
import type { AppContext } from "@/server/context";

// ── tiny deterministic RNG (own copy; fixed seeds) ──────────────────────────
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`) as Address;
const FACTORY = A(0xf0), HOOK = A(0x2044), ESCROW = A(0xe5), VAULT = A(0xa7), SPLITTER = A(0x5b), OTHER_RECIPIENT = A(0x07), STRANGER = A(0xbad), ATTESTOR = A(0xa77);
const CTX: LedgerContext = { factory: FACTORY, hook: HOOK, escrow: ESCROW, vault: VAULT, splitter: SPLITTER };

/** token index → how its frozen snapshot routes the protocol leg. */
interface Tok { token: Address; curve: Address; creator: Address; shareBps: number; recipient: Address; eligible: boolean }
const TOKENS: Tok[] = [
  { token: A(0x701), curve: A(0xc01), creator: A(0xca1), shareBps: 3000, recipient: SPLITTER, eligible: true },
  { token: A(0x702), curve: A(0xc02), creator: A(0xca2), shareBps: 3000, recipient: SPLITTER, eligible: true },
  { token: A(0x703), curve: A(0xc03), creator: A(0xca3), shareBps: 5000, recipient: SPLITTER, eligible: false }, // non-30% snapshot
  { token: A(0x704), curve: A(0xc04), creator: A(0xca4), shareBps: 3000, recipient: OTHER_RECIPIENT, eligible: false }, // protocol leg not to the splitter
];

type Step =
  | { k: "trade"; t: number; fee: bigint; tax: bigint }
  | { k: "sweep"; t: number }
  | { k: "third"; to: "splitter" | "creator"; t: number; amount: bigint }
  | { k: "launchFee"; amount: bigint }
  | { k: "rescue"; t: number }
  | { k: "directDonation"; amount: bigint }
  | { k: "pull"; frac: number }
  | { k: "treasuryClaim"; frac: number }
  | { k: "creatorClaim"; t: number; frac: number };

function genSteps(seed: number, n: number): Step[] {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const out: Step[] = [];
  for (let i = 0; i < n; i++) {
    const roll = r();
    const t = Math.floor(r() * TOKENS.length);
    if (roll < 0.28) out.push({ k: "trade", t, fee: BigInt(10 * (1 + Math.floor(r() * 5000))), tax: BigInt(Math.floor(r() * 2000)) });
    else if (roll < 0.46) out.push({ k: "sweep", t });
    else if (roll < 0.56) out.push({ k: "third", to: pick(["splitter", "creator"] as const), t, amount: BigInt(1 + Math.floor(r() * 9999)) });
    else if (roll < 0.62) out.push({ k: "launchFee", amount: BigInt(1 + Math.floor(r() * 1e6)) });
    else if (roll < 0.66) out.push({ k: "rescue", t });
    else if (roll < 0.7) out.push({ k: "directDonation", amount: BigInt(1 + Math.floor(r() * 999)) });
    else if (roll < 0.82) out.push({ k: "pull", frac: r() });
    else if (roll < 0.9) out.push({ k: "treasuryClaim", frac: r() });
    else out.push({ k: "creatorClaim", t, frac: r() });
  }
  return out;
}

interface Oracle {
  verified: bigint; // protocol-leg credits to the splitter from ELIGIBLE launches
  protocolLegsAll: bigint;
  tokenProtocol: bigint[];
  tokenCreatorBase: bigint[];
  tokenTax: bigint[];
  thirdPartyToSplitter: bigint;
  thirdPartyToCreators: bigint;
  launchFees: bigint;
  rescuedProtocol: bigint;
  rescuedToSplitter: bigint;
  donations: bigint;
  pulled: bigint;
  ceiling: bigint;
  nonce: bigint;
  reserveCum: bigint;
  treasuryAlloc: bigint;
  treasuryPaid: bigint;
  creatorBal: bigint[]; // escrow balance per creator
  splitterEscrow: bigint;
  pendingFee: bigint[];
  pendingTax: bigint[];
}
const zeros = () => TOKENS.map(() => 0n);
const freshOracle = (): Oracle => ({
  verified: 0n, protocolLegsAll: 0n, tokenProtocol: zeros(), tokenCreatorBase: zeros(), tokenTax: zeros(), thirdPartyToSplitter: 0n, thirdPartyToCreators: 0n,
  launchFees: 0n, rescuedProtocol: 0n, rescuedToSplitter: 0n, donations: 0n, pulled: 0n, ceiling: 0n, nonce: 0n, reserveCum: 0n, treasuryAlloc: 0n, treasuryPaid: 0n,
  creatorBal: zeros(), splitterEscrow: 0n, pendingFee: zeros(), pendingTax: zeros(),
});

/** Builds events + the oracle after each step. `branch` salts block hashes (reorg simulation). */
function realize(steps: Step[], branch: number, forkBlock = 0, firstStepBlock = 10): { events: LedgerEvent[]; oracles: Oracle[]; blockOfStep: number[] } {
  const events: LedgerEvent[] = [];
  const oracles: Oracle[] = [];
  const blockOfStep: number[] = [];
  let li = 0;
  const hashFor = (block: number) => `0x${(block > forkBlock ? branch : 0).toString(16)}${block.toString(16).padStart(63, "0")}`;
  const push = (block: number, address: Address, eventName: string, args: Record<string, string>, tx: string) =>
    events.push({ blockNumber: BigInt(block), blockHash: hashFor(block), txHash: tx, logIndex: li++, address, eventName, args, blockTimestamp: BigInt(1_000 + block) });
  const txOf = (block: number, n = 0) => `0x${(block > forkBlock ? branch : 0).toString(16)}${block.toString(16).padStart(60, "0")}${n.toString(16).padStart(3, "0")}`;

  // Launch announcements in blocks 1..4 (never reorged: shared prefix).
  TOKENS.forEach((tk, i) => {
    li = 0;
    events.push({ blockNumber: BigInt(i + 1), blockHash: `0x0${(i + 1).toString(16).padStart(63, "0")}`, txHash: `0x0${(i + 1).toString(16).padStart(63, "1")}`, logIndex: 0, address: FACTORY, eventName: "TokenLaunched", args: { token: tk.token, curve: tk.curve, deployer: tk.creator, pairToken: NATIVE, launchConfigId: "0", graduationThreshold: "30" }, blockTimestamp: BigInt(1_000 + i + 1) });
  });
  const o = freshOracle();
  const snap = (): Oracle => ({ ...o, tokenProtocol: [...o.tokenProtocol], tokenCreatorBase: [...o.tokenCreatorBase], tokenTax: [...o.tokenTax], creatorBal: [...o.creatorBal], pendingFee: [...o.pendingFee], pendingTax: [...o.pendingTax] });

  steps.forEach((s, idx) => {
    const block = firstStepBlock + idx;
    li = 0;
    const tx = txOf(block);
    switch (s.k) {
      case "trade": {
        const tk = TOKENS[s.t]!;
        push(block, tk.curve, "CurveBuy", { buyer: STRANGER, recipient: STRANGER, quoteIn: "1", tokensOut: "1", fee: s.fee.toString(), tax: s.tax.toString() }, tx);
        o.pendingFee[s.t]! += s.fee;
        o.pendingTax[s.t]! += s.tax;
        break;
      }
      case "sweep": {
        const tk = TOKENS[s.t]!;
        const fee = o.pendingFee[s.t]!, tax = o.pendingTax[s.t]!;
        if (fee === 0n) break;
        const protocol = (fee * BigInt(tk.shareBps)) / 10_000n; // fee is a multiple of 10 → exact for 30% and 50%
        const creatorBase = fee - protocol;
        const creator = creatorBase + tax;
        // Curve order: protocol credit, creator credit, then FeesSwept (all in one tx).
        if (protocol > 0n) push(block, ESCROW, "Credited", { recipient: tk.recipient, depositor: tk.curve, amount: protocol.toString() }, tx);
        if (creator > 0n) push(block, ESCROW, "Credited", { recipient: tk.creator, depositor: tk.curve, amount: creator.toString() }, tx);
        push(block, tk.curve, "FeesSwept", { protocolAmount: protocol.toString(), buybackAmount: "0", creatorAmount: creator.toString() }, tx);
        o.pendingFee[s.t] = 0n;
        o.pendingTax[s.t] = 0n;
        o.tokenProtocol[s.t]! += protocol;
        o.tokenCreatorBase[s.t]! += creatorBase;
        o.tokenTax[s.t]! += tax;
        o.protocolLegsAll += protocol;
        o.creatorBal[s.t]! += creator;
        if (tk.recipient === SPLITTER) {
          o.splitterEscrow += protocol;
          if (tk.eligible) o.verified += protocol;
        }
        break;
      }
      case "third": {
        const tk = TOKENS[s.t]!;
        const to = s.to === "splitter" ? SPLITTER : tk.creator;
        push(block, ESCROW, "Credited", { recipient: to, depositor: STRANGER, amount: s.amount.toString() }, tx);
        if (s.to === "splitter") { o.thirdPartyToSplitter += s.amount; o.splitterEscrow += s.amount; } else { o.thirdPartyToCreators += s.amount; o.creatorBal[s.t]! += s.amount; }
        break;
      }
      case "launchFee":
        push(block, SPLITTER, "NonRevenueReceived", { asset: NATIVE, amount: s.amount.toString(), cls: "0", from: FACTORY }, tx);
        o.launchFees += s.amount;
        break;
      case "directDonation":
        push(block, SPLITTER, "NonRevenueReceived", { asset: NATIVE, amount: s.amount.toString(), cls: "1", from: STRANGER }, tx);
        o.donations += s.amount;
        break;
      case "rescue": {
        const tk = TOKENS[s.t]!;
        const fee = o.pendingFee[s.t]!;
        if (fee === 0n) break;
        const protocol = (fee * BigInt(tk.shareBps)) / 10_000n;
        // F-04: the rescue pays the regular split DIRECTLY (escrow bypassed); the splitter sees an unattributed direct transfer.
        push(block, tk.curve, "FeesRescued", { protocolAmount: protocol.toString(), creatorAmount: (fee - protocol + o.pendingTax[s.t]!).toString() }, tx);
        if (tk.recipient === SPLITTER) push(block, SPLITTER, "NonRevenueReceived", { asset: NATIVE, amount: protocol.toString(), cls: "1", from: tk.curve }, tx);
        o.rescuedProtocol += protocol;
        if (tk.recipient === SPLITTER) o.rescuedToSplitter += protocol;
        o.pendingFee[s.t] = 0n;
        o.pendingTax[s.t] = 0n;
        break;
      }
      case "pull": {
        // Honest attestor: ceiling := verified eligible revenue; pull some fraction of the headroom.
        if (o.verified > o.ceiling) {
          o.nonce += 1n;
          push(block, SPLITTER, "EligibleRevenueAuthorized", { asset: NATIVE, cumulativeEligible: o.verified.toString(), nonce: o.nonce.toString(), evidenceBlock: String(block - 1), evidenceBlockHash: hashFor(block - 1), attestor: ATTESTOR }, tx);
          o.ceiling = o.verified;
        }
        const headroom = o.ceiling - o.pulled;
        const x = BigInt(Math.floor(Number(headroom) * s.frac));
        if (x === 0n) break;
        const reserveCum = (o.pulled + x) / 3n; // cumulative 2:1 rounding, dust to treasury
        const toReserve = reserveCum - o.reserveCum;
        const toTreasury = x - toReserve;
        push(block, ESCROW, "Claimed", { recipient: SPLITTER, amount: x.toString() }, tx);
        push(block, SPLITTER, "RevenueAllocated", { allocationId: String(idx + 1), asset: NATIVE, escrowClaimed: x.toString(), received: x.toString(), toTreasury: toTreasury.toString(), toReserve: toReserve.toString(), policyVersion: "1" }, tx);
        o.pulled += x; o.reserveCum = reserveCum; o.treasuryAlloc += toTreasury; o.splitterEscrow -= x;
        break;
      }
      case "treasuryClaim": {
        const owed = o.treasuryAlloc - o.treasuryPaid;
        const x = BigInt(Math.floor(Number(owed) * s.frac));
        if (x === 0n) break;
        push(block, SPLITTER, "TreasuryClaimed", { asset: NATIVE, recipient: A(0x7e), amount: x.toString() }, tx);
        o.treasuryPaid += x;
        break;
      }
      case "creatorClaim": {
        const tk = TOKENS[s.t]!;
        const x = BigInt(Math.floor(Number(o.creatorBal[s.t]!) * s.frac));
        if (x === 0n) break;
        push(block, ESCROW, "Claimed", { recipient: tk.creator, amount: x.toString() }, tx);
        o.creatorBal[s.t]! -= x;
        break;
      }
    }
    oracles.push(snap());
    blockOfStep.push(block);
  });
  return { events, oracles, blockOfStep };
}

const ELIGIBLE = new Set(TOKENS.map((t) => t.token)); // deliberately ALL tokens: the recipient filter alone must exclude #4
const ELIGIBLE_BY_SNAPSHOT = new Set(TOKENS.filter((t) => t.eligible).map((t) => t.token));

/** Every money-safety invariant, against the oracle, for one prefix. */
function assertInvariants(events: LedgerEvent[], o: Oracle, label: string) {
  const l = buildLedger(events, CTX);
  const tag = (m: string) => `${label}: ${m}`;

  // I1 — verified eligible revenue == oracle: counts ONLY eligible-snapshot protocol legs to the splitter.
  const v = verifiedEligibleRevenue(l, SPLITTER, ELIGIBLE_BY_SNAPSHOT, null).get(NATIVE) ?? 0n;
  expect(v, tag("verified eligible")).toBe(o.verified);
  // …and a resolver that WRONGLY lists every launch still cannot include a leg that was not credited to the splitter key.
  const wrong = verifiedEligibleRevenue(l, SPLITTER, ELIGIBLE, null).get(NATIVE) ?? 0n;
  expect(wrong, tag("recipient filter is independent of the snapshot set")).toBe(o.verified + o.tokenProtocol[2]!);
  // Third-party credits, creator tax, launch fees, rescues and donations are in NONE of it.
  expect(v).toBeLessThanOrEqual(o.protocolLegsAll);

  // I2 — creator funds are never allocated as protocol revenue.
  for (const c of l.credits) {
    if (TOKENS.some((t) => t.creator === c.recipient)) expect(c.cls, tag("creator credit class")).not.toBe("PROTOCOL_BASE_FEE");
    if (c.cls === "PROTOCOL_BASE_FEE") expect(c.recipient === SPLITTER || c.recipient === OTHER_RECIPIENT, tag("protocol legs only go to the protocol recipient")).toBe(true);
  }
  const st = l.splitterTotals.get(NATIVE);
  const received = st?.revenueReceived ?? 0n;
  expect(received, tag("allocated <= verified")).toBeLessThanOrEqual(o.verified);
  expect(st?.escrowClaimed ?? 0n).toBe(o.pulled);
  TOKENS.forEach((tk, i) => expect(l.escrowBalances.get(`${tk.creator}:${NATIVE}`) ?? 0n, tag(`creator escrow balance ${i}`)).toBe(o.creatorBal[i]!));

  // I3 — third-party escrow credits are not eligible revenue; they stay in the escrow under the splitter key.
  const tp = l.credits.filter((c) => c.depositor === STRANGER);
  expect(tp.every((c) => c.cls === "UNATTRIBUTED_CREDIT" && c.token === null)).toBe(true);
  expect(l.exceptions.filter((e) => e.kind === "THIRD_PARTY_CREDIT_TO_SPLITTER").reduce((a, e) => a + BigInt(e.amount!), 0n)).toBe(o.thirdPartyToSplitter);
  expect(l.escrowBalances.get(`${SPLITTER}:${NATIVE}`) ?? 0n, tag("splitter escrow = legs + third party - pulled")).toBe(o.splitterEscrow);
  expect(o.splitterEscrow).toBeGreaterThanOrEqual(o.thirdPartyToSplitter); // third-party funds are never consumed by a pull

  // I4 — 70/20/10 shape: exact for the 30% snapshot, honestly different (never relabelled) otherwise.
  TOKENS.forEach((tk, i) => {
    const t = l.tokens.get(tk.token)!;
    expect(t.protocolCredited, tag(`protocol ${i}`)).toBe(o.tokenProtocol[i]!);
    expect(t.creatorBaseCredited, tag(`creator base ${i}`)).toBe(o.tokenCreatorBase[i]!);
    if (tk.shareBps === 3000) expect(t.protocolCredited * 7n, tag(`7p=3c ${i}`)).toBe(t.creatorBaseCredited * 3n);
    if (tk.shareBps === 5000) expect(t.protocolCredited, tag("50/50 is shown as 50/50")).toBe(t.creatorBaseCredited);
    // I5 — creator tax: 100% to the creator, never in the protocol leg.
    expect(t.creatorTaxCredited, tag(`tax ${i}`)).toBe(o.tokenTax[i]!);
    expect(t.creatorCredited).toBe(t.creatorBaseCredited + t.creatorTaxCredited);
  });

  // I6 — launch fees, rescues and direct donations are non-revenue.
  expect(st?.launchFees ?? 0n).toBe(o.launchFees);
  expect(st?.nonRevenueReceived ?? 0n).toBe(o.launchFees + o.donations + o.rescuedToSplitter);
  expect(received).toBe(o.pulled); // only pulls produce revenue

  // I7 — treasury + reserve liabilities conserve the allocated revenue, 2:1 with dust to treasury.
  const tAlloc = st?.treasuryAllocated ?? 0n, rAlloc = st?.reserveAllocated ?? 0n;
  expect(tAlloc + rAlloc, tag("treasury+reserve == revenue received")).toBe(received);
  expect(rAlloc).toBe(received / 3n);
  expect(derivedTreasuryReserve(received)).toEqual({ treasury: tAlloc, reserve: rAlloc });
  expect(st?.treasuryPaid ?? 0n).toBeLessThanOrEqual(tAlloc);
  expect((st?.eligibleCeiling ?? 0n) >= received).toBe(true);
  expect(st?.eligibleCeiling ?? 0n).toBeLessThanOrEqual(o.verified);
  return l;
}

const SEEDS = [11, 23, 47, 101, 313, 977, 2024, 4663, 31337, 65537, 90001, 123457];

describe("W06 financial invariants — randomized worlds checked at EVERY block prefix", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: oracle == ledger and all money invariants hold at each prefix`, () => {
      const steps = genSteps(seed, 70);
      const { events, oracles, blockOfStep } = realize(steps, 1);
      steps.forEach((_, i) => {
        const prefix = events.filter((e) => Number(e.blockNumber) <= blockOfStep[i]!);
        assertInvariants(prefix, oracles[i]!, `seed ${seed} step ${i} (${steps[i]!.k})`);
      });
      // The generator really exercised the dangerous flows (otherwise the property is vacuous).
      const kinds = new Set(steps.map((s) => s.k));
      for (const k of ["trade", "sweep", "third", "pull", "treasuryClaim", "creatorClaim"]) expect(kinds.has(k as Step["k"])).toBe(true);
    });
  }

  it("the worlds collectively hit every flow: pulls, launch fees, rescues, donations, tax, third-party credits", () => {
    const seen = new Set<string>();
    let pulled = 0n, tax = 0n, third = 0n;
    for (const seed of SEEDS) {
      const { events, oracles } = realize(genSteps(seed, 70), 1);
      events.forEach((e) => seen.add(e.eventName + (e.eventName === "NonRevenueReceived" ? `:${e.args.cls}` : "")));
      const o = oracles[oracles.length - 1]!;
      pulled += o.pulled; tax += o.tokenTax.reduce((a, b) => a + b, 0n); third += o.thirdPartyToSplitter;
    }
    for (const n of ["RevenueAllocated", "EligibleRevenueAuthorized", "TreasuryClaimed", "FeesRescued", "NonRevenueReceived:0", "NonRevenueReceived:1", "Claimed", "Credited"]) expect(seen.has(n), n).toBe(true);
    expect(pulled > 0n && tax > 0n && third > 0n).toBe(true);
  });
});

describe("W06 historical vs materialized ledger digests (replay + reorg)", () => {
  for (const seed of SEEDS.slice(0, 8)) {
    it(`seed ${seed}: fold == reference under duplicates/shuffle/snapshot cuts; reorg re-fold == new-branch reference`, () => {
      const r = rng(seed);
      const fork = 12 + Math.floor(rng(seed + 5)() * 60); // branch point (steps are blocks 10..89)
      const a = realize(genSteps(seed, 80), 1, fork);
      const ref = ledgerDigest(buildLedger(a.events, CTX));
      // event replay: duplicates + reverse order
      const noisy = [...a.events, ...a.events.filter(() => r() < 0.3)].reverse();
      expect(ledgerDigest(buildLedger(noisy, CTX))).toBe(ref);
      expect(ledgerDigest(finalizeFold(foldAll(noisy, CTX)))).toBe(ref);
      // incremental materialization with serialize/restore at random cut points
      const last = Number(a.events[a.events.length - 1]!.blockNumber);
      let state = foldAll([], CTX);
      let prev = 0;
      const snaps = new Map<number, string>();
      for (const cut of [...new Set([5, ...Array.from({ length: 6 }, () => 10 + Math.floor(r() * (last - 10))), last])].sort((x, y) => x - y)) {
        applyEvents(state, a.events.filter((e) => Number(e.blockNumber) > prev && Number(e.blockNumber) <= cut), CTX, BigInt(cut));
        prev = cut;
        snaps.set(cut, encodeFoldState(state));
        state = decodeFoldState(snaps.get(cut)!);
      }
      expect(ledgerDigest(finalizeFold(state))).toBe(ref);
      // reorg at a random height: branch B shares blocks <= fork and diverges after
      const stepsA = genSteps(seed, 80);
      const stepsB = [...stepsA.slice(0, fork - 10 + 1), ...genSteps(seed + 999, 80).slice(fork - 10 + 1)];
      const A2 = a;
      const B = realize(stepsB, 2, fork);
      const refB = ledgerDigest(buildLedger(B.events, CTX));
      expect(refB).not.toBe(ledgerDigest(buildLedger(A2.events, CTX)));
      const usable = [...snaps.keys()].filter((k) => k <= fork);
      // snapshots above the fork are discarded (rollbackSnapshots); restore the newest at/below it
      const base = usable.length ? decodeFoldState(snaps.get(Math.max(...usable))!) : foldAll([], CTX);
      applyEvents(base, B.events, CTX, BigInt(Number(B.events[B.events.length - 1]!.blockNumber)));
      expect(ledgerDigest(finalizeFold(base))).toBe(refB);
      // and the invariants hold on the NEW branch too (no income inflated by the orphaned blocks)
      assertInvariants(B.events, B.oracles[B.oracles.length - 1]!, `seed ${seed} reorg branch`);
    });
  }
});

describe("W06 70/20/10 only for qualifying fee-policy snapshots (eligibility, fail closed)", () => {
  const ctxWith = (splitter: Address | null) => ({ cfg: { addresses: { revenueSplitter: splitter } } }) as unknown as AppContext;
  const launch = (recipient: Address, share: number, buyback = false) =>
    ({ policy: { protocolFeeRecipient: recipient, protocolFeeShareBps: share, buybackBurnBps: 5000, hookFeeBps: 100 }, creatorTaxBps: 100, buybackEnabled: buyback }) as unknown as Parameters<typeof eligibility>[1];

  it("exactly one eligible shape: recipient == splitter AND share == 30%", () => {
    expect(ELIGIBLE_PROTOCOL_SHARE_BPS).toBe(3000);
    const ok = eligibility(ctxWith(SPLITTER), launch(SPLITTER, 3000));
    expect(ok.eligible70_20_10).toBe(true);
    expect(ok.actual).toMatchObject({ creatorPct: 70, protocolPct: 30, treasuryPct: 20, reservePct: 10, creatorTaxPct: 1 });
    expect(ok.actual.creatorTaxNote).toMatch(/never part of the 70\/20\/10/);
  });

  it("every neighbouring snapshot is refused and shows its ACTUAL split", () => {
    for (const share of [0, 1, 2999, 3001, 5000, 10_000]) {
      const e = eligibility(ctxWith(SPLITTER), launch(SPLITTER, share));
      expect(e.eligible70_20_10, `share ${share}`).toBe(false);
      expect(e.actual.protocolPct).toBe(share / 100);
      expect(e.actual.creatorPct).toBe((10_000 - share) / 100);
    }
    const wrongRecipient = eligibility(ctxWith(SPLITTER), launch(OTHER_RECIPIENT, 3000));
    expect(wrongRecipient.eligible70_20_10).toBe(false);
    expect(wrongRecipient.actual.treasuryPct).toBeNull();
    expect(wrongRecipient.actual.reservePct).toBeNull();
  });

  it("no splitter configured → nothing is eligible", () => {
    expect(eligibility(ctxWith(null), launch(SPLITTER, 3000)).eligible70_20_10).toBe(false);
  });

  it("buyback-and-lock reduces the effective creator CASH share but never changes the eligibility test", () => {
    const e = eligibility(ctxWith(SPLITTER), launch(SPLITTER, 3000, true));
    expect(e.eligible70_20_10).toBe(true);
    expect(e.actual.creatorCashPct).toBe(35);
    expect(e.actual.creatorBuybackLockPct).toBe(35);
  });
});

describe("W06 claims require canonical target, sender, selector, asset, amount (property)", () => {
  const WALLET = A(0xc1a1), TOKEN = A(0x7a), r = rng(4663);
  const base = (kind: "escrow" | "treasury", asset: Address, nominal: bigint) => ({ chainId: 31337, wallet: WALLET, kind, asset, target: kind === "escrow" ? ESCROW : SPLITTER, nominal });
  const calldata = (kind: "escrow" | "treasury", asset: Address, amount: bigint, variant: number): Hex => {
    if (kind === "treasury") return encodeFunctionData({ abi: forgeProtocolRevenueSplitterAbi, functionName: "claimTreasury", args: [asset, amount] });
    if (asset === NATIVE) return variant % 2 === 0 || amount === 0n ? encodeFunctionData({ abi: ponsV2FeeEscrowAbi, functionName: "claim" }) : encodeFunctionData({ abi: ponsV2FeeEscrowAbi, functionName: "claim", args: [amount] });
    return variant % 2 === 0 || amount === 0n ? encodeFunctionData({ abi: ponsV2FeeEscrowAbi, functionName: "claimToken", args: [asset] }) : encodeFunctionData({ abi: ponsV2FeeEscrowAbi, functionName: "claimToken", args: [asset, amount] });
  };

  it("accepts exactly the canonical claim and rejects every single-field mutation", () => {
    for (let i = 0; i < 40; i++) {
      const kind = i % 2 === 0 ? ("escrow" as const) : ("treasury" as const);
      const asset = kind === "treasury" || r() < 0.5 ? (r() < 0.5 ? NATIVE : TOKEN) : NATIVE;
      const amount = r() < 0.3 ? 0n : BigInt(1 + Math.floor(r() * 1e9));
      // escrow: even variants use the no-amount (full balance) overload, so the nominal the caller must expect is 0
      const variant = Math.floor(i / 2);
      const nominal = kind === "escrow" && variant % 2 === 0 ? 0n : amount;
      const exp = base(kind, asset, nominal);
      const data = calldata(kind, asset, nominal, variant);
      const tx: ClaimTx = { chainId: 31337, from: WALLET, to: exp.target, input: data, value: 0n };
      expect(verifyClaimContents(tx, exp).ok).toBe(true);
      const code = (t: typeof tx, e = exp) => { const c = verifyClaimContents(t, e); return c.ok ? "OK" : c.code; };
      expect(code({ ...tx, chainId: 4663 })).toBe("WRONG_CHAIN");
      expect(code({ ...tx, from: A(0xbad1) })).toBe("NOT_YOUR_TRANSACTION");
      expect(code({ ...tx, to: A(0xdead) })).toBe("WRONG_RECIPIENT_CONTRACT");
      expect(code({ ...tx, to: null })).toBe("WRONG_RECIPIENT_CONTRACT");
      expect(code({ ...tx, input: ("0xdeadbeef" + data.slice(10)) as Hex })).toBe("WRONG_SELECTOR");
      expect(code({ ...tx, value: 1n })).toBe("UNEXPECTED_VALUE");
      expect(code(tx, { ...exp, asset: asset === NATIVE ? TOKEN : NATIVE })).toBe("WRONG_ASSET");
      expect(code(tx, { ...exp, nominal: nominal + 1n })).toBe("WRONG_AMOUNT");
      // the escrow key and the splitter key are not interchangeable
      expect(code({ ...tx, to: kind === "escrow" ? SPLITTER : ESCROW })).toBe("WRONG_RECIPIENT_CONTRACT");
    }
  });
});
