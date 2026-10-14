/**
 * Proof of Build — append-only, hash-chained, signed evidence ledger.
 *
 * W02's factory emits no repository evidence of its own, and W03 does not
 * modify the audited-path contracts to add any. Instead each receipt links:
 *
 *   ON-CHAIN (cryptographically proven, re-checkable by anyone):
 *     TokenLaunched(token, curve, creator) from the Forge factory, and
 *     LaunchAuthorized(creator, githubRepoId, …) emitted by the authorizer
 *     in the SAME transaction — which the authorizer only emits after
 *     verifying the creator's EIP-712 consent AND a Forge-authority
 *     attestation under an active registry binding for that repo id.
 *   SERVICE-ATTESTED (depends on Forge's GitHub verification service):
 *     that GitHub user X administered repo id R (named N, at commit C) via
 *     App installation I, and bound wallet W, at time T.
 *
 * Receipts are hash-chained (prevHash), signed by the evidence key
 * (EIP-191 over the receipt hash) and the table rejects UPDATE/DELETE.
 * A launch later reorged out is never deleted — a `retraction` is appended.
 */
import { getAddress, hashMessage, keccak256, recoverAddress, toBytes, type Hex } from "viem";
import type { AppContext } from "../context";
import { canonicalJson } from "../crypto";

export const GENESIS_HASH = `0x${"00".repeat(32)}` as Hex;
export const DISCLAIMER =
  "GitHub verification attests repository administration at a point in time. It is NOT a code audit, NOT KYC, and NOT proof of financial legitimacy.";

export const receiptHash = (seq: number, prevHash: string, kind: string, receipt: unknown): Hex =>
  keccak256(toBytes(canonicalJson({ seq, prevHash, kind, receipt })));

async function append(ctx: AppContext, kind: "launch" | "retraction", token: string, receipt: Record<string, unknown>) {
  // Sign outside the transaction (custody may be remote); the chain head is re-checked inside it.
  for (let attempt = 0; attempt < 5; attempt++) {
    const head = (await ctx.db.query<{ seq: string; receipt_hash: string }>("SELECT seq::text, receipt_hash FROM evidence_receipts ORDER BY seq DESC LIMIT 1")).rows[0];
    const seq = head ? Number(head.seq) + 1 : 1;
    const prevHash = head?.receipt_hash ?? GENESIS_HASH;
    const hash = receiptHash(seq, prevHash, kind, receipt);
    const signature = await ctx.evidenceSigner.signDigest(hashMessage({ raw: hash }));
    try {
      await ctx.db.query(
        "INSERT INTO evidence_receipts(seq, prev_hash, kind, token, receipt, receipt_hash, signer, signature) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [seq, prevHash, kind, token, JSON.stringify(receipt), hash, ctx.evidenceSigner.address, signature],
      );
      return { seq, hash };
    } catch (e) {
      if ((e as { code?: string }).code !== "23505") throw e; // lost the race for this seq; retry on the new head
    }
  }
  throw new Error("evidence ledger contention");
}

interface Row {
  [k: string]: string | null;
}

/** Issues the launch receipt once the launch is indexed at confirmed depth. Idempotent. */
export async function issueLaunchReceipt(ctx: AppContext, token: string) {
  const t = getAddress(token);
  const existing = await ctx.db.query<{ kind: string }>("SELECT kind FROM evidence_receipts WHERE token = $1 ORDER BY seq DESC LIMIT 1", [t]);
  if (existing.rows[0]?.kind === "launch") return null;
  const tok = (await ctx.db.query<Row>("SELECT token, curve, creator, github_repo_id::text, launch_tx, launch_block::text, launched_at::text, factory FROM tokens WHERE token = $1", [t])).rows[0];
  if (!tok || !tok.github_repo_id) return null;
  const launchLog = (await ctx.db.query<Row>("SELECT tx_hash, block_hash, log_index::text FROM chain_events WHERE event_name = 'TokenLaunched' AND args->>'token' = $1 LIMIT 1", [t])).rows[0];
  const authLog = (await ctx.db.query<Row>("SELECT tx_hash, block_hash, log_index::text, args FROM chain_events WHERE event_name = 'LaunchAuthorized' AND tx_hash = $1 LIMIT 1", [tok.launch_tx])).rows[0];
  const intent = (await ctx.db.query<Row>("SELECT id, verification_id::text, attestation_id::text, consent_digest FROM launch_intents WHERE tx_hash = $1", [tok.launch_tx])).rows[0];
  // Launched outside this app's wizard: fall back to the newest verification of that creator for that repo before the launch.
  const verificationId =
    intent?.verification_id ??
    (
      await ctx.db.query<Row>(
        "SELECT id::text FROM verifications WHERE repo_id = $1 AND wallet_address = $2 AND verified_at <= to_timestamp($3) ORDER BY verified_at DESC LIMIT 1",
        [tok.github_repo_id, tok.creator, tok.launched_at],
      )
    ).rows[0]?.id ??
    null;
  const v = verificationId
    ? (await ctx.db.query<Row>("SELECT id::text, github_user_id::text, github_login, installation_id::text, full_name, owner_login, default_branch, commit_sha, evidence_hash, verified_at::text, private::text FROM verifications WHERE id = $1", [verificationId])).rows[0]
    : undefined;
  const att = intent?.attestation_id
    ? (await ctx.db.query<Row>("SELECT digest, issued_at::text, expires_at::text, binding_epoch::text FROM attestations WHERE id = $1", [intent.attestation_id])).rows[0]
    : undefined;
  const bindOp = (
    await ctx.db.query<Row>(
      "SELECT op_digest, tx_hash, binding_epoch::text, block_number::text FROM registry_ops WHERE repo_id = $1 AND creator = $2 AND revoke = false AND status = 'confirmed' AND block_number <= $3 ORDER BY block_number DESC LIMIT 1",
      [tok.github_repo_id, tok.creator, tok.launch_block],
    )
  ).rows[0];

  const receipt = {
    schema: "forge.proof-of-build.v1",
    chainId: ctx.cfg.chainId,
    factory: tok.factory,
    authorizer: ctx.cfg.addresses.authorizer,
    registry: ctx.cfg.addresses.registry,
    token: tok.token,
    curve: tok.curve,
    creator: tok.creator,
    githubRepoId: tok.github_repo_id,
    launchTx: tok.launch_tx,
    launchBlock: tok.launch_block,
    launchedAt: tok.launched_at,
    onchain: {
      tokenLaunchedLog: launchLog ? { txHash: launchLog.tx_hash, blockHash: launchLog.block_hash, logIndex: launchLog.log_index } : null,
      launchAuthorizedLog: authLog ? { txHash: authLog.tx_hash, blockHash: authLog.block_hash, logIndex: authLog.log_index } : null,
      bindingOp: bindOp ? { digest: bindOp.op_digest, txHash: bindOp.tx_hash, epoch: bindOp.binding_epoch, block: bindOp.block_number } : null,
    },
    service: v
      ? {
          verificationId: v.id,
          evidenceHash: v.evidence_hash,
          githubUserId: v.github_user_id,
          githubLogin: v.github_login,
          installationId: v.installation_id,
          repoFullNameAtVerification: v.full_name,
          ownerLogin: v.owner_login,
          defaultBranch: v.default_branch,
          commitSha: v.commit_sha,
          private: v.private === "true",
          verifiedAt: v.verified_at,
          attestation: att ? { digest: att.digest, issuedAt: att.issued_at, expiresAt: att.expires_at, bindingEpoch: att.binding_epoch } : null,
          consentDigest: intent?.consent_digest ?? null,
        }
      : null,
    classification: {
      cryptographicallyProven: ["chainId", "factory", "token", "curve", "creator", "githubRepoId", "launchTx", "launchBlock", "onchain.*"],
      serviceAttested: ["service.*"],
      disclaimer: DISCLAIMER,
    },
    observedAt: new Date().toISOString(),
  };
  return append(ctx, "launch", t, receipt);
}

/** Appends a retraction for launches whose events were reorged out after a receipt was issued. */
export async function retractOrphanedReceipts(ctx: AppContext) {
  const { rows } = await ctx.db.query<{ token: string; seq: string }>(
    `SELECT DISTINCT ON (r.token) r.token, r.seq::text, r.kind FROM evidence_receipts r ORDER BY r.token, r.seq DESC`,
  );
  const out: string[] = [];
  for (const r of rows as Array<{ token: string; seq: string; kind?: string }>) {
    if (r.kind !== "launch") continue;
    const live = await ctx.db.query("SELECT 1 FROM tokens WHERE token = $1", [r.token]);
    if (live.rows.length) continue;
    await append(ctx, "retraction", r.token, { schema: "forge.proof-of-build.retraction.v1", retracts: Number(r.seq), reason: "launch events no longer canonical (chain reorganization)", observedAt: new Date().toISOString() });
    out.push(r.token);
  }
  return out;
}

export interface LedgerCheck {
  ok: boolean;
  entries: number;
  error?: string;
}

/** Recomputes every hash link and signature. */
export async function verifyLedger(ctx: AppContext): Promise<LedgerCheck> {
  const { rows } = await ctx.db.query<{ seq: string; prev_hash: string; kind: string; receipt: unknown; receipt_hash: string; signer: string; signature: Hex }>(
    "SELECT seq::text, prev_hash, kind, receipt, receipt_hash, signer, signature FROM evidence_receipts ORDER BY seq",
  );
  let prev: string = GENESIS_HASH;
  let expectedSeq = 1;
  for (const r of rows) {
    const seq = Number(r.seq);
    if (seq !== expectedSeq) return { ok: false, entries: rows.length, error: `gap at ${expectedSeq}` };
    if (r.prev_hash !== prev) return { ok: false, entries: rows.length, error: `broken link at ${seq}` };
    const h = receiptHash(seq, r.prev_hash, r.kind, r.receipt);
    if (h !== r.receipt_hash) return { ok: false, entries: rows.length, error: `hash mismatch at ${seq}` };
    const signer = await recoverAddress({ hash: hashMessage({ raw: h }), signature: r.signature });
    if (getAddress(signer) !== getAddress(r.signer)) return { ok: false, entries: rows.length, error: `bad signature at ${seq}` };
    prev = h;
    expectedSeq++;
  }
  return { ok: true, entries: rows.length };
}
