/**
 * W04 Correction A — eligible-revenue attestor (SANDBOX ONLY).
 *
 * The canonical escrow's `credit`/`creditToken` are permissionless, so the
 * splitter cannot tell a fee credit from a third-party credit on chain. The
 * splitter therefore pulls only up to a cumulative per-asset CEILING that
 * this attestor signs (EIP-712 `EligibleRevenue`), recomputed here — never
 * from balances, never from caller input — as:
 *
 *   Σ escrow Credited/CreditedToken to the splitter key
 *     whose DEPOSITOR is a Forge curve, or the Forge hook in the same tx as
 *     its PoolFeesSwept (ledger class PROTOCOL_BASE_FEE),
 *     for launches whose FROZEN snapshot names the splitter at 30%,
 *     in blocks ≤ the indexer checkpoint (the finalised evidence block).
 *
 * The signature binds chain + splitter (domain), escrow, factory, asset, the
 * cumulative amount, a strictly increasing nonce, a deadline and the evidence
 * block hash, which the splitter re-checks with `blockhash` (a reorganised
 * evidence block is refused on chain).
 *
 * TRUST BOUNDARY: this is an explicit, trusted off-chain attestation, not a
 * trustless proof. A faulty attestor can at worst let the splitter pull
 * third-party credits already sitting under its own escrow key; it cannot
 * mint, cannot reach creator funds and cannot withdraw. Production signing is
 * disabled (REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED=false and, since
 * W05, PRODUCTION_SIGNING_ENABLED=false): custody is the local-test signer or
 * a KMS signer, both refusing every chain but 31337/1337, and both reached
 * only through the W05 signing-policy guard (docs/W05-SIGNER-CUSTODY.md).
 * Incident note: revokeRevenueAttestor() does NOT invalidate headroom that is
 * already authorized; the procedure must also call setPullsPaused(true).
 */
import { hashTypedData, type Address, type Hex } from "viem";
import { forgeProtocolRevenueSplitterAbi, ponsV2FeeEscrowAbi } from "@/shared/abis.generated";
import type { AppContext } from "../context";
import { audit } from "../audit";
import { REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED, ROBINHOOD_CHAIN_ID } from "../config";
import { verifiedEligibleRevenue, NATIVE, type Ledger } from "./ledger";
import { ledgerIntegrity, signingBlockedReason } from "./materialized";

export const SPLITTER_EIP712_DOMAIN = { name: "FINCO Forge Revenue Splitter", version: "1" } as const;
export const ELIGIBLE_REVENUE_TYPES = {
  EligibleRevenue: [
    { name: "escrow", type: "address" },
    { name: "factory", type: "address" },
    { name: "asset", type: "address" },
    { name: "cumulativeEligible", type: "uint256" },
    { name: "nonce", type: "uint64" },
    { name: "deadline", type: "uint64" },
    { name: "evidenceBlock", type: "uint64" },
    { name: "evidenceBlockHash", type: "bytes32" },
  ],
} as const;

/** Evidence must sit inside the splitter's 256-block blockhash window; keep a safety margin. */
export const MAX_EVIDENCE_LAG_BLOCKS = 200n;
export const AUTHORIZATION_TTL_SECONDS = 600n;

export interface EligibleRevenueAuth {
  escrow: Address;
  factory: Address;
  asset: Address;
  cumulativeEligible: bigint;
  nonce: bigint;
  deadline: bigint;
  evidenceBlock: bigint;
  evidenceBlockHash: Hex;
}

export function eligibleRevenueDigest(chainId: number, splitter: Address, auth: EligibleRevenueAuth): Hex {
  return hashTypedData({
    domain: { ...SPLITTER_EIP712_DOMAIN, chainId, verifyingContract: splitter },
    types: ELIGIBLE_REVENUE_TYPES,
    primaryType: "EligibleRevenue",
    message: auth,
  });
}

export type AttestationOutcome =
  | { asset: Address | null; status: "DISABLED" | "ATTESTOR_MISMATCH" | "BINDING_MISMATCH" | "NO_CHECKPOINT" | "LEDGER_HALTED"; reason: string }
  | { asset: Address; status: "UP_TO_DATE" | "ASSET_NOT_APPROVED" | "STALE_EVIDENCE"; cumulative: string }
  | { asset: Address; status: "RECONCILIATION_MISMATCH"; cumulative: string; reason: string }
  | { asset: Address; status: "AUTHORIZED"; cumulative: string; nonce: string; evidenceBlock: string; txHash: Hex };

/** Launch tokens whose frozen snapshot is 70/20/10 eligible, read at `blockNumber`. */
export type EligibleLaunchResolver = (ledger: Ledger, blockNumber: bigint) => Promise<Set<Address>>;

/**
 * Recomputes the cumulative eligible revenue from finalised indexed events and
 * relays a signed ceiling raise for every approved asset whose on-chain
 * ceiling is behind. Idempotent: an up-to-date asset is skipped, and the
 * on-chain nonce/ceiling checks make any replay a revert.
 */
export async function syncRevenueAttestations(
  ctx: AppContext,
  load: () => Promise<{ ledger: Ledger; checkpoint: bigint | null }>,
  eligibleLaunches: EligibleLaunchResolver,
  /** W05: refreshes the ledger self-check for the evidence block before the first signature. */
  refreshIntegrity?: (checkpoint: bigint) => Promise<void>,
): Promise<AttestationOutcome[]> {
  const splitter = ctx.cfg.addresses.revenueSplitter;
  const escrow = ctx.cfg.addresses.feeEscrow;
  if (!splitter || !escrow) return [];
  const signer = ctx.revenueAttestor;
  if (!signer) return [{ asset: null, status: "DISABLED", reason: "No revenue attestor key configured: no ceilings are signed and pulls fail closed." }];
  const role = ctx.signers?.status("revenue");
  if (role && !role.enabled) return [{ asset: null, status: "DISABLED", reason: `Revenue attestor signing is disabled: ${role.reason}` }];
  if (ctx.cfg.chainId === ROBINHOOD_CHAIN_ID && !REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED) {
    return [{ asset: null, status: "DISABLED", reason: "PRODUCTION_BLOCKED: production revenue attestation is disabled pending W05 custody approval." }];
  }
  // W05 fail-closed: a halted ledger (materialized/reference divergence or an
  // unexplained splitter deficit) blocks every signature until an operator
  // clears it after a passing self-check.
  const integrity = await ledgerIntegrity(ctx.db, ctx.cfg.chainId);
  if (integrity?.halted) return [{ asset: null, status: "LEDGER_HALTED", reason: `LEDGER_HALTED: ${integrity.haltReason ?? "integrity failure"}` }];
  const sp = { address: splitter, abi: forgeProtocolRevenueSplitterAbi } as const;
  const [onchainAttestor, onchainEscrow, onchainFactory] = await Promise.all([
    ctx.client.readContract({ ...sp, functionName: "revenueAttestor" }),
    ctx.client.readContract({ ...sp, functionName: "feeEscrow" }),
    ctx.client.readContract({ ...sp, functionName: "forgeFactory" }),
  ]);
  if (onchainAttestor !== signer.address) {
    return [{ asset: null, status: "ATTESTOR_MISMATCH", reason: `The splitter's attestor is ${onchainAttestor}, not this service's key; nothing is signed.` }];
  }
  if (onchainEscrow !== escrow || onchainFactory !== ctx.cfg.addresses.factory) {
    return [{ asset: null, status: "BINDING_MISMATCH", reason: "The splitter's escrow/factory wiring differs from this deployment; nothing is signed." }];
  }
  const { ledger, checkpoint } = await load();
  if (checkpoint === null) return [{ asset: null, status: "NO_CHECKPOINT", reason: "The indexer has no checkpoint yet." }];

  const eligible = verifiedEligibleRevenue(ledger, splitter, await eligibleLaunches(ledger, checkpoint), checkpoint);
  const out: AttestationOutcome[] = [];
  const head = await ctx.client.getBlock({ blockTag: "latest" });
  for (const [asset, cumulative] of eligible) {
    const approved = await ctx.client.readContract({ ...sp, functionName: "approvedAsset", args: [asset] });
    if (!approved) {
      out.push({ asset, status: "ASSET_NOT_APPROVED", cumulative: cumulative.toString() });
      continue;
    }
    const live = await ctx.client.readContract({ ...sp, functionName: "ledger", args: [asset] });
    if (cumulative === live.eligibleCeiling) {
      out.push({ asset, status: "UP_TO_DATE", cumulative: cumulative.toString() });
      continue;
    }
    if (cumulative < live.eligibleCeiling) {
      // The on-chain ceiling is above what finalised evidence supports
      // (e.g. evidence later reorganised out). Never lowered; reported.
      out.push({ asset, status: "RECONCILIATION_MISMATCH", cumulative: cumulative.toString(), reason: `On-chain ceiling ${live.eligibleCeiling} exceeds recomputed eligible revenue ${cumulative}.` });
      continue;
    }
    if (head.number - checkpoint > MAX_EVIDENCE_LAG_BLOCKS) {
      out.push({ asset, status: "STALE_EVIDENCE", cumulative: cumulative.toString() });
      continue;
    }
    // Conservation cross-check at the evidence block: eligible credits can
    // never exceed what the escrow actually debited + still holds for the key.
    const at = { blockNumber: checkpoint } as const;
    const [atLedger, escrowed] = await Promise.all([
      ctx.client.readContract({ ...sp, functionName: "ledger", args: [asset], ...at }),
      asset === NATIVE
        ? ctx.client.readContract({ address: escrow, abi: ponsV2FeeEscrowAbi, functionName: "balanceOf", args: [splitter], ...at })
        : ctx.client.readContract({ address: escrow, abi: ponsV2FeeEscrowAbi, functionName: "balanceOfToken", args: [splitter, asset], ...at }),
    ]);
    if (cumulative > atLedger.escrowClaimed + escrowed) {
      out.push({ asset, status: "RECONCILIATION_MISMATCH", cumulative: cumulative.toString(), reason: `Recomputed eligible revenue ${cumulative} exceeds escrow claimed + held (${atLedger.escrowClaimed + escrowed}) at block ${checkpoint}.` });
      continue;
    }
    if (refreshIntegrity) await refreshIntegrity(checkpoint);
    const blocked = await signingBlockedReason(ctx.db, ctx.cfg.chainId);
    if (blocked) {
      out.push({ asset, status: "LEDGER_HALTED", reason: blocked });
      break;
    }
    const evidence = await ctx.client.getBlock({ blockNumber: checkpoint });
    const auth: EligibleRevenueAuth = {
      escrow,
      factory: ctx.cfg.addresses.factory,
      asset,
      cumulativeEligible: cumulative,
      nonce: live.authNonce + 1n,
      deadline: head.timestamp + AUTHORIZATION_TTL_SECONDS,
      evidenceBlock: checkpoint,
      evidenceBlockHash: evidence.hash,
    };
    const digest = eligibleRevenueDigest(ctx.cfg.chainId, splitter, auth);
    const onchainDigest = await ctx.client.readContract({ ...sp, functionName: "eligibleRevenueDigest", args: [auth] });
    if (onchainDigest !== digest) throw new Error("EIP-712 parity failure: local and on-chain EligibleRevenue digests differ.");
    // W05: custody signs only through the signing-policy guard, which re-derives the digest from
    // the typed data against the revenue role's allowlist (this splitter, this chain, EligibleRevenue).
    const { signature, digest: guarded } = await signer.signTypedData(
      { domain: { ...SPLITTER_EIP712_DOMAIN, chainId: ctx.cfg.chainId, verifyingContract: splitter }, types: ELIGIBLE_REVENUE_TYPES, primaryType: "EligibleRevenue", message: { ...auth } },
      { requestedBy: "forge:revenue-attestor" },
    );
    if (guarded !== digest) throw new Error("EIP-712 parity failure: custody guard digest differs.");
    const txHash = await ctx.relayer.writeContract({ ...sp, functionName: "authorizeEligibleRevenue", args: [auth, signature] });
    const receipt = await ctx.client.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(`authorizeEligibleRevenue reverted (${txHash}).`);
    await audit(ctx.db, "forge:revenue-attestor", "revenue_ceiling_authorized", `asset:${asset}`, {
      cumulativeEligible: cumulative,
      nonce: auth.nonce,
      evidenceBlock: checkpoint,
      evidenceBlockHash: evidence.hash,
      txHash,
    });
    out.push({ asset, status: "AUTHORIZED", cumulative: cumulative.toString(), nonce: auth.nonce.toString(), evidenceBlock: checkpoint.toString(), txHash });
  }
  return out;
}
