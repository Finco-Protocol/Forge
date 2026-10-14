/**
 * Strict signing policy for the Forge eligibility authority. The ONLY two
 * things the authority key ever signs are:
 *   1. ForgeBindingRegistry.BindingOp       (bind / revoke)
 *   2. ForgeLaunchAuthorizer.EligibilityAttestation
 * Each request is re-derived from durable state and live chain state before
 * any digest reaches custody; every decision is recorded (allowed or denied).
 * There is no HTTP endpoint that reaches this module with caller-chosen data.
 */
import { getAddress, hashTypedData, type Address, type Hex } from "viem";
import { forgeBindingRegistryAbi, forgeLaunchAuthorizerAbi } from "@/shared/abis.generated";
import {
  bindingOpTypes,
  eligibilityAttestationTypes,
  launchDomain,
  MAX_ATTESTATION_AGE_SECONDS,
  MAX_OP_VALIDITY_SECONDS,
  registryDomain,
  type BindingOp,
} from "@/shared/forge-typed-data";
import type { ForgeConfig } from "../config";
import type { Db } from "../db";
import type { ForgePublicClient } from "../chain/clients";
import { readRegistryState, bindingActiveFor } from "../chain/forge";
import { ForgeError } from "../errors";
import { rateLimit } from "../ratelimit";
import type { DigestSigner } from "./types";
import { readControl } from "../ops/controls";

export interface SignerDeps {
  cfg: ForgeConfig;
  db: Db;
  client: ForgePublicClient;
  authority: DigestSigner;
}

interface VerificationRow {
  id: string;
  repo_id: string;
  wallet_address: string | null;
  wallet_binding_id: string | null;
  full_name: string;
  user_permission: string;
  installation_permission: string;
  expires_at: Date;
  revoked_at: Date | null;
  binding_revoked_at: Date | null;
  repo_ineligible: string | null;
}

export class AuthoritySigner {
  constructor(private readonly d: SignerDeps) {}

  get address(): Address {
    return this.d.authority.address;
  }

  private async record(kind: string, digest: Hex | null, decision: "allowed" | "denied", reason: string | null, requestedBy: string) {
    await this.d.db.query("INSERT INTO signing_requests(role, kind, digest, decision, reason, requested_by) VALUES ('authority',$1,$2,$3,$4,$5)", [
      kind,
      digest,
      decision,
      reason,
      requestedBy,
    ]);
  }

  private async deny(kind: string, reason: string, requestedBy: string): Promise<never> {
    await this.record(kind, null, "denied", reason, requestedBy);
    throw new ForgeError("SIGNING_POLICY_DENIED", `Authority signing refused: ${reason}`, 403, { reason });
  }

  /** The verification must be fresh, unrevoked, admin on BOTH sources, and bound to an active wallet binding for `creator`. */
  private async requireVerification(kind: string, verificationId: string | undefined, repoId: bigint, creator: Address, requestedBy: string, fullName?: string) {
    if (!verificationId) return this.deny(kind, "no verification evidence supplied", requestedBy);
    const { rows } = await this.d.db.query<VerificationRow>(
      `SELECT v.id, v.repo_id::text, v.wallet_address, v.wallet_binding_id::text, v.full_name, v.user_permission, v.installation_permission,
              v.expires_at, v.revoked_at, wb.revoked_at AS binding_revoked_at, r.ineligible_reason AS repo_ineligible
         FROM verifications v
         LEFT JOIN wallet_bindings wb ON wb.id = v.wallet_binding_id
         LEFT JOIN repositories r ON r.repo_id = v.repo_id
        WHERE v.id = $1`,
      [verificationId],
    );
    const v = rows[0];
    if (!v) return this.deny(kind, "unknown verification", requestedBy);
    if (BigInt(v.repo_id) !== repoId) return this.deny(kind, "verification is for a different repository", requestedBy);
    if (!v.wallet_address || getAddress(v.wallet_address) !== getAddress(creator)) return this.deny(kind, "verification is for a different wallet", requestedBy);
    if (v.revoked_at) return this.deny(kind, "verification revoked", requestedBy);
    if (v.expires_at.getTime() <= Date.now()) return this.deny(kind, "verification stale", requestedBy);
    if (v.user_permission !== "admin" || v.installation_permission !== "admin") return this.deny(kind, "admin not proven by both sources", requestedBy);
    if (!v.wallet_binding_id || v.binding_revoked_at) return this.deny(kind, "wallet binding revoked", requestedBy);
    if (v.repo_ineligible) return this.deny(kind, `repository ineligible (${v.repo_ineligible})`, requestedBy);
    if (fullName !== undefined && v.full_name !== fullName) return this.deny(kind, "repository name does not match evidence", requestedBy);
  }

  private async limits(kind: string, repoId: bigint) {
    await rateLimit(this.d.db, `sign:global:${kind}`, this.d.cfg.policy.signingRateLimitPerHour * 20, 3600);
    await rateLimit(this.d.db, `sign:repo:${repoId}:${kind}`, this.d.cfg.policy.signingRateLimitPerHour, 3600);
  }

  async signBindingOp(op: BindingOp, req: { verificationId?: string; reason: string; requestedBy: string }): Promise<{ digest: Hex; signature: Hex }> {
    const kind = op.revoke ? "binding_revoke" : "binding_bind";
    const { cfg, client } = this.d;
    // W05: the emergency lockdown blocks NEW bindings; revocations always proceed.
    if (!op.revoke && (await readControl(this.d.db, "emergency_lockdown")).active) return this.deny(kind, "emergency lockdown engaged", req.requestedBy);
    await this.limits(kind, op.githubRepoId);
    const state = await readRegistryState(client, cfg.addresses, op.githubRepoId);
    if (getAddress(state.authority) !== getAddress(this.address)) return this.deny(kind, "registry authority is not this signer", req.requestedBy);
    // Correction B: exact next sequence AND the current head — never an obsolete one.
    if (op.opNonce !== state.opSequence + 1n) return this.deny(kind, "obsolete or gapped registry sequence", req.requestedBy);
    if (op.parentOpDigest !== state.headOpDigest) return this.deny(kind, "parent is not the current registry head", req.requestedBy);
    const now = state.blockTimestamp;
    if (op.opDeadline <= now || op.opDeadline > now + BigInt(MAX_OP_VALIDITY_SECONDS)) return this.deny(kind, "operation deadline out of policy", req.requestedBy);
    if (op.githubRepoId <= 0n) return this.deny(kind, "zero repository id", req.requestedBy);
    if (op.revoke) {
      if (!state.binding.exists || state.binding.revokedAt !== 0n) return this.deny(kind, "no active binding to revoke", req.requestedBy);
      if (getAddress(state.binding.creator) !== getAddress(op.creator)) return this.deny(kind, "revocation names a different creator", req.requestedBy);
      if (!req.reason) return this.deny(kind, "revocation requires a reason", req.requestedBy);
    } else {
      if (op.bindingExpiresAt <= now || op.bindingExpiresAt > now + BigInt(cfg.policy.bindingHorizonSeconds)) {
        return this.deny(kind, "binding horizon out of policy", req.requestedBy);
      }
      await this.requireVerification(kind, req.verificationId, op.githubRepoId, op.creator, req.requestedBy, op.repoFullName);
    }
    const digest = hashTypedData({ domain: registryDomain(cfg.chainId, cfg.addresses.registry), types: bindingOpTypes, primaryType: "BindingOp", message: op });
    const onchain = await client.readContract({ address: cfg.addresses.registry, abi: forgeBindingRegistryAbi, functionName: "attestationDigestForBindingOp", args: [op] });
    if (onchain !== digest) return this.deny(kind, "EIP-712 digest parity failure", req.requestedBy);
    const signature = await this.d.authority.signDigest(digest);
    await this.record(kind, digest, "allowed", req.reason, req.requestedBy);
    return { digest, signature };
  }

  async signAttestation(
    att: { githubRepoId: bigint; creator: Address; bindingEpoch: bigint; issuedAt: bigint; expiresAt: bigint },
    req: { verificationId: string; requestedBy: string },
  ): Promise<{ digest: Hex; signature: Hex }> {
    const kind = "eligibility_attestation";
    const { cfg, client } = this.d;
    if ((await readControl(this.d.db, "emergency_lockdown")).active) return this.deny(kind, "emergency lockdown engaged", req.requestedBy);
    await this.limits(kind, att.githubRepoId);
    await this.requireVerification(kind, req.verificationId, att.githubRepoId, att.creator, req.requestedBy);
    const state = await readRegistryState(client, cfg.addresses, att.githubRepoId);
    if (!bindingActiveFor(state, att.creator)) return this.deny(kind, "registry binding is not active for this creator", req.requestedBy);
    if (att.bindingEpoch !== state.bindingEpoch) return this.deny(kind, "obsolete binding epoch", req.requestedBy);
    const authority = await client.readContract({ address: cfg.addresses.authorizer, abi: forgeLaunchAuthorizerAbi, functionName: "eligibilityAuthority" });
    if (getAddress(authority) !== getAddress(this.address)) return this.deny(kind, "authorizer authority is not this signer", req.requestedBy);
    const now = state.blockTimestamp;
    if (att.issuedAt > now) return this.deny(kind, "future-dated attestation", req.requestedBy);
    if (att.expiresAt <= att.issuedAt) return this.deny(kind, "inverted attestation window", req.requestedBy);
    const ttl = BigInt(Math.min(cfg.policy.attestationTtlSeconds, MAX_ATTESTATION_AGE_SECONDS));
    if (att.expiresAt - att.issuedAt > ttl) return this.deny(kind, "attestation lifetime out of policy", req.requestedBy);
    if (att.expiresAt > state.binding.expiresAt) return this.deny(kind, "attestation outlives the binding evidence", req.requestedBy);
    const digest = hashTypedData({
      domain: launchDomain(cfg.chainId, cfg.addresses.authorizer),
      types: eligibilityAttestationTypes,
      primaryType: "EligibilityAttestation",
      message: att,
    });
    const onchain = await client.readContract({
      address: cfg.addresses.authorizer,
      abi: forgeLaunchAuthorizerAbi,
      functionName: "attestationDigest",
      args: [att.githubRepoId, att.creator, att.bindingEpoch, att.issuedAt, att.expiresAt],
    });
    if (onchain !== digest) return this.deny(kind, "EIP-712 digest parity failure", req.requestedBy);
    const signature = await this.d.authority.signDigest(digest);
    await this.record(kind, digest, "allowed", null, req.requestedBy);
    return { digest, signature };
  }
}
