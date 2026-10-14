/**
 * W04 financial ledger — a PURE, deterministic projection over the W03
 * indexer's canonical `chain_events` (no second source of truth).
 *
 * Inputs are allowlisted events from the Forge factory, its curves, the
 * shared hook, the canonical PonsV2FeeEscrow, the buyback vault and the
 * ForgeProtocolRevenueSplitter. Events are de-duplicated by identity
 * (blockHash, logIndex) and ordered by (block, logIndex) before folding, so
 * duplicate delivery or arbitrary input order yields the identical ledger.
 * A reorg deletes orphaned events in the indexer; re-running this projection
 * is the whole reorg story.
 *
 * Attribution rules (never manufactured from aggregate balances):
 *  - An escrow credit is attributed to a launch ONLY through its depositor:
 *    a Forge curve (curve → token from TokenLaunched), or the hook together
 *    with the PoolFeesSwept of the SAME transaction (poolId → token from
 *    PoolRegistered). The buyback vault's credits are vest releases of the
 *    launch token itself. Anything else is UNATTRIBUTED.
 *  - Protocol vs creator leg is taken from the sweep event of the same
 *    transaction (curve: protocol credited first; hook: creator first).
 *  - Creator tax is split from base fee using the per-trade `tax` the curve
 *    and hook emit since the previous sweep. A hook sweep that converted
 *    memecoin-denominated tax is reported UNSPLIT (base+tax), never guessed.
 */
import { getAddress, type Address } from "viem";

export const NATIVE: Address = "0x0000000000000000000000000000000000000000";

export interface LedgerEvent {
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
  address: Address;
  eventName: string;
  args: Record<string, string>;
  blockTimestamp: bigint;
}

export interface LedgerContext {
  factory: Address;
  hook: Address;
  escrow: Address;
  vault: Address;
  splitter: Address | null;
  /** Sends post-mint residual quote ("dust") to the protocol recipient at graduation. */
  graduationExecutor?: Address | null;
}

export type CreditClass =
  | "PROTOCOL_BASE_FEE"
  | "CREATOR_FEE"
  | "VEST_RELEASE_PROTOCOL"
  | "VEST_RELEASE_CREATOR"
  | "UNATTRIBUTED_CREDIT";

export interface CreditRow {
  id: string;
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
  timestamp: bigint;
  recipient: Address;
  depositor: Address;
  asset: Address;
  amount: bigint;
  source: "curve" | "hook" | "vault" | "third_party";
  token: Address | null;
  cls: CreditClass;
  /** Creator credits only: base / tax split, or null when unsplittable. */
  base: bigint | null;
  tax: bigint | null;
}

export interface ClaimRow {
  id: string;
  blockNumber: bigint;
  txHash: string;
  timestamp: bigint;
  recipient: Address;
  asset: Address;
  amount: bigint;
}

/** Per launch, per asset (the launch's quote asset unless stated). */
export interface TokenFees {
  token: Address;
  curve: Address;
  creator: Address;
  pairToken: Address;
  poolId: string | null;
  // curve phase (quote asset)
  curveBaseFees: bigint; // includes the snipe-tax component
  curveSnipeTax: bigint;
  curveCreatorTax: bigint;
  curveSweeps: number;
  curveBuybackSpent: bigint;
  curveTokensLocked: bigint;
  // hook phase
  hookBaseFeesQuote: bigint;
  hookCreatorTaxQuote: bigint;
  hookBaseFeesMemecoin: bigint; // memecoin units, pending conversion at accrual time
  hookCreatorTaxMemecoin: bigint;
  hookSweeps: number;
  hookBuybackSpent: bigint;
  hookTokensLocked: bigint;
  // escrow credits attributed to this launch (quote asset)
  protocolCredited: bigint;
  protocolCreditedTo: Address[];
  creatorCredited: bigint;
  creatorBaseCredited: bigint;
  creatorTaxCredited: bigint;
  creatorUnsplitCredited: bigint;
  // direct (escrow-bypassing) owner rescues — F-04
  rescuedProtocol: bigint;
  rescuedCreator: bigint;
  // buyback vault (launch-token units)
  vestLocked: bigint;
  vestReleasedCreator: bigint;
  vestReleasedProtocol: bigint;
}

export interface SplitterAllocation {
  id: string;
  allocationId: bigint;
  blockNumber: bigint;
  txHash: string;
  timestamp: bigint;
  asset: Address;
  received: bigint;
  toTreasury: bigint;
  toReserve: bigint;
  policyVersion: number;
}

export interface SplitterAssetTotals {
  asset: Address;
  revenueReceived: bigint;
  treasuryAllocated: bigint;
  reserveAllocated: bigint;
  treasuryPaid: bigint;
  nonRevenueReceived: bigint;
  nonRevenueReleased: bigint;
  launchFees: bigint;
  graduationResidual: bigint;
  unattributedNative: bigint;
  unattributedToken: bigint;
}

export interface GovernanceEvent {
  blockNumber: bigint;
  txHash: string;
  timestamp: bigint;
  contract: "factory" | "hook" | "splitter" | "curve" | "vault";
  address: Address;
  eventName: string;
  args: Record<string, string>;
}

export interface LedgerException {
  kind: string;
  detail: string;
  txHash?: string;
  asset?: Address;
  amount?: string;
}

export interface Ledger {
  credits: CreditRow[];
  claims: ClaimRow[];
  tokens: Map<Address, TokenFees>;
  allocations: SplitterAllocation[];
  splitterTotals: Map<Address, SplitterAssetTotals>;
  treasuryClaims: ClaimRow[];
  governance: GovernanceEvent[];
  exceptions: LedgerException[];
  /** Indexed escrow balance per recipient/asset = credits − claims. */
  escrowBalances: Map<string, bigint>;
  lastBlock: bigint | null;
}

const NON_REVENUE_CLASS = ["LaunchFee", "UnattributedNative", "UnattributedToken"] as const;

const GOVERNANCE_EVENTS: Record<string, Set<string>> = {
  factory: new Set([
    "LaunchFeeUpdated",
    "MaxCreatorTaxUpdated",
    "SnipeTaxStartBpsUpdated",
    "SnipeTaxSecondsUpdated",
    "PairTokenApprovalUpdated",
    "PairTokenEconomicsUpdated",
    "LaunchForwarderSet",
    "CreatorFeeRecipientChangeProposed",
    "CreatorFeeRecipientChangeCancelled",
    "CreatorFeeRecipientUpdated",
    "BuybackEnabledUpdated",
    "LaunchGraduationRescued",
    "LaunchForceSwept",
    "OwnershipTransferred",
    "OwnershipTransferStarted",
  ]),
  hook: new Set([
    "ProtocolFeeShareUpdated",
    "BuybackBurnBpsUpdated",
    "HookFeeBpsUpdated",
    "MaxInternalPriceImpactUpdated",
    "ProtocolFeeRecipientUpdated",
    "FeeSweepOperatorUpdated",
    "PoolFeesRescued",
    "OwnershipTransferred",
    "OwnershipTransferStarted",
  ]),
  splitter: new Set([
    "ForgeFactorySet",
    "AssetApprovalUpdated",
    "PullsPausedUpdated",
    "TreasuryRecipientChangeProposed",
    "TreasuryRecipientChangeCancelled",
    "TreasuryRecipientUpdated",
    "NonRevenueReleased",
    "OwnershipTransferred",
    "OwnershipTransferStarted",
  ]),
  curve: new Set(["FeesRescued", "CreatorFeeRecipientUpdated", "BuybackEnabledUpdated"]),
  vault: new Set(["CreatorRecipientUpdated"]),
};

const big = (v: string | undefined) => BigInt(v ?? "0");
const addr = (v: string | undefined) => getAddress(v ?? NATIVE);
const key = (recipient: Address, asset: Address) => `${recipient}:${asset}`;

function emptyTokenFees(token: Address, curve: Address, creator: Address, pairToken: Address): TokenFees {
  return {
    token,
    curve,
    creator,
    pairToken,
    poolId: null,
    curveBaseFees: 0n,
    curveSnipeTax: 0n,
    curveCreatorTax: 0n,
    curveSweeps: 0,
    curveBuybackSpent: 0n,
    curveTokensLocked: 0n,
    hookBaseFeesQuote: 0n,
    hookCreatorTaxQuote: 0n,
    hookBaseFeesMemecoin: 0n,
    hookCreatorTaxMemecoin: 0n,
    hookSweeps: 0,
    hookBuybackSpent: 0n,
    hookTokensLocked: 0n,
    protocolCredited: 0n,
    protocolCreditedTo: [],
    creatorCredited: 0n,
    creatorBaseCredited: 0n,
    creatorTaxCredited: 0n,
    creatorUnsplitCredited: 0n,
    rescuedProtocol: 0n,
    rescuedCreator: 0n,
    vestLocked: 0n,
    vestReleasedCreator: 0n,
    vestReleasedProtocol: 0n,
  };
}

function emptySplitter(asset: Address): SplitterAssetTotals {
  return {
    asset,
    revenueReceived: 0n,
    treasuryAllocated: 0n,
    reserveAllocated: 0n,
    treasuryPaid: 0n,
    nonRevenueReceived: 0n,
    nonRevenueReleased: 0n,
    launchFees: 0n,
    graduationResidual: 0n,
    unattributedNative: 0n,
    unattributedToken: 0n,
  };
}

/** Canonical order + identity de-duplication. */
export function canonicalize(events: LedgerEvent[]): LedgerEvent[] {
  const seen = new Map<string, LedgerEvent>();
  for (const e of events) seen.set(`${e.blockHash.toLowerCase()}:${e.logIndex}`, e);
  return [...seen.values()].sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
  );
}

export function buildLedger(input: LedgerEvent[], c: LedgerContext): Ledger {
  const events = canonicalize(input);
  const ledger: Ledger = {
    credits: [],
    claims: [],
    tokens: new Map(),
    allocations: [],
    splitterTotals: new Map(),
    treasuryClaims: [],
    governance: [],
    exceptions: [],
    escrowBalances: new Map(),
    lastBlock: events.length ? events[events.length - 1]!.blockNumber : null,
  };
  const curveToken = new Map<Address, Address>();
  const poolToken = new Map<string, Address>();
  const curveTaxAcc = new Map<Address, bigint>();
  const hookTaxQuoteAcc = new Map<string, bigint>();
  const hookTaxMemeAcc = new Map<string, bigint>();
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

  // Pass 1: launches and pools (needed before credits in the same tx).
  for (const e of events) {
    if (e.address === c.factory && e.eventName === "TokenLaunched") {
      const token = addr(e.args.token);
      const curve = addr(e.args.curve);
      curveToken.set(curve, token);
      ledger.tokens.set(token, emptyTokenFees(token, curve, addr(e.args.deployer), addr(e.args.pairToken)));
    }
    if (e.address === c.hook && e.eventName === "PoolRegistered") {
      const token = addr(e.args.memecoin);
      poolToken.set(String(e.args.poolId).toLowerCase(), token);
      const t = ledger.tokens.get(token);
      if (t) t.poolId = String(e.args.poolId).toLowerCase();
    }
  }

  // Credits awaiting leg assignment, keyed by tx + depositor.
  const pendingCredits = new Map<string, CreditRow[]>();

  for (const e of events) {
    const role = roleOf(e.address);
    if (role && GOVERNANCE_EVENTS[role]?.has(e.eventName)) {
      ledger.governance.push({ blockNumber: e.blockNumber, txHash: e.txHash, timestamp: e.blockTimestamp, contract: role, address: e.address, eventName: e.eventName, args: e.args });
    }

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
        const skipped = tx.some((x) => x.address === c.hook && x.eventName === "PoolConversionSkipped" && String(x.args.poolId).toLowerCase() === pid);
        assignLegs(ledger, pendingCredits, e, "hook", t, big(e.args.protocolAmount), big(e.args.creatorAmount), hookTaxQuoteAcc.get(pid) ?? 0n, converted && !skipped);
        hookTaxQuoteAcc.set(pid, 0n);
        if (!skipped) hookTaxMemeAcc.set(pid, 0n);
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
      if (!t) continue;
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
          row.cls = c.splitter && recipient === c.splitter ? "VEST_RELEASE_PROTOCOL" : "VEST_RELEASE_CREATOR";
        } else if (c.splitter && recipient === c.splitter) {
          ledger.exceptions.push({
            kind: "THIRD_PARTY_CREDIT_TO_SPLITTER",
            detail: `Escrow credit to the splitter key by ${depositor}: not fee revenue (indistinguishable on chain; excluded here)`,
            txHash: e.txHash,
            asset,
            amount: amount.toString(),
          });
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
          received: big(e.args.received),
          toTreasury: big(e.args.toTreasury),
          toReserve: big(e.args.toReserve),
          policyVersion: Number(e.args.policyVersion),
        };
        ledger.allocations.push(a);
        const s = splitterTotals(asset);
        s.revenueReceived += a.received;
        s.treasuryAllocated += a.toTreasury;
        s.reserveAllocated += a.toReserve;
      } else if (e.eventName === "NonRevenueReceived") {
        const asset = addr(e.args.asset);
        const s = splitterTotals(asset);
        const amount = big(e.args.amount);
        s.nonRevenueReceived += amount;
        const cls = NON_REVENUE_CLASS[Number(e.args.cls)] ?? "UnattributedNative";
        const from = addr(e.args.from);
        if (cls === "LaunchFee") s.launchFees += amount;
        else if (c.graduationExecutor && from === c.graduationExecutor) s.graduationResidual += amount;
        else if (cls === "UnattributedNative") s.unattributedNative += amount;
        else s.unattributedToken += amount;
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

  for (const rows of pendingCredits.values()) {
    for (const r of rows) {
      if (r.cls === "UNATTRIBUTED_CREDIT" && r.token === null) {
        ledger.exceptions.push({ kind: "UNMATCHED_SOURCE_CREDIT", detail: `Credit from ${r.depositor} without a matching sweep event`, txHash: r.txHash, asset: r.asset, amount: r.amount.toString() });
      }
    }
  }
  return ledger;
}

/**
 * Assigns the protocol and creator legs of one sweep to the escrow credits the
 * same source made earlier in the same transaction. Curve credits protocol
 * then creator; the hook credits creator then protocol. Fee-on-transfer quote
 * assets credit less than nominal, so legs are matched by ORDER, and the
 * credited (actual) amounts are what the ledger records.
 */
function assignLegs(
  ledger: Ledger,
  pending: Map<string, CreditRow[]>,
  sweep: LedgerEvent,
  source: "curve" | "hook",
  t: TokenFees,
  protocolNominal: bigint,
  creatorNominal: bigint,
  taxAcc: bigint,
  unsplit: boolean,
) {
  const k = `${sweep.blockHash}:${sweep.txHash}:${sweep.address}`;
  const rows = (pending.get(k) ?? []).filter((r) => r.logIndex < sweep.logIndex && r.token === null);
  const order: Array<"protocol" | "creator"> = [];
  if (source === "curve") {
    if (protocolNominal > 0n) order.push("protocol");
    if (creatorNominal > 0n) order.push("creator");
  } else {
    if (creatorNominal > 0n) order.push("creator");
    if (protocolNominal > 0n) order.push("protocol");
  }
  const take = rows.slice(-order.length);
  take.forEach((r, i) => {
    r.token = t.token;
    if (order[i] === "protocol") {
      r.cls = "PROTOCOL_BASE_FEE";
      t.protocolCredited += r.amount;
      if (!t.protocolCreditedTo.includes(r.recipient)) t.protocolCreditedTo.push(r.recipient);
    } else {
      r.cls = "CREATOR_FEE";
      t.creatorCredited += r.amount;
      if (unsplit) {
        t.creatorUnsplitCredited += r.amount;
      } else {
        const tax = taxAcc < r.amount ? taxAcc : r.amount;
        r.tax = tax;
        r.base = r.amount - tax;
        t.creatorTaxCredited += tax;
        t.creatorBaseCredited += r.amount - tax;
      }
    }
  });
  if (take.length !== order.length) {
    ledger.exceptions.push({ kind: "SWEEP_CREDIT_MISMATCH", detail: `${source} sweep for ${t.token} expected ${order.length} escrow credits, found ${take.length}`, txHash: sweep.txHash });
  }
}

/** Applies the splitter's 2:1 rule to an exactly attributed protocol amount (display only; on-chain rounding is cumulative per asset). */
export function derivedTreasuryReserve(protocol: bigint): { treasury: bigint; reserve: bigint } {
  const reserve = protocol / 3n;
  return { treasury: protocol - reserve, reserve };
}
