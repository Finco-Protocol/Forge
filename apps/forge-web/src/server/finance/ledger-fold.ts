/**
 * W05 — resumable form of the W04 ledger fold.
 *
 * `buildLedger(events, ctx)` in ledger.ts stays the REFERENCE implementation
 * (unchanged). This module folds the same rules incrementally:
 *
 *   const s = createFoldState();
 *   applyEvents(s, eventsOfBlocks(0..k], ctx, k);
 *   applyEvents(s, eventsOfBlocks(k..n], ctx, n);
 *   finalizeFold(s)  ≡  buildLedger(allEvents, ctx)
 *
 * Why this is equivalent (and when it refuses to be):
 *  - buildLedger canonicalises (dedupe by blockHash:logIndex, order by
 *    block/logIndex) and then makes two passes: pass 1 maps curves → tokens
 *    and pools → tokens over the WHOLE history, pass 2 folds every event in
 *    order. Pass 2 only ever looks backwards, except through the pass-1 maps.
 *  - The fold runs pass 1 over each batch before pass 2 of that batch, so a
 *    batch sees every mapping announced in it or earlier. It is therefore
 *    equivalent to buildLedger unless an event in an EARLIER batch referred
 *    to an identifier (curve, pool, launch token, escrow depositor) that a
 *    LATER batch announces or re-announces. On chain this cannot happen (a
 *    curve cannot emit before it is created by the launch transaction), but
 *    the fold does not assume it: every unresolved identifier is remembered
 *    and a later announcement of it throws NonIncrementalHistoryError, upon
 *    which callers fold from genesis in ONE batch (= buildLedger exactly).
 *  - Escrow credits wait for a sweep of the SAME transaction (same block), so
 *    batches must contain whole blocks; the pending map is flushed at the end
 *    of each batch in insertion order, exactly where buildLedger emits its
 *    UNMATCHED_SOURCE_CREDIT exceptions (after all in-loop exceptions).
 *  - Events at or below the fold cursor are re-deliveries (the indexer
 *    commits whole block ranges atomically with its checkpoint) and are
 *    ignored; the materializer additionally verifies the canonical event
 *    count below a snapshot before trusting it.
 */
import { createHash } from "node:crypto";
import type { Address } from "viem";
import {
  addr,
  assignLegs,
  big,
  canonicalize,
  emptySplitter,
  emptyTokenFees,
  GOVERNANCE_EVENTS,
  key,
  NATIVE,
  NON_REVENUE_CLASS,
  type CreditRow,
  type GovernanceEvent,
  type Ledger,
  type LedgerContext,
  type LedgerEvent,
  type LedgerException,
  type RevenueAuthorization,
  type SplitterAllocation,
} from "./ledger";

/** Bump when the fold rules or the state layout change: old snapshots are then ignored. */
export const FOLD_VERSION = 1;

export class NonIncrementalHistoryError extends Error {
  constructor(detail: string) {
    super(`NON_INCREMENTAL_HISTORY: ${detail}`);
  }
}

export interface LedgerFoldState {
  ledger: Ledger;
  curveToken: Map<Address, Address>;
  poolToken: Map<string, Address>;
  curveTaxAcc: Map<Address, bigint>;
  hookTaxQuoteAcc: Map<string, bigint>;
  hookTaxMemeAcc: Map<string, bigint>;
  /** UNMATCHED_SOURCE_CREDIT exceptions, emitted after all in-loop exceptions (as buildLedger does). */
  deferred: LedgerException[];
  /** Identifiers referenced before being announced (see module comment). */
  unresolved: Set<string>;
  /** Highest block whose events are fully applied (null = nothing applied). */
  cursor: bigint | null;
  /** Number of canonical (deduplicated) events applied. */
  eventCount: number;
}

export function createFoldState(): LedgerFoldState {
  return {
    ledger: {
      credits: [],
      claims: [],
      tokens: new Map(),
      allocations: [],
      authorizations: [],
      splitterTotals: new Map(),
      treasuryClaims: [],
      governance: [],
      exceptions: [],
      escrowBalances: new Map(),
      lastBlock: null,
    },
    curveToken: new Map(),
    poolToken: new Map(),
    curveTaxAcc: new Map(),
    hookTaxQuoteAcc: new Map(),
    hookTaxMemeAcc: new Map(),
    deferred: [],
    unresolved: new Set(),
    cursor: null,
    eventCount: 0,
  };
}

export interface ApplyResult {
  applied: number;
  /** Events at or below the cursor (re-deliveries), ignored. */
  skipped: number;
}

/**
 * Applies the events of whole blocks after the cursor. `throughBlock` (the
 * indexer checkpoint the batch corresponds to) advances the cursor even when
 * the last blocks carried no events. Mutates `s`.
 */
export function applyEvents(s: LedgerFoldState, input: LedgerEvent[], c: LedgerContext, throughBlock?: bigint): ApplyResult {
  const all = canonicalize(input);
  const events = s.cursor === null ? all : all.filter((e) => e.blockNumber > s.cursor!);
  const skipped = all.length - events.length;
  if (throughBlock !== undefined && events.length && events[events.length - 1]!.blockNumber > throughBlock) {
    throw new Error(`applyEvents: event at block ${events[events.length - 1]!.blockNumber} is above throughBlock ${throughBlock}`);
  }
  const ledger = s.ledger;
  const { curveToken, poolToken, curveTaxAcc, hookTaxQuoteAcc, hookTaxMemeAcc, unresolved } = s;

  const byTx = new Map<string, LedgerEvent[]>();
  for (const e of events) {
    const k = `${e.blockHash}:${e.txHash}`;
    if (!byTx.has(k)) byTx.set(k, []);
    byTx.get(k)!.push(e);
  }
  const splitterTotals = (asset: Address) => {
    if (!ledger.splitterTotals.has(asset)) ledger.splitterTotals.set(asset, emptySplitter(asset));
    return ledger.splitterTotals.get(asset)!;
  };
  const roleOf = (address: Address): GovernanceEvent["contract"] | null => {
    if (address === c.factory) return "factory";
    if (address === c.hook) return "hook";
    if (c.splitter && address === c.splitter) return "splitter";
    if (address === c.vault) return "vault";
    if (curveToken.has(address)) return "curve";
    return null;
  };

  // Pass 1 over the batch: launches and pools. An identifier referenced by an
  // earlier batch, or a mapping re-announced after an earlier batch used it,
  // would make the batched fold differ from buildLedger: refuse.
  const batchTokens = new Set<Address>();
  const batchCurves = new Set<Address>();
  const batchPools = new Set<string>();
  for (const e of events) {
    if (e.address === c.factory && e.eventName === "TokenLaunched") {
      const token = addr(e.args.token);
      const curve = addr(e.args.curve);
      if (unresolved.has(token) || unresolved.has(curve)) throw new NonIncrementalHistoryError(`launch ${token}/${curve} referenced before announcement`);
      if ((ledger.tokens.has(token) && !batchTokens.has(token)) || (curveToken.has(curve) && !batchCurves.has(curve))) {
        throw new NonIncrementalHistoryError(`launch ${token}/${curve} re-announced`);
      }
      batchTokens.add(token);
      batchCurves.add(curve);
      curveToken.set(curve, token);
      ledger.tokens.set(token, emptyTokenFees(token, curve, addr(e.args.deployer), addr(e.args.pairToken)));
    }
    if (e.address === c.hook && e.eventName === "PoolRegistered") {
      const token = addr(e.args.memecoin);
      const pid = String(e.args.poolId).toLowerCase();
      if (unresolved.has(`pool:${pid}`)) throw new NonIncrementalHistoryError(`pool ${pid} referenced before registration`);
      if (poolToken.has(pid) && !batchPools.has(pid)) throw new NonIncrementalHistoryError(`pool ${pid} re-registered`);
      batchPools.add(pid);
      poolToken.set(pid, token);
      const t = ledger.tokens.get(token);
      if (t) t.poolId = pid;
      else unresolved.add(token);
    }
  }

  const pendingCredits = new Map<string, CreditRow[]>();

  for (const e of events) {
    const role = roleOf(e.address);
    if (role && GOVERNANCE_EVENTS[role]?.has(e.eventName)) {
      ledger.governance.push({ blockNumber: e.blockNumber, txHash: e.txHash, timestamp: e.blockTimestamp, contract: role, address: e.address, eventName: e.eventName, args: e.args });
    }
    if (role === null && e.address !== c.escrow) unresolved.add(e.address);

    // ── curve trades & sweeps ─────────────────────────────────────────
    const curveTok = curveToken.get(e.address);
    if (curveTok) {
      const t = ledger.tokens.get(curveTok)!;
      if (e.eventName === "CurveBuy" || e.eventName === "CurveSell") {
        t.curveBaseFees += big(e.args.fee);
        t.curveCreatorTax += big(e.args.tax);
        curveTaxAcc.set(e.address, (curveTaxAcc.get(e.address) ?? 0n) + big(e.args.tax));
      } else if (e.eventName === "SnipeTaxCharged") {
        t.curveSnipeTax += big(e.args.amount);
      } else if (e.eventName === "BuybackLocked") {
        t.curveBuybackSpent += big(e.args.quoteSpent);
        t.curveTokensLocked += big(e.args.tokensLocked);
      } else if (e.eventName === "FeesSwept") {
        t.curveSweeps++;
        assignLegs(ledger, pendingCredits, e, "curve", t, big(e.args.protocolAmount), big(e.args.creatorAmount), curveTaxAcc.get(e.address) ?? 0n, false);
        curveTaxAcc.set(e.address, 0n);
      } else if (e.eventName === "FeesRescued") {
        t.rescuedProtocol += big(e.args.protocolAmount);
        t.rescuedCreator += big(e.args.creatorAmount);
        curveTaxAcc.set(e.address, 0n);
        ledger.exceptions.push({ kind: "OWNER_RESCUE_CURVE", detail: `Curve ${e.address} fees paid directly (escrow bypassed) for ${curveTok}`, txHash: e.txHash });
      }
      continue;
    }

    // ── hook fees & sweeps ────────────────────────────────────────────
    if (e.address === c.hook) {
      const pid = String(e.args.poolId ?? "").toLowerCase();
      const tok = poolToken.get(pid);
      const t = tok ? ledger.tokens.get(tok) : undefined;
      if (!tok) unresolved.add(`pool:${pid}`);
      else if (!t) unresolved.add(tok);
      if (e.eventName === "HookFeeCollected" && t) {
        const isQuote = addr(e.args.currency) === t.pairToken;
        if (isQuote) {
          t.hookBaseFeesQuote += big(e.args.feeAmount);
          t.hookCreatorTaxQuote += big(e.args.taxAmount);
          hookTaxQuoteAcc.set(pid, (hookTaxQuoteAcc.get(pid) ?? 0n) + big(e.args.taxAmount));
        } else {
          t.hookBaseFeesMemecoin += big(e.args.feeAmount);
          t.hookCreatorTaxMemecoin += big(e.args.taxAmount);
          hookTaxMemeAcc.set(pid, (hookTaxMemeAcc.get(pid) ?? 0n) + big(e.args.taxAmount));
        }
      } else if (e.eventName === "PoolFeesSwept" && t) {
        t.hookSweeps++;
        t.hookBuybackSpent += big(e.args.buybackAmount);
        t.hookTokensLocked += big(e.args.tokensLocked);
        const converted = (hookTaxMemeAcc.get(pid) ?? 0n) > 0n;
        const tx = byTx.get(`${e.blockHash}:${e.txHash}`) ?? [];
        const skippedConv = tx.some((x) => x.address === c.hook && x.eventName === "PoolConversionSkipped" && String(x.args.poolId).toLowerCase() === pid);
        assignLegs(ledger, pendingCredits, e, "hook", t, big(e.args.protocolAmount), big(e.args.creatorAmount), hookTaxQuoteAcc.get(pid) ?? 0n, converted && !skippedConv);
        hookTaxQuoteAcc.set(pid, 0n);
        if (!skippedConv) hookTaxMemeAcc.set(pid, 0n);
      } else if (e.eventName === "PoolFeesRescued" && t) {
        t.rescuedProtocol += big(e.args.protocolAmount);
        t.rescuedCreator += big(e.args.creatorAmount);
        ledger.exceptions.push({ kind: "OWNER_RESCUE_POOL", detail: `Hook pool ${pid} fees paid directly (escrow bypassed) for ${tok}`, txHash: e.txHash });
      }
      continue;
    }

    // ── buyback vault ─────────────────────────────────────────────────
    if (e.address === c.vault) {
      const t = ledger.tokens.get(addr(e.args.token));
      if (!t) {
        unresolved.add(addr(e.args.token));
        continue;
      }
      if (e.eventName === "Locked") t.vestLocked += big(e.args.amount);
      if (e.eventName === "Released") {
        t.vestReleasedCreator += big(e.args.creatorAmount);
        t.vestReleasedProtocol += big(e.args.protocolAmount);
      }
      continue;
    }

    // ── canonical escrow ──────────────────────────────────────────────
    if (e.address === c.escrow) {
      if (e.eventName === "Credited" || e.eventName === "CreditedToken") {
        const recipient = addr(e.args.recipient);
        const depositor = addr(e.args.depositor);
        const asset = e.eventName === "Credited" ? NATIVE : addr(e.args.token);
        const amount = big(e.args.amount);
        const row: CreditRow = {
          id: `${e.blockHash}:${e.logIndex}`,
          blockNumber: e.blockNumber,
          txHash: e.txHash,
          logIndex: e.logIndex,
          timestamp: e.blockTimestamp,
          recipient,
          depositor,
          asset,
          amount,
          source: "third_party",
          token: null,
          cls: "UNATTRIBUTED_CREDIT",
          base: null,
          tax: null,
        };
        if (curveToken.has(depositor) || depositor === c.hook) {
          row.source = curveToken.has(depositor) ? "curve" : "hook";
          const k = `${e.blockHash}:${e.txHash}:${depositor}`;
          if (!pendingCredits.has(k)) pendingCredits.set(k, []);
          pendingCredits.get(k)!.push(row);
        } else if (depositor === c.vault) {
          row.source = "vault";
          row.token = ledger.tokens.has(asset) ? asset : null;
          if (row.token === null) unresolved.add(asset);
          row.cls = c.splitter && recipient === c.splitter ? "VEST_RELEASE_PROTOCOL" : "VEST_RELEASE_CREATOR";
        } else {
          unresolved.add(depositor);
          if (c.splitter && recipient === c.splitter) {
            ledger.exceptions.push({
              kind: "THIRD_PARTY_CREDIT_TO_SPLITTER",
              detail: `Escrow credit to the splitter key by ${depositor}: not fee revenue. Never attested, so it stays in the escrow above the verified ceiling and cannot enter 70/20/10.`,
              txHash: e.txHash,
              asset,
              amount: amount.toString(),
            });
          }
        }
        ledger.credits.push(row);
        ledger.escrowBalances.set(key(recipient, asset), (ledger.escrowBalances.get(key(recipient, asset)) ?? 0n) + amount);
      } else if (e.eventName === "Claimed" || e.eventName === "ClaimedToken") {
        const recipient = addr(e.args.recipient);
        const asset = e.eventName === "Claimed" ? NATIVE : addr(e.args.token);
        const amount = big(e.args.amount);
        ledger.claims.push({ id: `${e.blockHash}:${e.logIndex}`, blockNumber: e.blockNumber, txHash: e.txHash, timestamp: e.blockTimestamp, recipient, asset, amount });
        ledger.escrowBalances.set(key(recipient, asset), (ledger.escrowBalances.get(key(recipient, asset)) ?? 0n) - amount);
      }
      continue;
    }

    // ── revenue splitter ──────────────────────────────────────────────
    if (c.splitter && e.address === c.splitter) {
      if (e.eventName === "RevenueAllocated") {
        const asset = addr(e.args.asset);
        const a: SplitterAllocation = {
          id: `${e.blockHash}:${e.logIndex}`,
          allocationId: big(e.args.allocationId),
          blockNumber: e.blockNumber,
          txHash: e.txHash,
          timestamp: e.blockTimestamp,
          asset,
          escrowClaimed: big(e.args.escrowClaimed),
          received: big(e.args.received),
          toTreasury: big(e.args.toTreasury),
          toReserve: big(e.args.toReserve),
          policyVersion: Number(e.args.policyVersion),
        };
        ledger.allocations.push(a);
        const st = splitterTotals(asset);
        st.escrowClaimed += a.escrowClaimed;
        st.revenueReceived += a.received;
        st.treasuryAllocated += a.toTreasury;
        st.reserveAllocated += a.toReserve;
      } else if (e.eventName === "EligibleRevenueAuthorized") {
        const asset = addr(e.args.asset);
        const auth: RevenueAuthorization = {
          id: `${e.blockHash}:${e.logIndex}`,
          blockNumber: e.blockNumber,
          txHash: e.txHash,
          timestamp: e.blockTimestamp,
          asset,
          cumulativeEligible: big(e.args.cumulativeEligible),
          nonce: big(e.args.nonce),
          evidenceBlock: big(e.args.evidenceBlock),
          evidenceBlockHash: String(e.args.evidenceBlockHash),
          attestor: addr(e.args.attestor),
        };
        ledger.authorizations.push(auth);
        const st = splitterTotals(asset);
        st.eligibleCeiling = auth.cumulativeEligible;
        st.authNonce = auth.nonce;
      } else if (e.eventName === "NonRevenueReceived") {
        const asset = addr(e.args.asset);
        const st = splitterTotals(asset);
        const amount = big(e.args.amount);
        st.nonRevenueReceived += amount;
        const cls = NON_REVENUE_CLASS[Number(e.args.cls)] ?? "UnattributedNative";
        const from = addr(e.args.from);
        if (cls === "LaunchFee") st.launchFees += amount;
        else if (c.graduationExecutor && from === c.graduationExecutor) st.graduationResidual += amount;
        else if (cls === "UnattributedNative") st.unattributedNative += amount;
        else st.unattributedToken += amount;
      } else if (e.eventName === "NonRevenueReleased") {
        splitterTotals(addr(e.args.asset)).nonRevenueReleased += big(e.args.amount);
      } else if (e.eventName === "TreasuryClaimed") {
        const asset = addr(e.args.asset);
        const amount = big(e.args.amount);
        splitterTotals(asset).treasuryPaid += amount;
        ledger.treasuryClaims.push({ id: `${e.blockHash}:${e.logIndex}`, blockNumber: e.blockNumber, txHash: e.txHash, timestamp: e.blockTimestamp, recipient: addr(e.args.recipient), asset, amount });
      }
    }
  }

  // Pending credits are keyed by (block, tx): a batch of whole blocks closes them all.
  for (const rows of pendingCredits.values()) {
    for (const r of rows) {
      if (r.cls === "UNATTRIBUTED_CREDIT" && r.token === null) {
        s.deferred.push({ kind: "UNMATCHED_SOURCE_CREDIT", detail: `Credit from ${r.depositor} without a matching sweep event`, txHash: r.txHash, asset: r.asset, amount: r.amount.toString() });
      }
    }
  }

  if (events.length) ledger.lastBlock = events[events.length - 1]!.blockNumber;
  const top = events.length ? events[events.length - 1]!.blockNumber : null;
  for (const b of [top, throughBlock ?? null]) if (b !== null && (s.cursor === null || b > s.cursor)) s.cursor = b;
  s.eventCount += events.length;
  return { applied: events.length, skipped };
}

/** The Ledger the fold currently represents. Shares objects with `s`: do not keep applying to `s` if the result is retained. */
export function finalizeFold(s: LedgerFoldState): Ledger {
  return { ...s.ledger, exceptions: [...s.ledger.exceptions, ...s.deferred] };
}

/** Single-batch fold from genesis: equal to buildLedger by construction (pass 1 over the whole history). */
export function foldAll(events: LedgerEvent[], c: LedgerContext, throughBlock?: bigint): LedgerFoldState {
  const s = createFoldState();
  applyEvents(s, events, c, throughBlock);
  return s;
}

// ── Serialization (snapshots) ────────────────────────────────────────────

const replacer = (_k: string, v: unknown) => {
  if (typeof v === "bigint") return { $b: v.toString() };
  if (v instanceof Map) return { $m: [...v] };
  if (v instanceof Set) return { $s: [...v] };
  return v;
};
const reviver = (_k: string, v: unknown) => {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if ("$b" in o && typeof o.$b === "string") return BigInt(o.$b);
    if ("$m" in o && Array.isArray(o.$m)) return new Map(o.$m as Array<[unknown, unknown]>);
    if ("$s" in o && Array.isArray(o.$s)) return new Set(o.$s as unknown[]);
  }
  return v;
};

/** Lossless, order-preserving encoding (Map/Set insertion order and bigints are kept). */
export function encodeFoldState(s: LedgerFoldState): string {
  return JSON.stringify({ v: FOLD_VERSION, s }, replacer);
}

export function decodeFoldState(text: string): LedgerFoldState {
  const o = JSON.parse(text, reviver) as { v: number; s: LedgerFoldState };
  if (o.v !== FOLD_VERSION) throw new Error(`fold state version ${o.v} != ${FOLD_VERSION}`);
  return o.s;
}

export function cloneFoldState(s: LedgerFoldState): LedgerFoldState {
  return decodeFoldState(encodeFoldState(s));
}

/** Canonical JSON: object keys sorted, Map/array order kept, bigints tagged. */
function canonicalJson(v: unknown): string {
  if (typeof v === "bigint") return `{"$b":"${v.toString()}"}`;
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (v instanceof Map) return `{"$m":[${[...v].map(([k, x]) => `[${canonicalJson(k)},${canonicalJson(x)}]`).join(",")}]}`;
  if (v instanceof Set) return `{"$s":[${[...v].map(canonicalJson).join(",")}]}`;
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

/** Deterministic digest of a Ledger (every field, order-sensitive where the ledger is). */
export function ledgerDigest(l: Ledger): string {
  return createHash("sha256").update(canonicalJson(l)).digest("hex");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
