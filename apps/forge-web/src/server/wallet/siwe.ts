/**
 * Wallet ↔ GitHub identity binding via a one-time SIWE (EIP-4361) challenge.
 * Proves WALLET CONSENT ONLY. It never proves repository administration —
 * that is a separate proof layer (github/verify.ts) and both are required.
 *
 * Protections: server-generated one-time nonce, bound to the session AND the
 * GitHub user id at issuance; domain/URI/chain-id binding; 5-minute expiry;
 * atomic single use; EOA-only (the W02 authorizer verifies ECDSA consent);
 * CSRF (route layer); revocation; one active wallet per GitHub identity.
 */
import { getAddress, isAddress, recoverMessageAddress, type Address, type Hex } from "viem";
import { createSiweMessage, parseSiweMessage } from "viem/siwe";
import type { AppContext } from "../context";
import { randomToken } from "../crypto";
import { ForgeError } from "../errors";
import { audit } from "../audit";
import type { Session } from "../session";
import type { Queryable } from "../db";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export async function issueWalletChallenge(ctx: AppContext, session: Session & { githubUserId: number; githubLogin: string }, address: string, chainId: number) {
  if (!isAddress(address, { strict: false })) throw new ForgeError("BAD_ADDRESS", "Invalid wallet address.");
  if (chainId !== ctx.cfg.chainId) throw new ForgeError("WRONG_CHAIN", `Switch your wallet to chain ${ctx.cfg.chainId}.`, 400, { expected: ctx.cfg.chainId });
  const nonce = randomToken(16).replace(/[^a-zA-Z0-9]/g, "").padEnd(16, "0");
  const issuedAt = new Date();
  const expirationTime = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
  const message = createSiweMessage({
    domain: ctx.cfg.host,
    address: getAddress(address),
    statement: `Bind GitHub account @${session.githubLogin} (id ${session.githubUserId}) to this wallet for FINCO Forge launches. This signature proves wallet consent only; it is not proof of repository ownership and authorizes no transaction.`,
    uri: ctx.cfg.origin,
    version: "1",
    chainId,
    nonce,
    issuedAt,
    expirationTime,
  });
  await ctx.db.query(
    `INSERT INTO wallet_challenges(nonce, session_id_hash, github_user_id, address, chain_id, domain, message, issued_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [nonce, session.idHash, session.githubUserId, getAddress(address), chainId, ctx.cfg.host, message, issuedAt, expirationTime],
  );
  return { message, nonce, expiresAt: expirationTime.toISOString() };
}

interface ChallengeRow {
  nonce: string;
  session_id_hash: string;
  github_user_id: string;
  address: string;
  chain_id: number;
  domain: string;
  message: string;
  expires_at: Date;
  used_at: Date | null;
}

export async function verifyWalletChallenge(ctx: AppContext, session: Session & { githubUserId: number }, message: string, signature: Hex) {
  const parsed = parseSiweMessage(message);
  if (!parsed.nonce || !parsed.address) throw new ForgeError("SIWE_INVALID", "Malformed sign-in message.");
  // Recover first (pure); EOA only.
  let signer: Address;
  try {
    signer = await recoverMessageAddress({ message, signature });
  } catch {
    throw new ForgeError("SIWE_BAD_SIGNATURE", "Signature could not be verified.", 401);
  }
  const binding = await ctx.db.tx(async (q) => {
    // Atomic single use: only one request can flip used_at.
    const { rows } = await q.query<ChallengeRow>(
      "UPDATE wallet_challenges SET used_at = now() WHERE nonce = $1 AND used_at IS NULL RETURNING *",
      [parsed.nonce],
    );
    const c = rows[0];
    if (!c) throw new ForgeError("SIWE_REPLAY", "Challenge unknown or already used.", 401);
    if (c.session_id_hash !== session.idHash || Number(c.github_user_id) !== session.githubUserId) {
      throw new ForgeError("SIWE_SESSION_MISMATCH", "Challenge was issued to a different session.", 401);
    }
    if (c.expires_at.getTime() <= Date.now()) throw new ForgeError("SIWE_EXPIRED", "Challenge expired; request a new one.", 401);
    // The client must return the exact server-issued message.
    if (message !== c.message) throw new ForgeError("SIWE_TAMPERED", "Signed message does not match the issued challenge.", 401);
    if (parsed.domain !== ctx.cfg.host || parsed.uri !== ctx.cfg.origin) throw new ForgeError("SIWE_DOMAIN", "Wrong domain.", 401);
    if (parsed.chainId !== ctx.cfg.chainId || c.chain_id !== ctx.cfg.chainId) throw new ForgeError("WRONG_CHAIN", "Wrong chain.", 401);
    if (getAddress(signer) !== getAddress(c.address)) throw new ForgeError("SIWE_BAD_SIGNATURE", "Signature is not from the challenged wallet.", 401);
    const code = await ctx.client.getCode({ address: signer });
    if (code && code !== "0x") throw new ForgeError("EOA_REQUIRED", "The W02 authorizer verifies ECDSA consent only; use an EOA wallet.", 400);

    // One active wallet per GitHub identity; one GitHub identity per wallet.
    const other = await q.query<{ github_user_id: string }>(
      "SELECT github_user_id::text FROM wallet_bindings WHERE wallet_address = $1 AND revoked_at IS NULL",
      [getAddress(signer)],
    );
    if (other.rows[0] && Number(other.rows[0].github_user_id) !== session.githubUserId) {
      throw new ForgeError("WALLET_BOUND_ELSEWHERE", "This wallet is bound to another GitHub account.", 409);
    }
    const previous = await revokeWalletBindingsTx(q, session.githubUserId, "replaced");
    const ins = await q.query<{ id: string }>(
      "INSERT INTO wallet_bindings(github_user_id, wallet_address, chain_id, siwe_message, signature) VALUES ($1,$2,$3,$4,$5) RETURNING id::text",
      [session.githubUserId, getAddress(signer), ctx.cfg.chainId, message, signature],
    );
    return { id: Number(ins.rows[0]!.id), address: getAddress(signer), previous };
  });
  await audit(ctx.db, `github:${session.githubUserId}`, "wallet_bound", `wallet:${binding.address}`, { bindingId: binding.id, replaced: binding.previous });
  for (const prev of binding.previous) await enqueueCreatorRevocations(ctx, prev, "wallet_binding_replaced");
  return { bindingId: binding.id, address: binding.address };
}

async function revokeWalletBindingsTx(q: Queryable, githubUserId: number, reason: string): Promise<Address[]> {
  const { rows } = await q.query<{ wallet_address: string }>(
    "UPDATE wallet_bindings SET revoked_at = now(), revoke_reason = $2 WHERE github_user_id = $1 AND revoked_at IS NULL RETURNING wallet_address",
    [githubUserId, reason],
  );
  return rows.map((r) => getAddress(r.wallet_address));
}

export async function revokeWalletBinding(ctx: AppContext, githubUserId: number, reason = "user_revoked") {
  const revoked = await ctx.db.tx((q) => revokeWalletBindingsTx(q, githubUserId, reason));
  for (const w of revoked) {
    await audit(ctx.db, `github:${githubUserId}`, "wallet_unbound", `wallet:${w}`, { reason });
    await enqueueCreatorRevocations(ctx, w, reason);
  }
  return revoked;
}

export async function activeWalletBinding(db: Queryable, githubUserId: number): Promise<{ id: number; address: Address } | null> {
  const { rows } = await db.query<{ id: string; wallet_address: string }>(
    "SELECT id::text, wallet_address FROM wallet_bindings WHERE github_user_id = $1 AND revoked_at IS NULL",
    [githubUserId],
  );
  return rows[0] ? { id: Number(rows[0].id), address: getAddress(rows[0].wallet_address) } : null;
}

/**
 * A wallet that lost its GitHub binding must not keep launch eligibility on
 * chain: revoke every registry binding confirmed for it (worker job).
 */
export async function enqueueCreatorRevocations(ctx: AppContext, wallet: Address, reason: string) {
  const { rows } = await ctx.db.query<{ repo_id: string }>(
    "SELECT DISTINCT repo_id::text FROM registry_ops WHERE creator = $1 AND revoke = false AND status = 'confirmed'",
    [getAddress(wallet)],
  );
  for (const r of rows) {
    await ctx.db.query(
      "INSERT INTO jobs(kind, dedupe_key, payload) VALUES ('registry_revoke', $1, $2) ON CONFLICT (dedupe_key) DO NOTHING",
      [`revoke:${r.repo_id}:${wallet}:${reason}:${Date.now()}`, JSON.stringify({ repoId: r.repo_id, creator: getAddress(wallet), reason })],
    );
  }
  // Off-chain refusal is immediate: verifications tied to this wallet stop authorizing.
  await ctx.db.query("UPDATE verifications SET revoked_at = now(), revoke_reason = $2 WHERE wallet_address = $1 AND revoked_at IS NULL", [
    getAddress(wallet),
    reason,
  ]);
}
