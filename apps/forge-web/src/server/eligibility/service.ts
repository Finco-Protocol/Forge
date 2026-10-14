/**
 * Forge eligibility service — the operational backend for the W02 M-ELIG
 * contracts. One call proves, in order:
 *   GitHub admin (fresh) → App installation → wallet binding → repo id
 *   → live registry state → (bind/renew op signed, relayed, CONFIRMED)
 *   → fresh EligibilityAttestation under the CURRENT binding epoch.
 */
import type { Address } from "viem";
import { encodeAttestationPayload } from "@/shared/forge-typed-data";
import type { AppContext } from "../context";
import { readRegistryState, bindingActiveFor } from "../chain/forge";
import { ForgeError } from "../errors";
import { rateLimit } from "../ratelimit";
import { uuid } from "../crypto";
import { verifyRepository, type VerificationRecord } from "../github/verify";
import { activeWalletBinding } from "../wallet/siwe";
import { applyRegistryOp, withRepoLock } from "./registry-ops";

/** Renew the binding when less than this remains of its evidence horizon. */
const RENEW_WINDOW_SECONDS = 24n * 3600n;

export interface EligibilityResult {
  verification: VerificationRecord;
  creator: Address;
  binding: { epoch: bigint; expiresAt: bigint; opDigest: string | null; txHash: string | null; renewed: boolean };
  attestation: { id: string; issuedAt: bigint; expiresAt: bigint; digest: string; payload: `0x${string}` };
}

export async function establishEligibility(
  ctx: AppContext,
  who: { githubUserId: number; githubLogin: string; userToken: string },
  repo: { repoId: number; installationId: number },
): Promise<EligibilityResult> {
  const wallet = await activeWalletBinding(ctx.db, who.githubUserId);
  if (!wallet) throw new ForgeError("WALLET_NOT_BOUND", "Bind a wallet to your GitHub account first.", 403);
  await rateLimit(ctx.db, `eligibility:user:${who.githubUserId}`, 30, 3600);

  // Revalidated live for every attestation: never reuse earlier evidence.
  const verification = await verifyRepository(ctx, {
    userToken: who.userToken,
    githubUserId: who.githubUserId,
    githubLogin: who.githubLogin,
    repoId: repo.repoId,
    installationId: repo.installationId,
    wallet: { bindingId: wallet.id, address: wallet.address },
  });
  const repoId = BigInt(verification.repoId);
  const requestedBy = `github:${who.githubUserId}`;

  return withRepoLock(repoId, async () => {
    let state = await readRegistryState(ctx.client, ctx.cfg.addresses, repoId);
    let opDigest: string | null = null;
    let txHash: string | null = null;
    let renewed = false;
    const active = bindingActiveFor(state, wallet.address);
    if (!active || state.binding.expiresAt - state.blockTimestamp < RENEW_WINDOW_SECONDS) {
      const applied = await applyRegistryOp(
        ctx,
        {
          repoId,
          creator: wallet.address,
          repoFullName: verification.fullName,
          revoke: false,
          verificationId: verification.id,
          reason: active ? "renew" : state.binding.exists && state.binding.revokedAt === 0n ? "rebind" : "bind",
          requestedBy,
        },
        state,
      );
      opDigest = applied.digest;
      txHash = applied.txHash;
      renewed = active;
      state = await readRegistryState(ctx.client, ctx.cfg.addresses, repoId);
      if (!bindingActiveFor(state, wallet.address) || state.bindingEpoch !== applied.bindingEpoch) {
        throw new ForgeError("REGISTRY_STATE_INCONSISTENT", "Binding not active after confirmation; refusing to attest.", 502);
      }
    }

    const issuedAt = state.blockTimestamp;
    let expiresAt = issuedAt + BigInt(ctx.cfg.policy.attestationTtlSeconds);
    if (expiresAt > state.binding.expiresAt) expiresAt = state.binding.expiresAt;
    const att = { githubRepoId: repoId, creator: wallet.address, bindingEpoch: state.bindingEpoch, issuedAt, expiresAt };
    const { digest, signature } = await ctx.authority.signAttestation(att, { verificationId: verification.id, requestedBy });
    const payload = encodeAttestationPayload(issuedAt, expiresAt, signature);
    const id = uuid();
    await ctx.db.query(
      `INSERT INTO attestations(id, verification_id, repo_id, creator, binding_epoch, issued_at, expires_at, digest, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, verification.id, repoId.toString(), wallet.address, state.bindingEpoch.toString(), issuedAt.toString(), expiresAt.toString(), digest, payload],
    );
    return {
      verification,
      creator: wallet.address,
      binding: { epoch: state.bindingEpoch, expiresAt: state.binding.expiresAt, opDigest, txHash, renewed },
      attestation: { id, issuedAt, expiresAt, digest, payload },
    };
  });
}
