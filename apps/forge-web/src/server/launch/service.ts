/**
 * Launch workspace backend: draft → economics preview → authorization
 * (eligibility + exact LaunchIntent) → creator EIP-712 consent → simulation
 * → submission tracking → confirmation (indexer) / explicit recovery.
 */
import { z } from "zod";
import {
  decodeEventLog,
  decodeFunctionData,
  getAddress,
  hashTypedData,
  isAddress,
  isHex,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import { forgeLaunchAuthorizerAbi, ponsV2LaunchFactoryAbi } from "@/shared/abis.generated";
import {
  canonicalExemptionHash,
  launchAuthorizationMessage,
  launchAuthorizationTypes,
  launchDomain,
  tokenMetadataHash,
  ZERO_ADDRESS,
  MAX_SNIPE_TAX_EXEMPTIONS,
  type LaunchIntent,
  type Socials,
} from "@/shared/forge-typed-data";
import type { AppContext } from "../context";
import { readCreatorNonce, readEconomics, readRegistryState, bindingActiveFor, predictLaunchAddresses, type EconomicsSnapshot } from "../chain/forge";
import { ForgeError, refuse } from "../errors";
import { randomToken, uuid } from "../crypto";
import { audit } from "../audit";
import { activeWalletBinding } from "../wallet/siwe";
import { establishEligibility } from "../eligibility/service";
import { randomBytes } from "node:crypto";

const MAX_TOTAL_TRADE_FEE_BPS = 2000; // PonsV2LaunchFactory private constant

const addr = z.string().refine((v) => isAddress(v, { strict: false }), "invalid address").transform((v) => getAddress(v));
const text = (max: number) => z.string().trim().max(max);
const url = z
  .string()
  .trim()
  .max(512)
  .refine((v) => v === "" || /^(https:\/\/|ipfs:\/\/)[^\s]+$/.test(v), "must be https:// or ipfs://");

export const DraftInput = z.object({
  repoId: z.number().int().positive(),
  installationId: z.number().int().positive(),
  name: text(64).min(1),
  symbol: z.string().trim().min(1).max(16).regex(/^[A-Za-z0-9$_.-]+$/, "letters, digits and $ _ . - only"),
  description: text(1000).default(""),
  logo: url.default(""),
  socials: z
    .object({ twitter: url.default(""), telegram: url.default(""), discord: url.default(""), website: url.default(""), farcaster: url.default("") })
    .default({}),
  launchConfigId: z.number().int().min(0).default(0),
  pairToken: addr.default(ZERO_ADDRESS),
  creatorFeeRecipient: addr.optional(),
  creatorTaxBps: z.number().int().min(0).max(10_000).default(0),
  buybackEnabled: z.boolean().default(false),
  snipeTaxExemptions: z.array(addr).max(MAX_SNIPE_TAX_EXEMPTIONS).default([]),
  salt: z
    .string()
    .refine((v) => isHex(v) && v.length === 66, "32-byte hex")
    .optional(),
});
export type DraftInput = z.infer<typeof DraftInput>;

export interface DraftParams {
  repoId: number;
  installationId: number;
  name: string;
  symbol: string;
  description: string;
  logo: string;
  socials: Socials;
  launchConfigId: number;
  pairToken: Address;
  creatorFeeRecipient: Address; // effective
  creatorFeeRecipientExplicit: boolean;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  snipeTaxExemptions: Address[];
  exemptionListHash: Hex;
  salt: Hex;
}

type GithubWho = { githubUserId: number; githubLogin: string };

function validateAgainstEconomics(p: DraftParams, e: EconomicsSnapshot, creator: Address, canLaunch: boolean) {
  if (!e.configEnabled) refuse("LAUNCH_CONFIG_DISABLED", "This launch configuration is disabled by the factory owner.");
  if (!e.launchEnabled && !canLaunch) refuse("LAUNCHES_CLOSED", "Public launches are closed and this wallet is not whitelisted.");
  if (!e.pairApproved) refuse("PAIR_NOT_APPROVED", "Quote asset is not approved on this factory.");
  if (BigInt(p.creatorTaxBps) > BigInt(e.maxCreatorTaxBps)) refuse("CREATOR_TAX_TOO_HIGH", `Creator tax exceeds the factory maximum of ${e.maxCreatorTaxBps} bps.`);
  if (Number(e.curveFeeBps) + p.creatorTaxBps > MAX_TOTAL_TRADE_FEE_BPS || e.hookFeeBps + p.creatorTaxBps > MAX_TOTAL_TRADE_FEE_BPS) {
    refuse("COMBINED_FEE_TOO_HIGH", "Curve/hook fee plus creator tax exceeds the 20% factory ceiling.");
  }
  void creator;
}

export async function createDraft(ctx: AppContext, who: GithubWho, raw: unknown) {
  const parsed = DraftInput.safeParse(raw);
  if (!parsed.success) throw new ForgeError("INVALID_PARAMS", "Invalid launch parameters.", 400, { issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  const input = parsed.data;
  const wallet = await activeWalletBinding(ctx.db, who.githubUserId);
  if (!wallet) refuse("WALLET_NOT_BOUND", "Bind a wallet first.", 403);
  const creator = wallet!.address;
  const verified = await ctx.db.query(
    "SELECT 1 FROM verifications WHERE repo_id = $1 AND github_user_id = $2 AND revoked_at IS NULL AND expires_at > now() LIMIT 1",
    [input.repoId, who.githubUserId],
  );
  if (!verified.rows.length) refuse("NOT_VERIFIED", "Verify repository administration first.", 403);

  const params: DraftParams = {
    repoId: input.repoId,
    installationId: input.installationId,
    name: input.name,
    symbol: input.symbol,
    description: input.description,
    logo: input.logo,
    socials: input.socials,
    launchConfigId: input.launchConfigId,
    pairToken: input.pairToken,
    creatorFeeRecipient: input.creatorFeeRecipient ?? creator,
    creatorFeeRecipientExplicit: input.creatorFeeRecipient !== undefined,
    creatorTaxBps: input.creatorTaxBps,
    buybackEnabled: input.buybackEnabled,
    snipeTaxExemptions: input.snipeTaxExemptions,
    exemptionListHash: (() => {
      try {
        return canonicalExemptionHash(input.snipeTaxExemptions);
      } catch (e) {
        return refuse("INVALID_EXEMPTIONS", (e as Error).message);
      }
    })(),
    salt: (input.salt as Hex | undefined) ?? (`0x${randomBytes(32).toString("hex")}` as Hex),
  };
  const { economics, predicted } = await previewFor(ctx, params, creator);
  const id = uuid();
  await ctx.db.query(
    `INSERT INTO launch_drafts(id, github_user_id, creator, repo_id, params, economics, economics_digest, predicted_token, predicted_curve)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, who.githubUserId, creator, params.repoId, JSON.stringify(params), JSON.stringify(economics), economics.digest, predicted.token, predicted.curve],
  );
  await audit(ctx.db, `github:${who.githubUserId}`, "launch_draft_created", `draft:${id}`, { repoId: params.repoId, economicsDigest: economics.digest });
  return { id, params, economics, predicted };
}

async function previewFor(ctx: AppContext, params: DraftParams, creator: Address) {
  const economics = await readEconomics(ctx.client, ctx.cfg.addresses, BigInt(params.launchConfigId), params.pairToken);
  const canLaunch = await ctx.client.readContract({ address: ctx.cfg.addresses.factory, abi: ponsV2LaunchFactoryAbi, functionName: "canLaunch", args: [creator] });
  validateAgainstEconomics(params, economics, creator, canLaunch);
  const predicted = await predictLaunchAddresses(ctx.client, ctx.cfg.addresses, economics, creator, {
    name: params.name,
    symbol: params.symbol,
    logo: params.logo,
    description: params.description,
    socials: params.socials,
    creatorFeeRecipient: params.creatorFeeRecipient,
    creatorTaxBps: params.creatorTaxBps,
    buybackEnabled: params.buybackEnabled,
    salt: params.salt,
  });
  const code = await ctx.client.getCode({ address: predicted.curve });
  if (code && code !== "0x") refuse("SALT_IN_USE", "A launch already exists at the predicted address; choose a new salt.", 409);
  return { economics, predicted };
}

interface DraftRow {
  id: string;
  github_user_id: string;
  creator: string;
  repo_id: string;
  params: DraftParams;
  economics: EconomicsSnapshot;
  economics_digest: string;
  predicted_token: string;
  predicted_curve: string;
}

async function loadDraft(ctx: AppContext, who: GithubWho, id: string): Promise<DraftRow> {
  if (!z.string().uuid().safeParse(id).success) refuse("NOT_FOUND", "Draft not found.", 404);
  const { rows } = await ctx.db.query<DraftRow>("SELECT * FROM launch_drafts WHERE id = $1", [id]);
  const d = rows[0];
  if (!d || Number(d.github_user_id) !== who.githubUserId) return refuse("NOT_FOUND", "Draft not found.", 404);
  return d;
}

export async function getDraft(ctx: AppContext, who: GithubWho, id: string) {
  const d = await loadDraft(ctx, who, id);
  const current = await readEconomics(ctx.client, ctx.cfg.addresses, BigInt(d.params.launchConfigId), d.params.pairToken);
  const intents = await ctx.db.query("SELECT id, status, tx_hash, token_address, failure_reason, created_at FROM launch_intents WHERE draft_id = $1 ORDER BY created_at DESC", [id]);
  return {
    id: d.id,
    params: d.params,
    economics: d.economics,
    currentEconomics: current,
    economicsStale: current.digest !== d.economics_digest,
    predicted: { token: d.predicted_token, curve: d.predicted_curve },
    intents: intents.rows,
  };
}

/** Explicit acceptance of changed economics: updates the snapshot; any unsigned intent is superseded and must be re-signed. */
export async function refreshDraftEconomics(ctx: AppContext, who: GithubWho, id: string) {
  const d = await loadDraft(ctx, who, id);
  const { economics, predicted } = await previewFor(ctx, d.params, getAddress(d.creator));
  await ctx.db.tx(async (q) => {
    await q.query("UPDATE launch_drafts SET economics = $2, economics_digest = $3, predicted_token = $4, predicted_curve = $5, updated_at = now() WHERE id = $1", [
      id,
      JSON.stringify(economics),
      economics.digest,
      predicted.token,
      predicted.curve,
    ]);
    await q.query("UPDATE launch_intents SET status = 'superseded', failure_reason = 'economics_changed', updated_at = now() WHERE draft_id = $1 AND status IN ('awaiting_signature','signed')", [id]);
  });
  await audit(ctx.db, `github:${who.githubUserId}`, "launch_economics_accepted", `draft:${id}`, { from: d.economics_digest, to: economics.digest });
  return getDraft(ctx, who, id);
}

interface IntentRow {
  id: string;
  draft_id: string;
  verification_id: string;
  attestation_id: string;
  creator: string;
  repo_id: string;
  intent: Record<string, string | number>;
  consent_digest: string;
  nonce: string;
  expires_at: string;
  creator_signature: string | null;
  status: string;
  tx_hash: string | null;
  token_address: string | null;
  curve_address: string | null;
  failure_reason: string | null;
}

export function intentFromJson(j: Record<string, string | number>): LaunchIntent {
  return {
    factory: getAddress(String(j.factory)),
    creator: getAddress(String(j.creator)),
    githubRepoId: BigInt(j.githubRepoId!),
    launchConfigId: BigInt(j.launchConfigId!),
    pairToken: getAddress(String(j.pairToken)),
    tokenMetadataHash: j.tokenMetadataHash as Hex,
    economicsDigest: j.economicsDigest as Hex,
    salt: j.salt as Hex,
    expiresAt: BigInt(j.expiresAt!),
    nonce: BigInt(j.nonce!),
    creatorTaxBps: Number(j.creatorTaxBps),
    exemptionListHash: j.exemptionListHash as Hex,
  };
}

const intentToJson = (i: LaunchIntent) => Object.fromEntries(Object.entries(i).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));

function typedDataFor(ctx: AppContext, intent: LaunchIntent, p: DraftParams) {
  return {
    domain: launchDomain(ctx.cfg.chainId, ctx.cfg.addresses.authorizer),
    types: launchAuthorizationTypes,
    primaryType: "LaunchAuthorization" as const,
    message: launchAuthorizationMessage(intent, p.creatorFeeRecipient, p.buybackEnabled),
  };
}

export async function authorizeDraft(ctx: AppContext, who: GithubWho & { userToken: string }, draftId: string) {
  const d = await loadDraft(ctx, who, draftId);
  const p = d.params;
  const wallet = await activeWalletBinding(ctx.db, who.githubUserId);
  if (!wallet) refuse("WALLET_NOT_BOUND", "Bind a wallet first.", 403);
  if (wallet!.address !== getAddress(d.creator)) refuse("WALLET_CHANGED", "Your bound wallet changed since this draft was created; create a new draft.", 409);

  const live = await ctx.db.query<IntentRow>(
    "SELECT * FROM launch_intents WHERE draft_id = $1 AND status IN ('awaiting_signature','signed','submitted','included')",
    [draftId],
  );
  const existing = live.rows[0];
  if (existing && (existing.status === "submitted" || existing.status === "included")) {
    refuse("LAUNCH_IN_FLIGHT", "A launch transaction for this draft is already in flight.", 409, { intentId: existing.id });
  }
  const inflight = await ctx.db.query("SELECT id FROM launch_intents WHERE creator = $1 AND status IN ('submitted','included') LIMIT 1", [d.creator]);
  if (inflight.rows.length) refuse("LAUNCH_IN_FLIGHT", "Another launch from this wallet is in flight; wait for it to settle.", 409);

  const economics = await readEconomics(ctx.client, ctx.cfg.addresses, BigInt(p.launchConfigId), p.pairToken);
  if (economics.digest !== d.economics_digest) {
    refuse("STALE_ECONOMICS", "Factory economics changed since your preview. Review and accept the new terms; you must re-sign.", 409, {
      previous: d.economics_digest,
      current: economics.digest,
    });
  }

  const elig = await establishEligibility(ctx, who, { repoId: p.repoId, installationId: p.installationId });
  if (elig.creator !== getAddress(d.creator)) refuse("WALLET_CHANGED", "Bound wallet changed during authorization.", 409);
  const nonce = await readCreatorNonce(ctx.client, ctx.cfg.addresses, elig.creator);
  const block = await ctx.client.getBlock({ blockTag: "latest" });
  let expiresAt = block.timestamp + BigInt(ctx.cfg.policy.consentTtlSeconds);
  if (expiresAt > elig.attestation.expiresAt) expiresAt = elig.attestation.expiresAt;
  const intent: LaunchIntent = {
    factory: ctx.cfg.addresses.factory,
    creator: elig.creator,
    githubRepoId: BigInt(p.repoId),
    launchConfigId: BigInt(p.launchConfigId),
    pairToken: p.pairToken,
    tokenMetadataHash: tokenMetadataHash(p),
    economicsDigest: economics.digest,
    salt: p.salt,
    expiresAt,
    nonce,
    creatorTaxBps: p.creatorTaxBps,
    exemptionListHash: p.exemptionListHash,
  };
  const typed = typedDataFor(ctx, intent, p);
  const digest = hashTypedData(typed);
  // EIP-712 parity with the deployed authorizer (fail-closed).
  const onchain = await ctx.client.readContract({
    address: ctx.cfg.addresses.authorizer,
    abi: forgeLaunchAuthorizerAbi,
    functionName: "consentDigest",
    args: [intent, p.creatorFeeRecipient, p.buybackEnabled],
  });
  if (onchain !== digest) refuse("EIP712_PARITY_FAILED", "Consent digest does not match the authorizer; refusing.", 500);

  const id = uuid();
  await ctx.db.tx(async (q) => {
    // Older unsigned intents of this creator at the same nonce can never both land.
    await q.query(
      "UPDATE launch_intents SET status = 'superseded', failure_reason = 'reauthorized', updated_at = now() WHERE creator = $1 AND status IN ('awaiting_signature','signed')",
      [elig.creator],
    );
    await q.query(
      `INSERT INTO launch_intents(id, draft_id, verification_id, attestation_id, creator, repo_id, intent, consent_digest, nonce, expires_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'awaiting_signature')`,
      [id, draftId, elig.verification.id, elig.attestation.id, elig.creator, p.repoId, JSON.stringify(intentToJson(intent)), digest, nonce.toString(), expiresAt.toString()],
    );
  });
  await audit(ctx.db, `github:${who.githubUserId}`, "launch_authorized", `intent:${id}`, { digest, nonce, attestation: elig.attestation.digest });
  return {
    intentId: id,
    consentDigest: digest,
    typedData: JSON.parse(JSON.stringify(typed, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
    eligibility: {
      verificationId: elig.verification.id,
      commitSha: elig.verification.commitSha,
      bindingEpoch: elig.binding.epoch.toString(),
      bindingTx: elig.binding.txHash,
      attestationIssuedAt: elig.attestation.issuedAt.toString(),
      attestationExpiresAt: elig.attestation.expiresAt.toString(),
    },
    nonce: nonce.toString(),
    expiresAt: expiresAt.toString(),
  };
}

async function loadIntent(ctx: AppContext, who: GithubWho, id: string): Promise<{ row: IntentRow; draft: DraftRow }> {
  if (!z.string().uuid().safeParse(id).success) refuse("NOT_FOUND", "Intent not found.", 404);
  const { rows } = await ctx.db.query<IntentRow>("SELECT * FROM launch_intents WHERE id = $1", [id]);
  const row = rows[0];
  if (!row) return refuse("NOT_FOUND", "Intent not found.", 404);
  const draft = await loadDraft(ctx, who, row.draft_id);
  return { row, draft };
}

function tokenParamsFor(intent: LaunchIntent, p: DraftParams, signature: Hex, attestationPayload: Hex) {
  return {
    name: p.name,
    symbol: p.symbol,
    logo: p.logo,
    description: p.description,
    socials: p.socials,
    creatorFeeRecipient: p.creatorFeeRecipientExplicit ? p.creatorFeeRecipient : ZERO_ADDRESS,
    creatorTaxBps: p.creatorTaxBps,
    buybackEnabled: p.buybackEnabled,
    expectedEconomics: intent.economicsDigest,
    salt: intent.salt,
    githubRepoId: intent.githubRepoId,
    authorizationExpiresAt: intent.expiresAt,
    authorizationNonce: intent.nonce,
    creatorSignature: signature,
    attestationPayload,
  } as const;
}

function launchCall(intent: LaunchIntent, p: DraftParams, signature: Hex, attestationPayload: Hex) {
  const params = tokenParamsFor(intent, p, signature, attestationPayload);
  // Always the exemption-list overload: an empty list hashes to the same
  // canonical value the 3-argument overload binds (_EMPTY_EXEMPTION_HASH).
  return { functionName: "launchToken", args: [params, intent.launchConfigId, intent.pairToken, p.snipeTaxExemptions] } as const;
}

/** Re-checks every freshness condition the contracts will enforce, before the creator spends gas. */
async function preflight(ctx: AppContext, row: IntentRow, draft: DraftRow, intent: LaunchIntent) {
  const block = await ctx.client.getBlock({ blockTag: "latest" });
  if (intent.expiresAt < block.timestamp) refuse("INTENT_EXPIRED", "Launch authorization expired; re-authorize.", 409);
  const att = await ctx.db.query<{ expires_at: string; binding_epoch: string; payload: string }>("SELECT expires_at, binding_epoch, payload FROM attestations WHERE id = $1", [row.attestation_id]);
  const a = att.rows[0]!;
  if (BigInt(a.expires_at) < block.timestamp) refuse("ATTESTATION_EXPIRED", "Eligibility attestation expired; re-authorize.", 409);
  const v = await ctx.db.query<{ revoked_at: Date | null; revoke_reason: string | null }>("SELECT revoked_at, revoke_reason FROM verifications WHERE id = $1", [row.verification_id]);
  if (v.rows[0]?.revoked_at) refuse("VERIFICATION_REVOKED", `GitHub verification was revoked (${v.rows[0].revoke_reason}).`, 409);
  const state = await readRegistryState(ctx.client, ctx.cfg.addresses, intent.githubRepoId);
  if (!bindingActiveFor(state, intent.creator)) refuse("BINDING_NOT_ACTIVE", "Registry binding is no longer active.", 409);
  if (state.bindingEpoch !== BigInt(a.binding_epoch)) refuse("STALE_EPOCH", "Registry binding epoch changed; re-authorize.", 409);
  const nonce = await readCreatorNonce(ctx.client, ctx.cfg.addresses, intent.creator);
  if (nonce !== intent.nonce) refuse("NONCE_USED", "This authorization's nonce was already consumed; re-authorize.", 409);
  const e = await readEconomics(ctx.client, ctx.cfg.addresses, intent.launchConfigId, intent.pairToken);
  if (e.digest !== intent.economicsDigest || e.digest !== draft.economics_digest) refuse("STALE_ECONOMICS", "Factory economics changed; review and re-sign.", 409);
  return { attestationPayload: a.payload as Hex, launchFee: BigInt(e.launchFeeWei) };
}

export async function submitCreatorSignature(ctx: AppContext, who: GithubWho, intentId: string, signature: string) {
  const { row, draft } = await loadIntent(ctx, who, intentId);
  if (row.status !== "awaiting_signature" && row.status !== "signed") refuse("BAD_STATE", `Intent is ${row.status}.`, 409);
  if (!isHex(signature) || (signature.length - 2) / 2 !== 65) refuse("BAD_SIGNATURE", "Signature must be 65 bytes.");
  const intent = intentFromJson(row.intent);
  const p = draft.params;
  const typed = typedDataFor(ctx, intent, p);
  let signer: Address;
  try {
    signer = await recoverTypedDataAddress({ ...typed, signature: signature as Hex });
  } catch {
    return refuse("BAD_SIGNATURE", "Signature could not be recovered.");
  }
  if (getAddress(signer) !== intent.creator) refuse("WRONG_SIGNER", "Signature is not from the bound creator wallet.", 403);
  const { attestationPayload, launchFee } = await preflight(ctx, row, draft, intent);

  const call = launchCall(intent, p, signature as Hex, attestationPayload);
  let simulated: readonly [Address, Address];
  let gas: bigint;
  try {
    const sim = await ctx.client.simulateContract({
      account: intent.creator,
      address: ctx.cfg.addresses.factory,
      abi: ponsV2LaunchFactoryAbi,
      ...call,
      value: launchFee,
    });
    simulated = sim.result as readonly [Address, Address];
    gas = await ctx.client.estimateContractGas({ account: intent.creator, address: ctx.cfg.addresses.factory, abi: ponsV2LaunchFactoryAbi, ...call, value: launchFee });
  } catch (e) {
    const msg = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message.split("\n")[0] : String(e);
    return refuse("SIMULATION_FAILED", `Launch simulation reverted: ${msg}`, 409);
  }
  if (getAddress(simulated[0]) !== getAddress(draft.predicted_token) || getAddress(simulated[1]) !== getAddress(draft.predicted_curve)) {
    refuse("PREDICTION_MISMATCH", "Simulated addresses differ from the CREATE2 preview; refusing.", 409);
  }
  const gasPrice = await ctx.client.getGasPrice();
  await ctx.db.query("UPDATE launch_intents SET creator_signature = $2, status = 'signed', updated_at = now() WHERE id = $1", [intentId, signature]);
  return {
    intentId,
    status: "signed",
    tx: {
      address: ctx.cfg.addresses.factory,
      functionName: call.functionName,
      args: JSON.parse(JSON.stringify(call.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
      value: launchFee.toString(),
      chainId: ctx.cfg.chainId,
    },
    simulation: { token: simulated[0], curve: simulated[1], gas: gas.toString(), gasPrice: gasPrice.toString(), maxGasCostWei: (gas * gasPrice).toString(), launchFeeWei: launchFee.toString() },
  };
}

export async function recordSubmission(ctx: AppContext, who: GithubWho, intentId: string, txHash: string) {
  const { row, draft } = await loadIntent(ctx, who, intentId);
  if (row.status !== "signed") refuse("BAD_STATE", `Intent is ${row.status}.`, 409);
  if (!isHex(txHash) || txHash.length !== 66) refuse("BAD_TX_HASH", "Invalid transaction hash.");
  // The tx must exist and be THIS launch: from the creator, to the Forge factory, carrying this intent.
  let tx = null;
  for (let i = 0; i < 10 && !tx; i++) {
    tx = await ctx.client.getTransaction({ hash: txHash as Hex }).catch(() => null);
    if (!tx) await new Promise((r) => setTimeout(r, 300));
  }
  if (!tx) refuse("TX_NOT_FOUND", "Transaction not found on the configured chain.", 404);
  if (!tx!.to || getAddress(tx!.to) !== ctx.cfg.addresses.factory) refuse("WRONG_FACTORY", "Transaction does not target the Forge factory.", 400);
  if (getAddress(tx!.from) !== getAddress(row.creator)) refuse("WRONG_SENDER", "Transaction is not from the creator wallet.", 400);
  if (tx!.chainId !== undefined && tx!.chainId !== ctx.cfg.chainId) refuse("WRONG_CHAIN", "Transaction is for a different chain.", 400);
  const decoded = decodeFunctionData({ abi: ponsV2LaunchFactoryAbi, data: tx!.input });
  if (decoded.functionName !== "launchToken") refuse("WRONG_CALL", "Transaction is not a launch.", 400);
  const params = (decoded.args as unknown as [{ salt: Hex; authorizationNonce: bigint; creatorSignature: Hex }])[0];
  const intent = intentFromJson(row.intent);
  if (params.salt !== intent.salt || params.authorizationNonce !== intent.nonce || params.creatorSignature.toLowerCase() !== (row.creator_signature ?? "").toLowerCase()) {
    refuse("INTENT_MISMATCH", "Transaction does not carry this launch authorization.", 400);
  }
  await ctx.db.query("UPDATE launch_intents SET status = 'submitted', tx_hash = $2, updated_at = now() WHERE id = $1", [intentId, txHash.toLowerCase()]);
  await audit(ctx.db, `github:${who.githubUserId}`, "launch_submitted", `intent:${intentId}`, { txHash, draft: draft.id });
  return refreshIntent(ctx, intentId);
}

/** Advances an intent from chain state. Never marks a launch complete before the indexer confirms it. */
export async function refreshIntent(ctx: AppContext, intentId: string) {
  const { rows } = await ctx.db.query<IntentRow>("SELECT * FROM launch_intents WHERE id = $1", [intentId]);
  const row = rows[0];
  if (!row) return refuse("NOT_FOUND", "Intent not found.", 404);
  const block = await ctx.client.getBlock({ blockTag: "latest" });
  const set = async (status: string, extra: { token?: string; curve?: string; reason?: string } = {}) => {
    await ctx.db.query(
      "UPDATE launch_intents SET status = $2, token_address = COALESCE($3, token_address), curve_address = COALESCE($4, curve_address), failure_reason = COALESCE($5, failure_reason), updated_at = now() WHERE id = $1",
      [intentId, status, extra.token ?? null, extra.curve ?? null, extra.reason ?? null],
    );
    row.status = status;
    if (extra.token) row.token_address = extra.token;
    if (extra.curve) row.curve_address = extra.curve;
    if (extra.reason) row.failure_reason = extra.reason;
  };
  if ((row.status === "awaiting_signature" || row.status === "signed") && BigInt(row.expires_at) < block.timestamp) {
    await set("expired", { reason: "authorization_expired_before_submission" });
  } else if ((row.status === "submitted" || row.status === "included") && row.tx_hash) {
    const receipt = await ctx.client.getTransactionReceipt({ hash: row.tx_hash as Hex }).catch(() => null);
    if (!receipt) {
      const pending = await ctx.client.getTransaction({ hash: row.tx_hash as Hex }).catch(() => null);
      if (!pending && BigInt(row.expires_at) < block.timestamp) await set("expired", { reason: "transaction_dropped" });
      else if (row.status === "included") await set("submitted"); // receipt vanished: reorged out
    } else if (receipt.status === "reverted") {
      await set("failed", { reason: await revertReason(ctx, row) });
    } else {
      for (const log of receipt.logs) {
        if (getAddress(log.address) !== ctx.cfg.addresses.factory) continue;
        try {
          const ev = decodeEventLog({ abi: ponsV2LaunchFactoryAbi, data: log.data, topics: log.topics });
          if (ev.eventName === "TokenLaunched") {
            const confirmed = await ctx.db.query("SELECT 1 FROM tokens WHERE token = $1 AND launch_tx = $2", [getAddress(ev.args.token), row.tx_hash]);
            await set(confirmed.rows.length ? "confirmed" : "included", { token: getAddress(ev.args.token), curve: getAddress(ev.args.curve) });
          }
        } catch {
          /* not a factory event we track */
        }
      }
    }
  }
  return {
    intentId: row.id,
    draftId: row.draft_id,
    status: row.status,
    txHash: row.tx_hash,
    token: row.token_address,
    curve: row.curve_address,
    failureReason: row.failure_reason,
    expiresAt: row.expires_at,
    recovery: recoveryFor(row.status),
  };
}

function recoveryFor(status: string): string | null {
  switch (status) {
    case "failed":
      return "The launch transaction reverted; no token was created and the authorization nonce was NOT consumed. Re-authorize the draft to obtain a fresh attestation and signature.";
    case "expired":
      return "The authorization expired before the launch landed (or the transaction was dropped). It can no longer execute on chain. Re-authorize the draft.";
    case "superseded":
      return "This authorization was replaced (economics changed or a newer authorization was issued). Use the latest one.";
    default:
      return null;
  }
}

async function revertReason(ctx: AppContext, row: IntentRow): Promise<string> {
  try {
    const tx = await ctx.client.getTransaction({ hash: row.tx_hash as Hex });
    const receipt = await ctx.client.getTransactionReceipt({ hash: row.tx_hash as Hex });
    await ctx.client.call({ account: tx.from, to: tx.to!, data: tx.input, value: tx.value, blockNumber: receipt.blockNumber - 1n });
    return "reverted";
  } catch (e) {
    const err = e as { shortMessage?: string; message?: string };
    return `reverted: ${(err.shortMessage ?? err.message ?? "unknown").split("\n")[0]}`;
  }
}

export async function getIntent(ctx: AppContext, who: GithubWho, id: string) {
  await loadIntent(ctx, who, id);
  return refreshIntent(ctx, id);
}

export const newSalt = () => `0x${Buffer.from(randomToken(32), "base64url").subarray(0, 32).toString("hex").padEnd(64, "0")}` as Hex;
