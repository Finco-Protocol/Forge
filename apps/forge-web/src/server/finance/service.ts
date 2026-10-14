/**
 * W04 economics, treasury and governance views.
 *
 * Every figure is one of three explicitly labelled evidence classes:
 *   INDEXED   — folded from canonical chain events (buildLedger),
 *   ONCHAIN   — read from contract state AT THE INDEXER CHECKPOINT block,
 *               so it is directly comparable with INDEXED,
 *   LIVE      — read at the latest block (accrued-but-unswept buckets,
 *               vesting), never mixed into realised totals.
 * Amounts are per asset (base units + decimals); different assets are never
 * summed and no exchange rate is ever applied.
 */
import { encodeFunctionData, erc20Abi, getAddress, isAddress, keccak256, encodeAbiParameters, type Address, type Hex } from "viem";
import {
  forgeProtocolRevenueSplitterAbi,
  ponsV2BondingCurveAbi,
  ponsV2BuybackVaultAbi,
  ponsV2FeeEscrowAbi,
  ponsV2LaunchFactoryAbi,
  ponsV2MemeHookAbi,
} from "@/shared/abis.generated";
import type { AppContext } from "../context";
import { refuse } from "../errors";
import { checkpointName } from "../indexer/indexer";
import { buildLedger, derivedTreasuryReserve, NATIVE, type Ledger, type LedgerEvent } from "./ledger";
import { PRODUCTION_BLOCKED, FORGE_FEE_POLICY_AUTHORITY_UNPROVEN } from "../config";

export const FINCO_BURN_ENABLED = false;
/** Default eligible policy: 30% protocol leg, split 2:1 → 70 / 20 / 10 of the base fee. */
export const ELIGIBLE_PROTOCOL_SHARE_BPS = 3_000;

const s = (v: bigint | null | undefined) => (v === null || v === undefined ? null : v.toString());

export interface AssetInfo {
  asset: Address;
  symbol: string;
  decimals: number;
  native: boolean;
}

const assetCache = new Map<string, AssetInfo>();
export async function assetInfo(ctx: AppContext, asset: Address): Promise<AssetInfo> {
  if (asset === NATIVE) return { asset, symbol: "ETH", decimals: 18, native: true };
  const k = `${ctx.cfg.chainId}:${asset}`;
  const hit = assetCache.get(k);
  if (hit) return hit;
  const [symbol, decimals] = await Promise.all([
    ctx.client.readContract({ address: asset, abi: erc20Abi, functionName: "symbol" }).catch(() => "UNKNOWN"),
    ctx.client.readContract({ address: asset, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
  ]);
  const info = { asset, symbol: String(symbol), decimals: Number(decimals), native: false };
  assetCache.set(k, info);
  return info;
}

export async function indexerState(ctx: AppContext) {
  const { rows } = await ctx.db.query<{ last_block: string; updated_at: Date }>(
    "SELECT last_block::text, updated_at FROM indexer_checkpoints WHERE name = $1",
    [checkpointName(ctx)],
  );
  const head = await ctx.client.getBlockNumber({ cacheTime: 0 }).catch(() => null);
  const last = rows[0] ? BigInt(rows[0].last_block) : null;
  return {
    lastIndexedBlock: s(last),
    headBlock: s(head),
    lagBlocks: last !== null && head !== null ? s(head - last) : null,
    updatedAt: rows[0]?.updated_at ?? null,
    confirmations: ctx.cfg.confirmations,
  };
}

export async function loadLedger(ctx: AppContext): Promise<{ ledger: Ledger; checkpoint: bigint | null }> {
  const a = ctx.cfg.addresses;
  const { rows } = await ctx.db.query<{
    block_number: string;
    block_hash: string;
    tx_hash: string;
    log_index: number;
    address: string;
    event_name: string;
    args: Record<string, string>;
    block_timestamp: string;
  }>("SELECT block_number::text, block_hash, tx_hash, log_index, address, event_name, args, block_timestamp::text FROM chain_events WHERE chain_id = $1", [ctx.cfg.chainId]);
  const events: LedgerEvent[] = rows.map((r) => ({
    blockNumber: BigInt(r.block_number),
    blockHash: r.block_hash,
    txHash: r.tx_hash,
    logIndex: r.log_index,
    address: getAddress(r.address),
    eventName: r.event_name,
    args: r.args,
    blockTimestamp: BigInt(r.block_timestamp),
  }));
  const ledger = buildLedger(events, {
    factory: a.factory,
    hook: a.memeHook,
    escrow: a.feeEscrow ?? NATIVE,
    vault: a.buybackVault ?? NATIVE,
    splitter: a.revenueSplitter,
    graduationExecutor: a.graduationExecutor,
  });
  const cp = await ctx.db.query<{ last_block: string }>("SELECT last_block::text FROM indexer_checkpoints WHERE name = $1", [checkpointName(ctx)]);
  return { ledger, checkpoint: cp.rows[0] ? BigInt(cp.rows[0].last_block) : null };
}

/** V4 PoolId of a graduated Forge launch, recomputed from its key (no trust in stored ids). */
export function poolIdFor(token: Address, pairToken: Address, fee: number, tickSpacing: number, hook: Address): Hex {
  const [c0, c1] = BigInt(pairToken) < BigInt(token) ? [pairToken, token] : [token, pairToken];
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [c0, c1, fee, tickSpacing, hook],
    ),
  );
}

interface LaunchState {
  token: Address;
  curve: Address;
  deployer: Address;
  creatorFeeRecipient: Address;
  pairToken: Address;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  phase: number;
  poolFee: number;
  tickSpacing: number;
  policy: { protocolFeeRecipient: Address; protocolFeeShareBps: number; buybackBurnBps: number; hookFeeBps: number };
}

async function readLaunch(ctx: AppContext, token: Address, blockNumber?: bigint): Promise<LaunchState> {
  const f = { address: ctx.cfg.addresses.factory, abi: ponsV2LaunchFactoryAbi } as const;
  const at = blockNumber !== undefined ? { blockNumber } : {};
  const [l, p] = await Promise.all([
    ctx.client.readContract({ ...f, functionName: "getLaunchedToken", args: [token], ...at }),
    ctx.client.readContract({ ...f, functionName: "getLaunchFeePolicy", args: [token], ...at }),
  ]);
  return {
    token,
    curve: l.curve,
    deployer: l.deployer,
    creatorFeeRecipient: l.creatorFeeRecipient,
    pairToken: l.pairToken,
    creatorTaxBps: Number(l.creatorTaxBps),
    buybackEnabled: l.buybackEnabled,
    phase: Number(l.phase),
    poolFee: Number(l.poolFee),
    tickSpacing: Number(l.tickSpacing),
    policy: { protocolFeeRecipient: p.protocolFeeRecipient, protocolFeeShareBps: Number(p.protocolFeeShareBps), buybackBurnBps: Number(p.buybackBurnBps), hookFeeBps: Number(p.hookFeeBps) },
  };
}

/** Fail-closed eligibility for the 70/20/10 claim: the launch's FROZEN snapshot must name the splitter at 30%. */
export function eligibility(ctx: AppContext, l: LaunchState) {
  const splitter = ctx.cfg.addresses.revenueSplitter;
  const reasons: string[] = [];
  if (!splitter) reasons.push("No Forge revenue splitter is configured.");
  else if (l.policy.protocolFeeRecipient !== splitter) reasons.push(`Protocol leg routes to ${l.policy.protocolFeeRecipient}, not the Forge splitter.`);
  if (l.policy.protocolFeeShareBps !== ELIGIBLE_PROTOCOL_SHARE_BPS) reasons.push(`Frozen protocol share is ${l.policy.protocolFeeShareBps / 100}%, not 30%.`);
  const eligible = reasons.length === 0;
  const share = l.policy.protocolFeeShareBps;
  const creatorPct = (10_000 - share) / 100;
  // Effective creator CASH share when buyback-and-lock is on: part of the creator bucket buys and vests tokens.
  const buybackPct = l.buybackEnabled ? ((10_000 - share) * l.policy.buybackBurnBps) / 10_000 / 100 : 0;
  return {
    eligible70_20_10: eligible,
    reasons,
    actual: {
      creatorPct,
      creatorCashPct: creatorPct - buybackPct,
      creatorBuybackLockPct: buybackPct,
      protocolPct: share / 100,
      treasuryPct: splitter && l.policy.protocolFeeRecipient === splitter ? ((share * 2) / 3) / 100 : null,
      reservePct: splitter && l.policy.protocolFeeRecipient === splitter ? share / 3 / 100 : null,
      creatorTaxPct: l.creatorTaxBps / 100,
      creatorTaxNote: "Creator tax is paid 100% to the creator and is never part of the 70/20/10 split.",
    },
  };
}

async function liveAccrued(ctx: AppContext, l: LaunchState) {
  try {
    if (l.phase === 0) {
      const c = { address: l.curve, abi: ponsV2BondingCurveAbi } as const;
      const [fee, tax, buyback] = await Promise.all([
        ctx.client.readContract({ ...c, functionName: "quoteFeeBalance" }),
        ctx.client.readContract({ ...c, functionName: "creatorTaxBalance" }),
        ctx.client.readContract({ ...c, functionName: "buybackQuoteBalance" }),
      ]);
      const protocol = (fee * BigInt(l.policy.protocolFeeShareBps)) / 10_000n;
      return { origin: "bonding_curve", asset: l.pairToken, baseFee: s(fee), creatorTax: s(tax), buybackEarmark: s(buyback), estProtocol: s(protocol), estCreatorCash: s(fee - protocol - buyback + tax) };
    }
    if (l.phase === 2) {
      const pid = poolIdFor(l.token, l.pairToken, l.poolFee, l.tickSpacing, ctx.cfg.addresses.memeHook);
      const h = { address: ctx.cfg.addresses.memeHook, abi: ponsV2MemeHookAbi } as const;
      const [fee, tax, buyback, memeFee, memeTax] = await Promise.all([
        ctx.client.readContract({ ...h, functionName: "pendingFees", args: [pid, l.pairToken] }),
        ctx.client.readContract({ ...h, functionName: "pendingCreatorTax", args: [pid, l.pairToken] }),
        ctx.client.readContract({ ...h, functionName: "pendingBuyback", args: [pid, l.pairToken] }),
        ctx.client.readContract({ ...h, functionName: "pendingFees", args: [pid, l.token] }),
        ctx.client.readContract({ ...h, functionName: "pendingCreatorTax", args: [pid, l.token] }),
      ]);
      const protocol = (fee * BigInt(l.policy.protocolFeeShareBps)) / 10_000n;
      return {
        origin: "v4_hook",
        asset: l.pairToken,
        baseFee: s(fee),
        creatorTax: s(tax),
        buybackEarmark: s(buyback),
        estProtocol: s(protocol),
        estCreatorCash: s(fee - protocol - buyback + tax),
        pendingConversionMemecoin: { asset: l.token, baseFee: s(memeFee), creatorTax: s(memeTax) },
      };
    }
  } catch (e) {
    return { origin: "unavailable", error: (e as Error).message.split("\n")[0] };
  }
  return { origin: "none" };
}

async function liveVest(ctx: AppContext, token: Address) {
  const v = ctx.cfg.addresses.buybackVault;
  if (!v) return null;
  const c = { address: v, abi: ponsV2BuybackVaultAbi } as const;
  try {
    const [locked, released, releasable, vested, start] = await Promise.all([
      ctx.client.readContract({ ...c, functionName: "totalLocked", args: [token] }),
      ctx.client.readContract({ ...c, functionName: "totalReleased", args: [token] }),
      ctx.client.readContract({ ...c, functionName: "releasable", args: [token] }),
      ctx.client.readContract({ ...c, functionName: "vestedAmount", args: [token] }),
      ctx.client.readContract({ ...c, functionName: "vestingStart", args: [token] }),
    ]);
    return { asset: token, totalLocked: s(locked), totalReleased: s(released), releasable: s(releasable), vested: s(vested), vestingStart: s(start), schedule: "PONS five-year linear vest (project token, NOT the FINCO reserve)" };
  } catch {
    return null;
  }
}

async function escrowBalanceAt(ctx: AppContext, recipient: Address, asset: Address, blockNumber?: bigint): Promise<bigint | null> {
  const e = ctx.cfg.addresses.feeEscrow;
  if (!e) return null;
  const at = blockNumber !== undefined ? { blockNumber } : {};
  try {
    return asset === NATIVE
      ? await ctx.client.readContract({ address: e, abi: ponsV2FeeEscrowAbi, functionName: "balanceOf", args: [recipient], ...at })
      : await ctx.client.readContract({ address: e, abi: ponsV2FeeEscrowAbi, functionName: "balanceOfToken", args: [recipient, asset], ...at });
  } catch {
    return null;
  }
}

// ── Creator earnings ─────────────────────────────────────────────────────

export async function creatorEarnings(ctx: AppContext, wallet: Address) {
  const { ledger, checkpoint } = await loadLedger(ctx);
  const tokens = [...ledger.tokens.values()];
  const launches: Array<Record<string, unknown>> = [];
  for (const t of tokens) {
    const l = await readLaunch(ctx, t.token);
    if (l.deployer !== wallet && l.creatorFeeRecipient !== wallet) continue;
    const mine = ledger.credits.filter((c) => c.token === t.token && c.recipient === wallet && c.cls === "CREATOR_FEE");
    const sum = (f: (c: (typeof mine)[number]) => bigint) => mine.reduce((acc, c) => acc + f(c), 0n);
    launches.push({
      token: t.token,
      curve: t.curve,
      quoteAsset: await assetInfo(ctx, t.pairToken),
      phase: l.phase,
      isCurrentRecipient: l.creatorFeeRecipient === wallet,
      creatorFeeRecipient: l.creatorFeeRecipient,
      policySnapshot: { ...l.policy, creatorTaxBps: l.creatorTaxBps, buybackEnabled: l.buybackEnabled },
      economics: eligibility(ctx, l),
      earnedIndexed: {
        credited: s(sum((c) => c.amount)),
        baseFee: s(sum((c) => c.base ?? 0n)),
        creatorTax: s(sum((c) => c.tax ?? 0n)),
        unsplit: s(mine.filter((c) => c.base === null).reduce((a, c) => a + c.amount, 0n)),
        byOrigin: {
          bondingCurve: s(mine.filter((c) => c.source === "curve").reduce((a, c) => a + c.amount, 0n)),
          v4Hook: s(mine.filter((c) => c.source === "hook").reduce((a, c) => a + c.amount, 0n)),
        },
      },
      rescuedDirect: { creator: s(t.rescuedCreator), protocol: s(t.rescuedProtocol), note: "Owner rescue (F-04) paid directly, outside the escrow." },
      accruedUnswept: l.creatorFeeRecipient === wallet ? await liveAccrued(ctx, l) : null,
      buybackLock: await liveVest(ctx, t.token),
    });
  }
  // Per asset: credited (by class), claimed, indexed balance, on-chain claimable.
  const assets = new Set<Address>();
  for (const c of ledger.credits) if (c.recipient === wallet) assets.add(c.asset);
  for (const c of ledger.claims) if (c.recipient === wallet) assets.add(c.asset);
  const perAsset = [];
  for (const asset of assets) {
    const credits = ledger.credits.filter((c) => c.recipient === wallet && c.asset === asset);
    const claimed = ledger.claims.filter((c) => c.recipient === wallet && c.asset === asset).reduce((a, c) => a + c.amount, 0n);
    const byCls = (cls: string) => credits.filter((c) => c.cls === cls).reduce((a, c) => a + c.amount, 0n);
    const indexedBalance = ledger.escrowBalances.get(`${wallet}:${asset}`) ?? 0n;
    const onchainAtCheckpoint = checkpoint !== null ? await escrowBalanceAt(ctx, wallet, asset, checkpoint) : null;
    const claimableNow = await escrowBalanceAt(ctx, wallet, asset);
    perAsset.push({
      asset: await assetInfo(ctx, asset),
      lifetimeCredited: s(credits.reduce((a, c) => a + c.amount, 0n)),
      creatorFees: s(byCls("CREATOR_FEE")),
      creatorTaxIncluded: s(credits.reduce((a, c) => a + (c.tax ?? 0n), 0n)),
      vestReleases: s(byCls("VEST_RELEASE_CREATOR")),
      unattributedCredits: s(byCls("UNATTRIBUTED_CREDIT")),
      claimed: s(claimed),
      claimableIndexed: s(indexedBalance),
      claimableOnchainAtCheckpoint: s(onchainAtCheckpoint),
      claimableNow: s(claimableNow),
      reconciliation: onchainAtCheckpoint === null ? "NOT_AVAILABLE" : onchainAtCheckpoint === indexedBalance ? "RECONCILED" : "MISMATCH",
    });
  }
  const history = ledger.claims.filter((c) => c.recipient === wallet).map((c) => ({ txHash: c.txHash, block: s(c.blockNumber), timestamp: s(c.timestamp), asset: c.asset, amount: s(c.amount) }));
  const submissions = (
    await ctx.db.query<{ tx_hash: string; asset: string; kind: string; created_at: Date }>(
      "SELECT tx_hash, asset, kind, created_at FROM fin_claim_submissions WHERE wallet = $1 ORDER BY created_at DESC LIMIT 50",
      [wallet],
    )
  ).rows;
  const pending = [];
  for (const sub of submissions) pending.push({ ...sub, status: await submissionStatus(ctx, ledger, sub.tx_hash) });
  return {
    wallet,
    escrow: ctx.cfg.addresses.feeEscrow,
    launches,
    perAsset,
    claimHistory: history,
    claimSubmissions: pending,
    indexer: await indexerState(ctx),
    notes: [
      "Amounts are per asset; different assets are never added together.",
      "Claims are signed by the entitled recipient's own wallet against the canonical PonsV2FeeEscrow; Forge never custodies keys.",
      "ACCRUED/UNSWEPT figures are live contract buckets, not realised earnings, and estimate the split under the launch's frozen snapshot.",
    ],
  };
}

async function submissionStatus(ctx: AppContext, ledger: Ledger, txHash: string) {
  const indexed = ledger.claims.some((c) => c.txHash === txHash) || ledger.treasuryClaims.some((c) => c.txHash === txHash);
  if (indexed) return { state: "CONFIRMED_INDEXED" };
  try {
    const r = await ctx.client.getTransactionReceipt({ hash: txHash as Hex });
    if (r.status === "reverted") return { state: "FAILED", recovery: "The claim reverted (nothing moved). Check the claimable balance and amount, then prepare a new claim." };
    return { state: "MINED_AWAITING_INDEXER", block: s(r.blockNumber) };
  } catch {
    return { state: "PENDING", recovery: "Not yet mined. If it never confirms, replace it from your wallet; a duplicate claim cannot over-pay (the escrow debits the balance first)." };
  }
}

// ── Claims (preparation only: the recipient signs and sends) ─────────────

export async function prepareClaim(ctx: AppContext, wallet: Address, body: { asset?: string; amount?: string; kind?: string }) {
  const asset = body.asset && isAddress(body.asset) ? getAddress(body.asset) : NATIVE;
  const amount = body.amount !== undefined && /^[0-9]+$/.test(String(body.amount)) ? BigInt(body.amount) : 0n;
  const kind = body.kind === "treasury" ? "treasury" : "escrow";
  if (kind === "escrow") {
    const escrow = ctx.cfg.addresses.feeEscrow;
    if (!escrow) refuse("NOT_CONFIGURED", "No canonical escrow is configured.", 409);
    const balance = (await escrowBalanceAt(ctx, wallet, asset)) ?? 0n;
    if (balance === 0n) refuse("NOTHING_TO_CLAIM", "This wallet has no claimable escrow balance in this asset.", 409);
    if (amount > balance) refuse("AMOUNT_EXCEEDS_BALANCE", "Requested amount exceeds the claimable balance.", 409);
    const data =
      asset === NATIVE
        ? amount === 0n
          ? encodeFunctionData({ abi: ponsV2FeeEscrowAbi, functionName: "claim", args: [] })
          : encodeFunctionData({ abi: ponsV2FeeEscrowAbi, functionName: "claim", args: [amount] })
        : amount === 0n
          ? encodeFunctionData({ abi: ponsV2FeeEscrowAbi, functionName: "claimToken", args: [asset] })
          : encodeFunctionData({ abi: ponsV2FeeEscrowAbi, functionName: "claimToken", args: [asset, amount] });
    return {
      kind,
      from: wallet,
      to: escrow!,
      data,
      value: "0",
      asset: await assetInfo(ctx, asset),
      amount: (amount === 0n ? balance : amount).toString(),
      claimableNow: balance.toString(),
      notice: "Sign and send from the recipient wallet. The escrow pays msg.sender only; nobody can claim on your behalf.",
    };
  }
  const splitter = ctx.cfg.addresses.revenueSplitter;
  if (!splitter) refuse("NOT_CONFIGURED", "No Forge revenue splitter is configured.", 409);
  const sp = { address: splitter!, abi: forgeProtocolRevenueSplitterAbi } as const;
  const recipient = await ctx.client.readContract({ ...sp, functionName: "treasuryRecipient" });
  if (recipient !== wallet) refuse("NOT_TREASURY_RECIPIENT", "Only the splitter's treasury recipient can claim treasury funds.", 403);
  const liability = await ctx.client.readContract({ ...sp, functionName: "treasuryLiability", args: [asset] });
  if (liability === 0n) refuse("NOTHING_TO_CLAIM", "No treasury liability in this asset.", 409);
  if (amount > liability) refuse("AMOUNT_EXCEEDS_BALANCE", "Requested amount exceeds the treasury liability.", 409);
  return {
    kind,
    from: wallet,
    to: splitter!,
    data: encodeFunctionData({ abi: forgeProtocolRevenueSplitterAbi, functionName: "claimTreasury", args: [asset, amount] }),
    value: "0",
    asset: await assetInfo(ctx, asset),
    amount: (amount === 0n ? liability : amount).toString(),
    claimableNow: liability.toString(),
    notice: "Treasury claims never touch the FINCO reserve, which has no withdrawal path.",
  };
}

export async function recordClaimSubmission(ctx: AppContext, wallet: Address, body: { txHash?: string; asset?: string; kind?: string }) {
  const txHash = String(body.txHash ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) refuse("INVALID_PARAMS", "txHash is required.");
  const asset = body.asset && isAddress(body.asset) ? getAddress(body.asset) : NATIVE;
  const kind = body.kind === "treasury" ? "treasury" : "escrow";
  // The tx must have been sent BY the claiming wallet: a submission can't be attributed to someone else.
  try {
    const tx = await ctx.client.getTransaction({ hash: txHash as Hex });
    if (getAddress(tx.from) !== wallet) refuse("NOT_YOUR_TRANSACTION", "That transaction was not sent by your wallet.", 403);
  } catch (e) {
    if ((e as { code?: string }).code === "NOT_YOUR_TRANSACTION") throw e;
    /* not yet visible: recorded as pending */
  }
  await ctx.db.query("INSERT INTO fin_claim_submissions(tx_hash, wallet, asset, kind) VALUES ($1,$2,$3,$4) ON CONFLICT (tx_hash) DO NOTHING", [
    txHash,
    wallet,
    asset,
    kind,
  ]);
  const { ledger } = await loadLedger(ctx);
  return { txHash, status: await submissionStatus(ctx, ledger, txHash) };
}

// ── Treasury ─────────────────────────────────────────────────────────────

export async function treasuryReport(ctx: AppContext) {
  const { ledger, checkpoint } = await loadLedger(ctx);
  const splitter = ctx.cfg.addresses.revenueSplitter;
  const sp = splitter ? ({ address: splitter, abi: forgeProtocolRevenueSplitterAbi } as const) : null;
  const at = checkpoint !== null ? { blockNumber: checkpoint } : {};

  // Per-launch breakdown, with fail-closed eligibility from the frozen snapshot.
  const launches = [];
  const eligibleByAsset = new Map<Address, { gross: bigint; protocol: bigint; creator: bigint }>();
  for (const t of ledger.tokens.values()) {
    const l = await readLaunch(ctx, t.token);
    const el = eligibility(ctx, l);
    const d = derivedTreasuryReserve(t.protocolCredited);
    // Derived only when the launch's FROZEN snapshot routes its protocol leg to the splitter.
    const toSplitter = splitter !== null && l.policy.protocolFeeRecipient === splitter;
    if (el.eligible70_20_10) {
      const e = eligibleByAsset.get(t.pairToken) ?? { gross: 0n, protocol: 0n, creator: 0n };
      e.gross += t.curveBaseFees + t.hookBaseFeesQuote;
      e.protocol += t.protocolCredited;
      e.creator += t.creatorBaseCredited;
      eligibleByAsset.set(t.pairToken, e);
    }
    launches.push({
      token: t.token,
      curve: t.curve,
      creator: t.creator,
      quoteAsset: await assetInfo(ctx, t.pairToken),
      phase: l.phase,
      poolId: t.poolId,
      policySnapshot: { ...l.policy, creatorTaxBps: l.creatorTaxBps, buybackEnabled: l.buybackEnabled },
      economics: el,
      bondingCurve: { baseFees: s(t.curveBaseFees), snipeTaxComponent: s(t.curveSnipeTax), creatorTax: s(t.curveCreatorTax), sweeps: t.curveSweeps, buybackQuoteSpent: s(t.curveBuybackSpent), tokensLocked: s(t.curveTokensLocked) },
      v4Hook: {
        baseFeesQuote: s(t.hookBaseFeesQuote),
        creatorTaxQuote: s(t.hookCreatorTaxQuote),
        baseFeesMemecoin: s(t.hookBaseFeesMemecoin),
        creatorTaxMemecoin: s(t.hookCreatorTaxMemecoin),
        sweeps: t.hookSweeps,
        buybackQuoteSpent: s(t.hookBuybackSpent),
        tokensLocked: s(t.hookTokensLocked),
      },
      credited: {
        protocol: s(t.protocolCredited),
        protocolRecipients: t.protocolCreditedTo,
        creator: s(t.creatorCredited),
        creatorBase: s(t.creatorBaseCredited),
        creatorTax: s(t.creatorTaxCredited),
        creatorUnsplit: s(t.creatorUnsplitCredited),
      },
      derivedProtocolSplit: toSplitter ? { treasury: s(d.treasury), reserve: s(d.reserve), basis: "policy-derived 2:1 of exactly attributed protocol credits; on-chain rounding is cumulative per asset" } : null,
      rescuedDirect: { protocol: s(t.rescuedProtocol), creator: s(t.rescuedCreator) },
      vest: { locked: s(t.vestLocked), releasedCreator: s(t.vestReleasedCreator), releasedProtocol: s(t.vestReleasedProtocol) },
      accruedUnswept: await liveAccrued(ctx, l),
    });
  }

  // Splitter accounting per asset: indexed vs on-chain at the checkpoint.
  const assets = new Set<Address>([NATIVE, ...ledger.splitterTotals.keys()]);
  for (const c of ledger.credits) if (splitter && c.recipient === splitter) assets.add(c.asset);
  const accounting = [];
  const exceptions = [...ledger.exceptions];
  for (const asset of assets) {
    const t = ledger.splitterTotals.get(asset);
    const idx = {
      revenueReceived: t?.revenueReceived ?? 0n,
      treasuryAllocated: t?.treasuryAllocated ?? 0n,
      reserveAllocated: t?.reserveAllocated ?? 0n,
      treasuryPaid: t?.treasuryPaid ?? 0n,
      nonRevenueReceived: t?.nonRevenueReceived ?? 0n,
      nonRevenueReleased: t?.nonRevenueReleased ?? 0n,
    };
    let onchain: Record<string, string | boolean | null> | null = null;
    let status = "NOT_AVAILABLE";
    if (sp && checkpoint !== null) {
      try {
        const [lg, rec, approved] = await Promise.all([
          ctx.client.readContract({ ...sp, functionName: "ledger", args: [asset], ...at }),
          ctx.client.readContract({ ...sp, functionName: "reconcile", args: [asset], ...at }),
          ctx.client.readContract({ ...sp, functionName: "approvedAsset", args: [asset], ...at }),
        ]);
        onchain = {
          revenueReceived: s(lg.revenueReceived),
          treasuryAllocated: s(lg.treasuryAllocated),
          reserveAllocated: s(lg.reserveAllocated),
          treasuryPaid: s(lg.treasuryPaid),
          nonRevenueReceived: s(lg.nonRevenueReceived),
          nonRevenueReleased: s(lg.nonRevenueReleased),
          balance: s(rec[0]),
          accounted: s(rec[1]),
          surplus: s(rec[2]),
          deficit: s(rec[3]),
          approved,
        };
        const match =
          lg.revenueReceived === idx.revenueReceived &&
          lg.treasuryAllocated === idx.treasuryAllocated &&
          lg.reserveAllocated === idx.reserveAllocated &&
          lg.treasuryPaid === idx.treasuryPaid &&
          lg.nonRevenueReceived === idx.nonRevenueReceived &&
          lg.nonRevenueReleased === idx.nonRevenueReleased;
        const conserved = rec[3] === 0n && lg.reserveAllocated === lg.revenueReceived / 3n && lg.treasuryAllocated + lg.reserveAllocated === lg.revenueReceived;
        status = match && conserved ? (rec[2] > 0n ? "RECONCILED_WITH_UNRECORDED_SURPLUS" : "RECONCILED") : "MISMATCH";
        if (rec[2] > 0n) exceptions.push({ kind: "SPLITTER_UNRECORDED_SURPLUS", detail: "Balance above accounted holdings (direct transfer or rescue); record it as unattributed non-revenue.", asset, amount: rec[2].toString() });
        if (rec[3] > 0n) exceptions.push({ kind: "SPLITTER_DEFICIT", detail: "Liabilities exceed balance (rebasing/negative-yield asset?) — investigate before any claim.", asset, amount: rec[3].toString() });
      } catch (e) {
        status = `READ_FAILED: ${(e as Error).message.split("\n")[0]}`;
      }
    }
    const escrowIndexed = splitter ? (ledger.escrowBalances.get(`${splitter}:${asset}`) ?? 0n) : 0n;
    const escrowOnchain = splitter && checkpoint !== null ? await escrowBalanceAt(ctx, splitter, asset, checkpoint) : null;
    const protocolCreditsToSplitter = ledger.credits.filter((c) => splitter && c.recipient === splitter && c.asset === asset && c.cls === "PROTOCOL_BASE_FEE").reduce((a, c) => a + c.amount, 0n);
    const vestToSplitter = ledger.credits.filter((c) => splitter && c.recipient === splitter && c.asset === asset && c.cls === "VEST_RELEASE_PROTOCOL").reduce((a, c) => a + c.amount, 0n);
    const thirdPartyToSplitter = ledger.credits.filter((c) => splitter && c.recipient === splitter && c.asset === asset && c.cls === "UNATTRIBUTED_CREDIT").reduce((a, c) => a + c.amount, 0n);
    const elig = eligibleByAsset.get(asset);
    accounting.push({
      asset: await assetInfo(ctx, asset),
      overview: {
        eligibleGrossBaseFees: s(elig?.gross ?? 0n),
        creatorEntitlementCredited: s(elig?.creator ?? 0n),
        protocolEntitlementCredited: s(protocolCreditsToSplitter),
        treasuryAllocated: s(idx.treasuryAllocated),
        reserveAllocated: s(idx.reserveAllocated),
        treasuryPaid: s(idx.treasuryPaid),
        treasuryOutstanding: s(idx.treasuryAllocated - idx.treasuryPaid),
        reserveOutstanding: s(idx.reserveAllocated),
      },
      statements: {
        realisedRevenuePulled: s(idx.revenueReceived),
        escrowCreditedNotPulled: { indexed: s(escrowIndexed), onchainAtCheckpoint: s(escrowOnchain), reconciliation: escrowOnchain === null ? "NOT_AVAILABLE" : escrowOnchain === escrowIndexed ? "RECONCILED" : "MISMATCH" },
        nonRevenueHeld: s(idx.nonRevenueReceived - idx.nonRevenueReleased),
        nonRevenue: { launchFees: s(t?.launchFees ?? 0n), graduationResidual: s(t?.graduationResidual ?? 0n), unattributedNative: s(t?.unattributedNative ?? 0n), unattributedToken: s(t?.unattributedToken ?? 0n), released: s(idx.nonRevenueReleased) },
        vestReleasesToSplitterKey: s(vestToSplitter),
        thirdPartyEscrowCreditsToSplitterKey: s(thirdPartyToSplitter),
      },
      indexed: Object.fromEntries(Object.entries(idx).map(([k, v]) => [k, s(v)])),
      onchainAtCheckpoint: onchain,
      reconciliation: status,
    });
  }
  return {
    splitter,
    policy: { version: 1, protocolShareOfBaseFeeBps: ELIGIBLE_PROTOCOL_SHARE_BPS, treasuryParts: 2, reserveParts: 1, rounding: "reserve = floor(lifetime revenue / 3) per asset; treasury = remainder" },
    flags: { PRODUCTION_BLOCKED, FINCO_BURN_ENABLED, FORGE_FEE_POLICY_AUTHORITY_UNPROVEN },
    accounting,
    launches,
    allocations: ledger.allocations.map((a) => ({ allocationId: s(a.allocationId), block: s(a.blockNumber), txHash: a.txHash, timestamp: s(a.timestamp), asset: a.asset, received: s(a.received), toTreasury: s(a.toTreasury), toReserve: s(a.toReserve), policyVersion: a.policyVersion })),
    treasuryClaims: ledger.treasuryClaims.map((c) => ({ block: s(c.blockNumber), txHash: c.txHash, timestamp: s(c.timestamp), asset: c.asset, recipient: c.recipient, amount: s(c.amount) })),
    exceptions,
    reserve: {
      status: "RESERVE_ONLY",
      burnEnabled: FINCO_BURN_ENABLED,
      readiness: "DISABLED — no FINCO token address, no conversion route, no governance executor; the splitter has no reserve exit.",
    },
    indexer: await indexerState(ctx),
  };
}

// ── Governance ───────────────────────────────────────────────────────────

export const AUTHORIZATION_MATRIX = [
  { contract: "PonsV2MemeHook", fn: "setProtocolFeeShareBps / setBuybackBurnBps / setHookFeeBps", role: "hook owner", timelock: "none", effect: "Policy for FUTURE launches only (per-launch snapshot is frozen).", risk: "Changes the 70/20/10 eligibility of new launches." },
  { contract: "PonsV2MemeHook", fn: "setProtocolFeeRecipient", role: "hook owner", timelock: "none", effect: "Protocol-leg recipient for FUTURE launches; the launch fee recipient immediately.", risk: "Unauthorized recipient substitution for new launches — monitored; must stay the splitter." },
  { contract: "PonsV2MemeHook", fn: "setFeeSweepOperator", role: "hook owner", timelock: "none", effect: "Who may execute conversion/buyback sweeps.", risk: "Operator chooses price floors for internal swaps." },
  { contract: "PonsV2MemeHook", fn: "rescuePoolFees", role: "hook owner", timelock: "none", effect: "Pays a pool's pending fees directly (escrow bypassed), regular split.", risk: "F-04: protocol leg arrives as unattributed direct transfer." },
  { contract: "PonsV2LaunchFactory", fn: "setCreatorFeeRecipient → executeCreatorFeeRecipientChange", role: "factory owner", timelock: "3 days notice + 3 days window", effect: "Redirects a launch's creator fees and vest beneficiary.", risk: "F-03: standing owner power over creator fee routing." },
  { contract: "PonsV2LaunchFactory", fn: "rescueCurveFees", role: "factory owner", timelock: "none", effect: "Pays a curve's pending fees directly, regular split.", risk: "F-04: escrow bypass; protocol leg becomes unattributed." },
  { contract: "PonsV2LaunchFactory", fn: "rescueSweptGraduation", role: "factory owner", timelock: "7 days after sweep", effect: "Releases unseedable reserves to one recipient.", risk: "F-04: owner-chosen recipient for stuck reserves." },
  { contract: "PonsV2LaunchFactory", fn: "setLaunchFee", role: "factory owner", timelock: "none", effect: "ETH paid per launch to the hook's live protocol recipient.", risk: "Non-revenue class; never in 70/20/10." },
  { contract: "ForgeProtocolRevenueSplitter", fn: "proposeTreasuryRecipient → executeTreasuryRecipientChange", role: "splitter owner", timelock: "3 days notice + 3 days window", effect: "Who may claim the treasury allocation.", risk: "Cannot touch the reserve or creator funds." },
  { contract: "ForgeProtocolRevenueSplitter", fn: "setAssetApproved / setPullsPaused", role: "splitter owner", timelock: "none", effect: "Which quote assets are pulled; halting pulls never blocks claims.", risk: "Launch tokens can never be approved." },
  { contract: "ForgeProtocolRevenueSplitter", fn: "releaseNonRevenue", role: "splitter owner", timelock: "none", effect: "Moves NON-revenue (launch fees, unattributed) to the treasury recipient only.", risk: "Fixed destination; no arbitrary withdrawal." },
  { contract: "ForgeProtocolRevenueSplitter", fn: "claimTreasury", role: "treasury recipient", timelock: "none", effect: "Pays the allocated treasury liability.", risk: "Separate from fee-policy control." },
  { contract: "ForgeProtocolRevenueSplitter", fn: "(FINCO reserve exit)", role: "none", timelock: "n/a", effect: "Does not exist. FINCO_BURN_ENABLED = false.", risk: "None — reserve is a liability only." },
];

export async function governanceReport(ctx: AppContext) {
  const a = ctx.cfg.addresses;
  const h = { address: a.memeHook, abi: ponsV2MemeHookAbi } as const;
  const f = { address: a.factory, abi: ponsV2LaunchFactoryAbi } as const;
  const read = async <T>(p: Promise<T>) => p.catch(() => null);
  const [hookOwner, hookPending, share, buyback, hookFee, recipient, operator, factoryOwner, launchFee, maxTax] = await Promise.all([
    read(ctx.client.readContract({ ...h, functionName: "owner" })),
    read(ctx.client.readContract({ ...h, functionName: "pendingOwner" })),
    read(ctx.client.readContract({ ...h, functionName: "protocolFeeShareBps" })),
    read(ctx.client.readContract({ ...h, functionName: "buybackBurnBps" })),
    read(ctx.client.readContract({ ...h, functionName: "hookFeeBps" })),
    read(ctx.client.readContract({ ...h, functionName: "protocolFeeRecipient" })),
    read(ctx.client.readContract({ ...h, functionName: "feeSweepOperator" })),
    read(ctx.client.readContract({ ...f, functionName: "owner" })),
    read(ctx.client.readContract({ ...f, functionName: "launchFee" })),
    read(ctx.client.readContract({ ...f, functionName: "maxCreatorTaxBps" })),
  ]);
  let splitter: Record<string, unknown> | null = null;
  if (a.revenueSplitter) {
    const sp = { address: a.revenueSplitter, abi: forgeProtocolRevenueSplitterAbi } as const;
    const [owner, pendingOwner, treasury, pending, paused, version, burn, factory, readiness] = await Promise.all([
      read(ctx.client.readContract({ ...sp, functionName: "owner" })),
      read(ctx.client.readContract({ ...sp, functionName: "pendingOwner" })),
      read(ctx.client.readContract({ ...sp, functionName: "treasuryRecipient" })),
      read(ctx.client.readContract({ ...sp, functionName: "pendingTreasuryRecipient" })),
      read(ctx.client.readContract({ ...sp, functionName: "pullsPaused" })),
      read(ctx.client.readContract({ ...sp, functionName: "POLICY_VERSION" })),
      read(ctx.client.readContract({ ...sp, functionName: "FINCO_BURN_ENABLED" })),
      read(ctx.client.readContract({ ...sp, functionName: "forgeFactory" })),
      read(ctx.client.readContract({ ...sp, functionName: "burnReadiness" })),
    ]);
    splitter = {
      address: a.revenueSplitter,
      owner,
      pendingOwner,
      treasuryRecipient: treasury,
      pendingTreasuryRecipient: pending && pending[0] !== NATIVE ? { newRecipient: pending[0], effectiveAt: s(pending[1]), expiresAt: s(pending[2]) } : null,
      pullsPaused: paused,
      policyVersion: version,
      fincoBurnEnabled: burn,
      burnReadiness: readiness ? { enabled: readiness[0], status: readiness[1] } : null,
      forgeFactory: factory,
    };
  }
  const { ledger } = await loadLedger(ctx);
  const warnings: string[] = [];
  if (!a.revenueSplitter) warnings.push("No Forge revenue splitter configured: the 70/20/10 policy is not available.");
  if (a.revenueSplitter && recipient !== null && recipient !== a.revenueSplitter) warnings.push(`UNAUTHORIZED RECIPIENT: the hook's live protocol recipient ${recipient} is not the Forge splitter; new launches would not be 70/20/10 eligible.`);
  if (share !== null && Number(share) !== ELIGIBLE_PROTOCOL_SHARE_BPS) warnings.push(`Live protocol share is ${Number(share) / 100}%: new launches are NOT 70/20/10 eligible (existing snapshots are unaffected).`);
  if (hookOwner && factoryOwner && hookOwner === factoryOwner) warnings.push("Hook (fee policy) and factory are controlled by the same key; fee-policy and treasury-claim controls are still separate (treasury recipient is a different role).");
  warnings.push("FORGE_FEE_POLICY_AUTHORITY_UNPROVEN: owners are single sandbox keys, not a reviewed timelock/multisig.");
  warnings.push("PRODUCTION_BLOCKED: no Forge stack is deployed to Robinhood Chain; nothing here moves real funds.");
  const rescues = ledger.governance.filter((g) => ["FeesRescued", "PoolFeesRescued", "LaunchGraduationRescued"].includes(g.eventName));
  const overrides = ledger.governance.filter((g) => g.eventName === "CreatorFeeRecipientChangeProposed");
  return {
    flags: { PRODUCTION_BLOCKED, FINCO_BURN_ENABLED, FORGE_FEE_POLICY_AUTHORITY_UNPROVEN },
    currentPolicy: {
      source: "PonsV2MemeHook.currentFeePolicy (applies to NEW launches; each launch freezes its own snapshot)",
      protocolFeeShareBps: share === null ? null : Number(share),
      buybackBurnBps: buyback === null ? null : Number(buyback),
      hookFeeBps: hookFee === null ? null : Number(hookFee),
      protocolFeeRecipient: recipient,
      recipientIsForgeSplitter: a.revenueSplitter ? recipient === a.revenueSplitter : false,
      launchFeeWei: s(launchFee as bigint | null),
      maxCreatorTaxBps: s(maxTax as bigint | null),
    },
    roles: { hookOwner, hookPendingOwner: hookPending, factoryOwner, feeSweepOperator: operator, splitter },
    exposure: {
      creatorFeeOverrideProposals: overrides.length,
      rescueEvents: rescues.length,
      note: "F-03 (owner creator-fee-recipient override, 3-day timelock) and F-04 (rescue hatches) are standing owner powers; every use is listed in history.",
    },
    authorizationMatrix: AUTHORIZATION_MATRIX,
    policyChangeProcess: [
      "1. Governance publishes the proposed policy (share, split, recipient) and its effective block.",
      "2. A NEW splitter version is deployed and reviewed (the 2:1 split and policy version are immutable per splitter).",
      "3. The hook owner calls setProtocolFeeRecipient / setProtocolFeeShareBps; ONLY launches created afterwards snapshot it.",
      "4. Existing launches keep their frozen snapshot and recipient; nothing is silently reconfigured.",
      "5. The dashboard marks each launch eligible / not eligible from its own snapshot (fail-closed).",
    ],
    history: ledger.governance.map((g) => ({ block: s(g.blockNumber), txHash: g.txHash, timestamp: s(g.timestamp), contract: g.contract, address: g.address, event: g.eventName, args: g.args })),
    warnings,
  };
}
