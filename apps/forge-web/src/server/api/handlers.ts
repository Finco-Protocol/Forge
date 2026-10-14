/**
 * HTTP API. One dispatcher serves the Next.js catch-all route and the
 * integration tests alike, so acceptance runs the exact production path:
 * cookies, CSRF, sessions, validation, services.
 */
import { getAddress, isAddress, isHex, type Hex } from "viem";
import type { AppContext } from "../context";
import { ForgeError, refuse } from "../errors";
import { errorResponse, json, readJson } from "../http";
import { randomToken, sha256Hex } from "../crypto";
import {
  clearSessionCookies,
  ensureSession,
  encryptGithubToken,
  githubTokenOf,
  loadSession,
  requireGithubSession,
  requireSession,
  revokeSession,
  rotateSession,
} from "../session";
import { audit } from "../audit";
import { rateLimit } from "../ratelimit";
import { discoverRepositories, verifyRepository } from "../github/verify";
import { handleWebhook } from "../github/webhooks";
import { activeWalletBinding, issueWalletChallenge, revokeWalletBinding, verifyWalletChallenge } from "../wallet/siwe";
import { authorizeDraft, createDraft, getDraft, getIntent, recordSubmission, refreshDraftEconomics, submitCreatorSignature } from "../launch/service";
import { verifyLedger, DISCLAIMER } from "../proof/ledger";
import { PRODUCTION_BLOCKED, FORGE_FEE_POLICY_AUTHORITY_UNPROVEN } from "../config";
import robinhood from "../../../config/networks/robinhood-4663.json";

type Handler = (ctx: AppContext, req: Request, params: Record<string, string>) => Promise<Response>;

const clientIp = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";

// ── session / auth ───────────────────────────────────────────────────────
const me: Handler = async (ctx, req) => {
  const { session, cookies } = await ensureSession(ctx, req);
  const wallet = session.githubUserId !== null ? await activeWalletBinding(ctx.db, session.githubUserId) : null;
  return json(
    {
      github: session.githubUserId !== null ? { id: session.githubUserId, login: session.githubLogin } : null,
      wallet,
      chainId: ctx.cfg.chainId,
    },
    {},
    cookies,
  );
};

const githubStart: Handler = async (ctx, req) => {
  await rateLimit(ctx.db, `oauth:${clientIp(req)}`, 30, 600);
  const { session, cookies } = await ensureSession(ctx, req);
  const state = randomToken(24);
  await ctx.db.query("INSERT INTO oauth_states(state_hash, session_id_hash, expires_at) VALUES ($1,$2,$3)", [
    sha256Hex(state),
    session.idHash,
    new Date(Date.now() + 10 * 60_000),
  ]);
  const headers = new Headers({ location: ctx.github.authorizeUrl(state, `${ctx.cfg.origin}/api/auth/github/callback`), "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
};

const githubCallback: Handler = async (ctx, req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const session = await loadSession(ctx, req);
  if (!session || !code || !state) refuse("OAUTH_STATE", "Sign-in session missing; start again.", 400);
  // OAuth CSRF: the state must have been issued to THIS session, unused and fresh.
  const { rows } = await ctx.db.query<{ session_id_hash: string; expires_at: Date }>(
    "UPDATE oauth_states SET used_at = now() WHERE state_hash = $1 AND used_at IS NULL RETURNING session_id_hash, expires_at",
    [sha256Hex(state)],
  );
  const st = rows[0];
  if (!st || st.session_id_hash !== session!.idHash || st.expires_at.getTime() < Date.now()) refuse("OAUTH_STATE", "Invalid or expired sign-in state.", 400);
  const token = await ctx.github.exchangeCode(code, `${ctx.cfg.origin}/api/auth/github/callback`);
  const user = await ctx.github.getUser(token.accessToken);
  await ctx.db.query(
    "INSERT INTO github_users(github_user_id, login) VALUES ($1,$2) ON CONFLICT (github_user_id) DO UPDATE SET login = EXCLUDED.login, updated_at = now()",
    [user.id, user.login],
  );
  const expires = token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000) : null;
  await ctx.db.query("UPDATE sessions SET github_user_id = $2, github_token_enc = $3, github_token_expires_at = $4 WHERE id_hash = $1", [
    session!.idHash,
    user.id,
    encryptGithubToken(ctx, token.accessToken),
    expires,
  ]);
  const rotated = await rotateSession(ctx, session!);
  await audit(ctx.db, `github:${user.id}`, "github_signed_in", null, { login: user.login });
  const headers = new Headers({ location: `${ctx.cfg.origin}/launch`, "cache-control": "no-store" });
  for (const c of rotated.cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
};

const githubSetup: Handler = async (ctx) => {
  // GitHub App "Setup URL": the installation_id query is NOT trusted; installations are re-discovered via the user's token.
  return new Response(null, { status: 302, headers: { location: `${ctx.cfg.origin}/launch` } });
};

const logout: Handler = async (ctx, req) => {
  const s = await requireSession(ctx, req);
  const body = await readJson<{ all?: boolean }>(req).catch(() => ({ all: false }));
  await revokeSession(ctx, s, body.all === true);
  return json({ ok: true }, {}, clearSessionCookies(ctx));
};

// ── GitHub ───────────────────────────────────────────────────────────────
const repositories: Handler = async (ctx, req) => {
  const s = await requireGithubSession(ctx, req, { csrf: false });
  await rateLimit(ctx.db, `repos:${s.githubUserId}`, 60, 600);
  const r = await discoverRepositories(ctx, githubTokenOf(ctx, s));
  return json({ ...r, installUrl: ctx.github.installUrl(randomToken(12)) });
};

const verify: Handler = async (ctx, req) => {
  const s = await requireGithubSession(ctx, req);
  await rateLimit(ctx.db, `verify:${s.githubUserId}`, 30, 600);
  const body = await readJson<{ repoId?: number; installationId?: number }>(req);
  if (!Number.isSafeInteger(body.repoId) || !Number.isSafeInteger(body.installationId)) refuse("INVALID_PARAMS", "repoId and installationId are required.");
  const wallet = await activeWalletBinding(ctx.db, s.githubUserId);
  const v = await verifyRepository(ctx, {
    userToken: githubTokenOf(ctx, s),
    githubUserId: s.githubUserId,
    githubLogin: s.githubLogin,
    repoId: body.repoId!,
    installationId: body.installationId!,
    wallet: wallet ? { bindingId: wallet.id, address: wallet.address } : null,
  });
  return json({ verification: v, disclaimer: DISCLAIMER });
};

const webhook: Handler = async (ctx, req) => {
  const r = await handleWebhook(ctx, req);
  return json(r.body, { status: r.status });
};

// ── wallet ───────────────────────────────────────────────────────────────
const walletChallenge: Handler = async (ctx, req) => {
  const s = await requireGithubSession(ctx, req);
  await rateLimit(ctx.db, `siwe:${s.githubUserId}`, 20, 600);
  const body = await readJson<{ address?: string; chainId?: number }>(req);
  return json(await issueWalletChallenge(ctx, s, String(body.address ?? ""), Number(body.chainId)));
};

const walletVerify: Handler = async (ctx, req) => {
  const s = await requireGithubSession(ctx, req);
  const body = await readJson<{ message?: string; signature?: string }>(req);
  if (typeof body.message !== "string" || !isHex(body.signature)) refuse("INVALID_PARAMS", "message and signature are required.");
  return json(await verifyWalletChallenge(ctx, s, body.message!, body.signature as Hex));
};

const walletRevoke: Handler = async (ctx, req) => {
  const s = await requireGithubSession(ctx, req);
  return json({ revoked: await revokeWalletBinding(ctx, s.githubUserId) });
};

// ── launch ───────────────────────────────────────────────────────────────
const who = (s: { githubUserId: number; githubLogin: string }) => ({ githubUserId: s.githubUserId, githubLogin: s.githubLogin });

const draftCreate: Handler = async (ctx, req) => {
  const s = await requireGithubSession(ctx, req);
  await rateLimit(ctx.db, `draft:${s.githubUserId}`, 60, 3600);
  return json(await createDraft(ctx, who(s), await readJson(req)), { status: 201 });
};
const draftGet: Handler = async (ctx, req, p) => json(await getDraft(ctx, who(await requireGithubSession(ctx, req, { csrf: false })), p.id!));
const draftRefresh: Handler = async (ctx, req, p) => json(await refreshDraftEconomics(ctx, who(await requireGithubSession(ctx, req)), p.id!));
const draftAuthorize: Handler = async (ctx, req, p) => {
  const s = await requireGithubSession(ctx, req);
  return json(await authorizeDraft(ctx, { ...who(s), userToken: githubTokenOf(ctx, s) }, p.id!));
};
const intentSignature: Handler = async (ctx, req, p) => {
  const s = await requireGithubSession(ctx, req);
  const body = await readJson<{ signature?: string }>(req);
  return json(await submitCreatorSignature(ctx, who(s), p.id!, String(body.signature ?? "")));
};
const intentSubmitted: Handler = async (ctx, req, p) => {
  const s = await requireGithubSession(ctx, req);
  const body = await readJson<{ txHash?: string }>(req);
  return json(await recordSubmission(ctx, who(s), p.id!, String(body.txHash ?? "")));
};
const intentGet: Handler = async (ctx, req, p) => json(await getIntent(ctx, who(await requireGithubSession(ctx, req, { csrf: false })), p.id!));

// ── discovery / proof (public) ───────────────────────────────────────────
const tokenList: Handler = async (ctx, req) => {
  const url = new URL(req.url);
  const phase = url.searchParams.get("phase");
  const q = url.searchParams.get("q")?.slice(0, 64) ?? null;
  const { rows } = await ctx.db.query(
    `SELECT t.token, t.name, t.symbol, t.creator, t.curve, t.phase, t.onchain_phase, t.reconcile_error, t.github_repo_id::text AS repo_id,
            t.launched_at::text, t.launch_tx, t.buy_count, t.sell_count, t.quote_volume::text, t.curve_quote_reserve::text,
            t.graduation_threshold::text, t.liquidity_locked, t.pair_token,
            r.full_name, r.ineligible_reason,
            (SELECT max(v.verified_at) FROM verifications v WHERE v.repo_id = t.github_repo_id AND v.wallet_address = t.creator) AS last_verified_at
       FROM tokens t LEFT JOIN repositories r ON r.repo_id = t.github_repo_id
      WHERE t.chain_id = $1 AND t.factory = $2
        AND ($3::text IS NULL OR t.phase = $3)
        AND ($4::text IS NULL OR t.name ILIKE '%' || $4 || '%' OR t.symbol ILIKE '%' || $4 || '%' OR r.full_name ILIKE '%' || $4 || '%')
      ORDER BY t.launch_block DESC LIMIT 200`,
    [ctx.cfg.chainId, ctx.cfg.addresses.factory, phase, q],
  );
  const cp = await ctx.db.query("SELECT last_block::text, updated_at FROM indexer_checkpoints WHERE chain_id = $1", [ctx.cfg.chainId]);
  return json({ tokens: rows, indexer: cp.rows[0] ?? null });
};

const tokenDetail: Handler = async (ctx, req, p) => {
  if (!isAddress(p.address ?? "", { strict: false })) refuse("NOT_FOUND", "Unknown token.", 404);
  const token = getAddress(p.address!);
  const t = (await ctx.db.query("SELECT *, github_repo_id::text AS repo_id, quote_volume::text, graduation_threshold::text, curve_quote_reserve::text, position_id::text FROM tokens WHERE token = $1", [token])).rows[0];
  if (!t) refuse("NOT_FOUND", "Token not indexed (or not a confirmed Forge launch).", 404);
  const repoId = (t as { repo_id: string | null }).repo_id;
  const repo = repoId ? (await ctx.db.query("SELECT repo_id::text, full_name, owner_login, private, archived, ineligible_reason, updated_at FROM repositories WHERE repo_id = $1", [repoId])).rows[0] : null;
  const names = repoId ? (await ctx.db.query("SELECT full_name, first_seen_at, source FROM repository_names WHERE repo_id = $1 ORDER BY first_seen_at", [repoId])).rows : [];
  const receipts = (await ctx.db.query("SELECT seq::text, kind, prev_hash, receipt, receipt_hash, signer, signature, created_at FROM evidence_receipts WHERE token = $1 ORDER BY seq", [token])).rows;
  const events = (
    await ctx.db.query(
      "SELECT block_number::text, tx_hash, log_index, address, event_name, args, block_timestamp::text FROM chain_events WHERE address = $1 OR args->>'token' = $2 ORDER BY block_number, log_index LIMIT 500",
      [(t as { curve: string }).curve, token],
    )
  ).rows;
  const launched = await ctx.db.query("SELECT params FROM launch_drafts d JOIN launch_intents i ON i.draft_id = d.id WHERE i.tx_hash = $1", [(t as { launch_tx: string }).launch_tx]);
  return json({
    token: t,
    repository: repo,
    repositoryNames: names,
    launchParams: launched.rows[0] ?? null,
    receipts,
    events,
    feePolicy: await ctx.client
      .readContract({ address: ctx.cfg.addresses.factory, abi: (await import("@/shared/abis.generated")).ponsV2LaunchFactoryAbi, functionName: "getLaunchFeePolicy", args: [token] })
      .catch(() => null),
    disclaimer: DISCLAIMER,
  });
};

const ledger: Handler = async (ctx) => json(await verifyLedger(ctx));

const dashboard: Handler = async (ctx, req) => {
  const s = await requireGithubSession(ctx, req, { csrf: false });
  const wallet = await activeWalletBinding(ctx.db, s.githubUserId);
  const verifications = (
    await ctx.db.query(
      "SELECT id, repo_id::text, full_name, commit_sha, wallet_address, verified_at, expires_at, revoked_at, revoke_reason FROM verifications WHERE github_user_id = $1 ORDER BY verified_at DESC LIMIT 50",
      [s.githubUserId],
    )
  ).rows;
  const drafts = (
    await ctx.db.query(
      `SELECT d.id, d.repo_id::text, d.params->>'name' AS name, d.params->>'symbol' AS symbol, d.created_at,
              (SELECT row_to_json(i) FROM (SELECT id, status, tx_hash, token_address, failure_reason FROM launch_intents WHERE draft_id = d.id ORDER BY created_at DESC LIMIT 1) i) AS latest_intent
         FROM launch_drafts d WHERE d.github_user_id = $1 ORDER BY d.created_at DESC LIMIT 50`,
      [s.githubUserId],
    )
  ).rows;
  const tokens = wallet ? (await ctx.db.query("SELECT token, name, symbol, phase, launched_at::text FROM tokens WHERE creator = $1 ORDER BY launch_block DESC", [wallet.address])).rows : [];
  const bindings = (
    await ctx.db.query(
      "SELECT repo_id::text, creator, op_digest, tx_hash, binding_epoch::text, revoke, status, reason, created_at FROM registry_ops WHERE creator = $1 ORDER BY id DESC LIMIT 50",
      [wallet?.address ?? ""],
    )
  ).rows;
  return json({ github: { id: s.githubUserId, login: s.githubLogin }, wallet, verifications, drafts, tokens, registryOps: bindings });
};

const publicConfig: Handler = async (ctx) =>
  json({
    network: ctx.cfg.network,
    chainId: ctx.cfg.chainId,
    rpcUrl: ctx.cfg.network === "sandbox" ? ctx.cfg.rpcUrl : null,
    explorerUrl: ctx.cfg.chainId === robinhood.chainId ? robinhood.explorerUrl : null,
    addresses: Object.fromEntries(Object.entries(ctx.cfg.addresses).map(([k, v]) => [k, String(v)])),
    flags: { PRODUCTION_BLOCKED, FORGE_FEE_POLICY_AUTHORITY_UNPROVEN, FINCO_BURN_ENABLED: false },
    policy: { allowPrivateRepos: ctx.cfg.policy.allowPrivateRepos, allowForkRepos: ctx.cfg.policy.allowForkRepos },
    githubAppSlug: ctx.cfg.github.appSlug,
    disclaimer: DISCLAIMER,
  });

const health: Handler = async (ctx) => {
  const block = await ctx.client.getBlockNumber().catch(() => null);
  return json({ ok: block !== null, block });
};

const ROUTES: Array<[string, RegExp, string[], Handler]> = [];
function route(method: string, pattern: string, h: Handler) {
  const keys: string[] = [];
  const re = new RegExp("^" + pattern.replace(/:([a-zA-Z]+)/g, (_m, k: string) => (keys.push(k), "([^/]+)")) + "$");
  ROUTES.push([method, re, keys, h]);
}
route("GET", "/api/me", me);
route("GET", "/api/config", publicConfig);
route("GET", "/api/health", health);
route("GET", "/api/auth/github/start", githubStart);
route("GET", "/api/auth/github/callback", githubCallback);
route("GET", "/api/github/setup", githubSetup);
route("POST", "/api/auth/logout", logout);
route("GET", "/api/github/repositories", repositories);
route("POST", "/api/github/verify", verify);
route("POST", "/api/github/webhook", webhook);
route("POST", "/api/wallet/challenge", walletChallenge);
route("POST", "/api/wallet/verify", walletVerify);
route("DELETE", "/api/wallet/binding", walletRevoke);
route("POST", "/api/launch/drafts", draftCreate);
route("GET", "/api/launch/drafts/:id", draftGet);
route("POST", "/api/launch/drafts/:id/refresh", draftRefresh);
route("POST", "/api/launch/drafts/:id/authorize", draftAuthorize);
route("POST", "/api/launch/intents/:id/signature", intentSignature);
route("POST", "/api/launch/intents/:id/submitted", intentSubmitted);
route("GET", "/api/launch/intents/:id", intentGet);
route("GET", "/api/tokens", tokenList);
route("GET", "/api/tokens/:address", tokenDetail);
route("GET", "/api/proof/ledger", ledger);
route("GET", "/api/dashboard", dashboard);

export async function dispatch(ctx: AppContext, req: Request): Promise<Response> {
  try {
    const path = new URL(req.url).pathname;
    for (const [method, re, keys, h] of ROUTES) {
      if (method !== req.method) continue;
      const m = re.exec(path);
      if (!m) continue;
      const params = Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
      return await h(ctx, req, params);
    }
    throw new ForgeError("NOT_FOUND", "No such endpoint.", 404);
  } catch (e) {
    return errorResponse(e);
  }
}
