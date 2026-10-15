/**
 * W05 — deterministic synthetic chain-event histories for the ledger fold
 * (property tests, benchmarks, backup rehearsal). NOT chain data: events are
 * generated from templates that mirror what the Forge contracts emit, with
 * the same argument names the indexer stores:
 *
 *   launches (native + ERC-20 quote assets, eligible and non-eligible
 *   protocol recipients), curve trades with fee/tax, snipe tax, buyback
 *   locks, curve sweeps (escrow credits protocol→creator, then FeesSwept, in
 *   ONE tx), graduation (PoolRegistered), hook fee collection in quote and
 *   memecoin units, hook sweeps (credits creator→protocol, optional
 *   PoolConversionSkipped), vault locks/releases with vault credits, owner
 *   rescues, third-party escrow credits, escrow claims (incl. third-party
 *   recipients), splitter authorizations / allocations / non-revenue /
 *   treasury claims, governance events, plus rare anomalies the ledger must
 *   surface (unmatched source credit, sweep missing a credit).
 *
 * A fork salt + fork block produce an alternative branch that is identical up
 * to the fork block and differs (different block hashes and events) after it.
 */
import { getAddress, type Address } from "viem";
import type { LedgerContext, LedgerEvent } from "../../src/server/finance/ledger";

export const NATIVE: Address = "0x0000000000000000000000000000000000000000";
const A = (n: number | bigint) => getAddress(`0x${BigInt(n).toString(16).padStart(40, "0")}`) as Address;

export const SYN = {
  factory: A(0xf000f),
  hook: A(0x2044),
  escrow: A(0xe5c0),
  vault: A(0xa7a7),
  splitter: A(0x5b17),
  graduationExecutor: A(0x6e6e),
  otherProtocol: A(0x0bad0),
  usdc: A(0x05dc),
  weth: A(0x0e7e),
};

export const SYN_CONTEXT: LedgerContext = {
  factory: SYN.factory,
  hook: SYN.hook,
  escrow: SYN.escrow,
  vault: SYN.vault,
  splitter: SYN.splitter,
  graduationExecutor: SYN.graduationExecutor,
};

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const hex64 = (s: string) => {
  // Deterministic 32-byte hex from a string (not cryptographic; identity only).
  let out = "";
  for (let i = 0; out.length < 64; i++) out += hashStr(`${s}:${i}`).toString(16).padStart(8, "0");
  return `0x${out.slice(0, 64)}`;
};

interface Launch {
  idx: number;
  token: Address;
  curve: Address;
  creator: Address;
  pair: Address;
  protocolRecipient: Address;
  graduated: boolean;
  poolId: string | null;
  curveTaxSinceSweep: bigint;
}

export interface HistoryOptions {
  seed: number;
  /** Stop after at least this many events (whole blocks). */
  targetEvents: number;
  /** Alternative branch: identical through `forkBlock`, different after. */
  fork?: { block: number; salt: string };
  maxLaunches?: number;
  /** Include rare anomalies (unmatched / mismatched credits). Default true. */
  anomalies?: boolean;
}

export interface History {
  events: LedgerEvent[];
  ctx: LedgerContext;
  lastBlock: number;
  /** Block → hash for every generated block (including blocks without events). */
  blockHashes: Map<number, string>;
}

export function generateHistory(o: HistoryOptions): History {
  let rnd = mulberry32(o.seed);
  const maxLaunches = o.maxLaunches ?? 64;
  const anomalies = o.anomalies ?? true;
  const launches: Launch[] = [];
  const balances = new Map<string, bigint>(); // escrow recipient:asset
  const splitterEligible = new Map<Address, bigint>();
  const splitterTreasury = new Map<Address, bigint>();
  const events: LedgerEvent[] = [];
  const blockHashes = new Map<number, string>();
  let salt = "main";
  const int = (n: number) => Math.floor(rnd() * n);
  const amt = (max: number) => BigInt(1 + int(max)) * 10n ** BigInt(int(3) * 3);
  const pick = <T>(xs: T[]) => xs[int(xs.length)]!;
  const people = Array.from({ length: 24 }, (_, i) => A(0xc0000 + i));
  const strangers = Array.from({ length: 6 }, (_, i) => A(0xbad000 + i));

  let block = 0;
  while (events.length < o.targetEvents) {
    block++;
    if (o.fork && block === o.fork.block + 1) {
      salt = o.fork.salt;
      rnd = mulberry32(o.seed ^ hashStr(o.fork.salt));
    }
    const blockHash = hex64(`${o.seed}:${salt}:${block}`);
    blockHashes.set(block, blockHash);
    // Some blocks carry no events at all.
    if (rnd() < 0.15) continue;
    let logIndex = 0;
    const txs = 1 + int(4);
    for (let ti = 0; ti < txs; ti++) {
      const txHash = hex64(`tx:${o.seed}:${salt}:${block}:${ti}`);
      const emit = (address: Address, eventName: string, args: Record<string, string>) =>
        events.push({ blockNumber: BigInt(block), blockHash, txHash, logIndex: logIndex++, address, eventName, args, blockTimestamp: BigInt(1_700_000_000 + block * 2) });
      const credit = (recipient: Address, depositor: Address, asset: Address, amount: bigint) => {
        if (asset === NATIVE) emit(SYN.escrow, "Credited", { recipient, depositor, amount: amount.toString() });
        else emit(SYN.escrow, "CreditedToken", { recipient, depositor, token: asset, amount: amount.toString() });
        balances.set(`${recipient}:${asset}`, (balances.get(`${recipient}:${asset}`) ?? 0n) + amount);
      };
      const claim = (recipient: Address, asset: Address, amount: bigint) => {
        if (asset === NATIVE) emit(SYN.escrow, "Claimed", { recipient, amount: amount.toString() });
        else emit(SYN.escrow, "ClaimedToken", { recipient, token: asset, amount: amount.toString() });
        balances.set(`${recipient}:${asset}`, (balances.get(`${recipient}:${asset}`) ?? 0n) - amount);
      };
      const live = launches.filter((l) => !l.graduated);
      const grad = launches.filter((l) => l.graduated);
      const r = rnd();

      if (launches.length === 0 || (r < 0.06 && launches.length < maxLaunches)) {
        const idx = launches.length;
        const l: Launch = {
          idx,
          token: A((BigInt(hashStr(salt)) << 32n) + BigInt(0x7000000 + idx)),
          curve: A((BigInt(hashStr(salt)) << 32n) + BigInt(0xc000000 + idx)),
          creator: pick(people),
          pair: pick([NATIVE, NATIVE, SYN.usdc, SYN.weth]),
          protocolRecipient: rnd() < 0.85 ? SYN.splitter : SYN.otherProtocol,
          graduated: false,
          poolId: null,
          curveTaxSinceSweep: 0n,
        };
        launches.push(l);
        emit(SYN.factory, "TokenLaunched", { token: l.token, curve: l.curve, deployer: l.creator, pairToken: l.pair, launchConfigId: String(int(3)), graduationThreshold: "30000000000000000000" });
        if (rnd() < 0.5) emit(SYN.splitter, "NonRevenueReceived", { asset: NATIVE, from: l.creator, amount: amt(1000).toString(), cls: "0" });
      } else if (r < 0.4 && live.length) {
        const l = pick(live);
        const fee = amt(5000);
        const tax = rnd() < 0.6 ? amt(2000) : 0n;
        if (rnd() < 0.1) emit(l.curve, "SnipeTaxCharged", { buyer: pick(people), amount: (fee / 2n).toString() });
        emit(l.curve, rnd() < 0.7 ? "CurveBuy" : "CurveSell", { buyer: pick(people), recipient: pick(people), quoteIn: (fee * 100n).toString(), tokensOut: amt(100000).toString(), fee: fee.toString(), tax: tax.toString() });
        l.curveTaxSinceSweep += tax;
        if (rnd() < 0.1) emit(l.curve, "BuybackLocked", { quoteSpent: amt(500).toString(), tokensLocked: amt(9000).toString() });
      } else if (r < 0.52 && live.length) {
        // Curve sweep: protocol credited first, then creator, then FeesSwept.
        const l = pick(live);
        const protocol = amt(3000);
        const creator = amt(7000) + l.curveTaxSinceSweep;
        const missing = anomalies && rnd() < 0.02;
        credit(l.protocolRecipient, l.curve, l.pair, protocol);
        if (!missing) credit(l.creator, l.curve, l.pair, creator);
        emit(l.curve, "FeesSwept", { protocolAmount: protocol.toString(), buybackAmount: "0", creatorAmount: creator.toString() });
        l.curveTaxSinceSweep = 0n;
      } else if (r < 0.56 && live.length) {
        const l = pick(live);
        l.graduated = true;
        l.poolId = hex64(`pool:${salt}:${l.idx}`);
        emit(SYN.hook, "PoolRegistered", { poolId: l.poolId, memecoin: l.token });
        if (rnd() < 0.5) emit(SYN.splitter, "NonRevenueReceived", { asset: NATIVE, from: SYN.graduationExecutor, amount: amt(100).toString(), cls: "1" });
      } else if (r < 0.7 && grad.length) {
        const l = pick(grad);
        const quote = rnd() < 0.7;
        emit(SYN.hook, "HookFeeCollected", { poolId: l.poolId!, currency: quote ? l.pair : l.token, feeAmount: amt(4000).toString(), taxAmount: (rnd() < 0.5 ? amt(1000) : 0n).toString() });
      } else if (r < 0.77 && grad.length) {
        // Hook sweep: creator credited first, then protocol, then PoolFeesSwept.
        const l = pick(grad);
        const protocol = amt(3000);
        const creator = amt(7000);
        credit(l.creator, SYN.hook, l.pair, creator);
        credit(l.protocolRecipient, SYN.hook, l.pair, protocol);
        if (rnd() < 0.15) emit(SYN.hook, "PoolConversionSkipped", { poolId: l.poolId! });
        emit(SYN.hook, "PoolFeesSwept", { poolId: l.poolId!, protocolAmount: protocol.toString(), creatorAmount: creator.toString(), buybackAmount: (rnd() < 0.2 ? amt(100) : 0n).toString(), tokensLocked: "0" });
      } else if (r < 0.8 && launches.length) {
        const l = pick(launches);
        if (rnd() < 0.5) emit(SYN.vault, "Locked", { token: l.token, amount: amt(9000).toString() });
        else {
          const c = amt(500);
          const p = amt(200);
          credit(l.creator, SYN.vault, l.token, c);
          credit(SYN.splitter, SYN.vault, l.token, p);
          emit(SYN.vault, "Released", { token: l.token, creatorAmount: c.toString(), protocolAmount: p.toString() });
        }
      } else if (r < 0.84) {
        // Third-party escrow credit (to the splitter key or anyone), native or token.
        credit(rnd() < 0.5 ? SYN.splitter : pick(people), pick(strangers), pick([NATIVE, SYN.usdc]), amt(50));
      } else if (r < 0.9) {
        // Escrow claim by a holder with a positive balance (creators, third parties, splitter).
        const holders = [...balances].filter(([, v]) => v > 0n);
        if (holders.length) {
          const [k, v] = pick(holders);
          const [recipient, asset] = k.split(":") as [Address, Address];
          const quoteAsset = asset === NATIVE || asset === SYN.usdc || asset === SYN.weth;
          if (recipient === SYN.splitter && !quoteAsset) {
            // Vest releases in launch tokens stay in the escrow (never an approved splitter asset).
          } else if (recipient === SYN.splitter) {
            // Splitter pull: escrow claim + allocation, bounded by an attested ceiling.
            const take = v / 2n + 1n;
            const cum = (splitterEligible.get(asset) ?? 0n) + take;
            splitterEligible.set(asset, cum);
            emit(SYN.splitter, "EligibleRevenueAuthorized", { asset, cumulativeEligible: cum.toString(), nonce: String(block), evidenceBlock: String(block - 1), evidenceBlockHash: blockHashes.get(block - 1) ?? blockHash, attestor: A(0xa77) });
            claim(SYN.splitter, asset, take);
            const reserve = take / 3n;
            emit(SYN.splitter, "RevenueAllocated", { allocationId: String(events.length), asset, escrowClaimed: take.toString(), received: take.toString(), toTreasury: (take - reserve).toString(), toReserve: reserve.toString(), policyVersion: "1" });
            splitterTreasury.set(asset, (splitterTreasury.get(asset) ?? 0n) + take - reserve);
          } else {
            claim(recipient, asset, rnd() < 0.5 ? v : v / 2n);
          }
        }
      } else if (r < 0.93) {
        const owed = [...splitterTreasury].filter(([, v]) => v > 0n);
        if (owed.length) {
          const [asset, v] = pick(owed);
          emit(SYN.splitter, "TreasuryClaimed", { asset, recipient: A(0x7ea5), amount: v.toString() });
          splitterTreasury.set(asset, 0n);
        } else emit(SYN.splitter, "NonRevenueReleased", { asset: NATIVE, to: A(0x7ea5), amount: "1" });
      } else if (r < 0.95 && launches.length) {
        // Rare owner rescues (escrow bypassed) and anomalies.
        const l = pick(launches);
        if (l.graduated && l.poolId) emit(SYN.hook, "PoolFeesRescued", { poolId: l.poolId, protocolAmount: amt(10).toString(), creatorAmount: amt(10).toString() });
        else emit(l.curve, "FeesRescued", { protocolAmount: amt(10).toString(), creatorAmount: amt(10).toString() });
        if (anomalies && rnd() < 0.3) credit(l.creator, l.curve, l.pair, amt(10)); // credit without a sweep → UNMATCHED_SOURCE_CREDIT
      } else {
        const g = rnd();
        if (g < 0.3) emit(SYN.factory, "LaunchFeeUpdated", { oldFee: "0", newFee: amt(10).toString() });
        else if (g < 0.5) emit(SYN.hook, "ProtocolFeeShareUpdated", { oldBps: "3000", newBps: "3000" });
        else if (g < 0.7) emit(SYN.splitter, "PullsPausedUpdated", { paused: rnd() < 0.5 ? "true" : "false" });
        else if (g < 0.85 && launches.length) emit(pick(launches).curve, "BuybackEnabledUpdated", { enabled: "true" });
        else emit(SYN.vault, "CreatorRecipientUpdated", { token: launches[0]?.token ?? NATIVE, recipient: pick(people) });
      }
    }
  }
  return { events, ctx: SYN_CONTEXT, lastBlock: block, blockHashes };
}

/** Deterministic shuffle (Fisher–Yates) for delivery-order tests. */
export function shuffled<T>(xs: T[], seed: number): T[] {
  const rnd = mulberry32(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export { mulberry32 };
