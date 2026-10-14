import type { AppContext } from "./context";
import { decrypt, encrypt, hmacHex, randomToken, safeEqual, sha256Hex } from "./crypto";
import { ForgeError } from "./errors";
import { parseCookies, serializeCookie } from "./http";

export const SESSION_COOKIE = "forge_session";
export const CSRF_COOKIE = "forge_csrf";
export const CSRF_HEADER = "x-forge-csrf";

export interface Session {
  idHash: string;
  githubUserId: number | null;
  githubLogin: string | null;
  githubTokenEnc: string | null;
  githubTokenExpiresAt: Date | null;
  expiresAt: Date;
}

interface SessionRow {
  id_hash: string;
  github_user_id: string | null;
  login: string | null;
  github_token_enc: string | null;
  github_token_expires_at: Date | null;
  expires_at: Date;
}

export const csrfFor = (ctx: AppContext, idHash: string) => hmacHex(ctx.cfg.sessionSecret, `csrf:${idHash}`);

export async function loadSession(ctx: AppContext, req: Request): Promise<Session | null> {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token || token.length > 128) return null;
  const { rows } = await ctx.db.query<SessionRow>(
    `SELECT s.id_hash, s.github_user_id::text, u.login, s.github_token_enc, s.github_token_expires_at, s.expires_at
       FROM sessions s LEFT JOIN github_users u ON u.github_user_id = s.github_user_id
      WHERE s.id_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sha256Hex(token)],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    idHash: r.id_hash,
    githubUserId: r.github_user_id === null ? null : Number(r.github_user_id),
    githubLogin: r.login,
    githubTokenEnc: r.github_token_enc,
    githubTokenExpiresAt: r.github_token_expires_at,
    expiresAt: r.expires_at,
  };
}

/** Returns the current session, creating an anonymous one (with cookies to set) if needed. */
export async function ensureSession(ctx: AppContext, req: Request): Promise<{ session: Session; cookies: string[] }> {
  const existing = await loadSession(ctx, req);
  if (existing) return { session: existing, cookies: [] };
  const token = randomToken(32);
  const idHash = sha256Hex(token);
  const expiresAt = new Date(Date.now() + ctx.cfg.sessionTtlSeconds * 1000);
  await ctx.db.query("INSERT INTO sessions(id_hash, expires_at) VALUES ($1,$2)", [idHash, expiresAt]);
  return {
    session: { idHash, githubUserId: null, githubLogin: null, githubTokenEnc: null, githubTokenExpiresAt: null, expiresAt },
    cookies: sessionCookies(ctx, token, idHash),
  };
}

export function sessionCookies(ctx: AppContext, token: string, idHash: string): string[] {
  const maxAge = ctx.cfg.sessionTtlSeconds;
  return [
    serializeCookie(SESSION_COOKIE, token, { httpOnly: true, secure: ctx.cfg.secureCookies, maxAge }),
    // Readable by the page so it can echo it in the CSRF header (double-submit, HMAC-bound to the session).
    serializeCookie(CSRF_COOKIE, csrfFor(ctx, idHash), { httpOnly: false, secure: ctx.cfg.secureCookies, maxAge }),
  ];
}

export function clearSessionCookies(ctx: AppContext): string[] {
  return [
    serializeCookie(SESSION_COOKIE, "", { httpOnly: true, secure: ctx.cfg.secureCookies, maxAge: 0 }),
    serializeCookie(CSRF_COOKIE, "", { httpOnly: false, secure: ctx.cfg.secureCookies, maxAge: 0 }),
  ];
}

/**
 * Rotates the session token (session fixation defence) — called when the
 * session gains a GitHub identity. The old token stops working immediately.
 */
export async function rotateSession(ctx: AppContext, session: Session): Promise<{ idHash: string; cookies: string[] }> {
  const token = randomToken(32);
  const idHash = sha256Hex(token);
  await ctx.db.tx(async (q) => {
    await q.query(
      `INSERT INTO sessions(id_hash, github_user_id, github_token_enc, github_token_expires_at, expires_at)
       SELECT $2, github_user_id, github_token_enc, github_token_expires_at, $3 FROM sessions WHERE id_hash = $1`,
      [session.idHash, idHash, new Date(Date.now() + ctx.cfg.sessionTtlSeconds * 1000)],
    );
    await q.query("UPDATE sessions SET revoked_at = now() WHERE id_hash = $1", [session.idHash]);
  });
  return { idHash, cookies: sessionCookies(ctx, token, idHash) };
}

/** Guards every state-changing request: same-origin AND the session-bound CSRF token. */
export function requireCsrf(ctx: AppContext, req: Request, session: Session) {
  const origin = req.headers.get("origin");
  if (origin !== ctx.cfg.origin) throw new ForgeError("CSRF", "Cross-origin request refused.", 403);
  const header = req.headers.get(CSRF_HEADER) ?? "";
  if (!safeEqual(header, csrfFor(ctx, session.idHash))) throw new ForgeError("CSRF", "Missing or invalid CSRF token.", 403);
}

export async function requireSession(ctx: AppContext, req: Request, opts: { csrf: boolean } = { csrf: true }): Promise<Session> {
  const s = await loadSession(ctx, req);
  if (!s) throw new ForgeError("NO_SESSION", "Sign in first.", 401);
  if (opts.csrf) requireCsrf(ctx, req, s);
  return s;
}

export async function requireGithubSession(ctx: AppContext, req: Request, opts: { csrf: boolean } = { csrf: true }) {
  const s = await requireSession(ctx, req, opts);
  if (s.githubUserId === null || !s.githubLogin) throw new ForgeError("GITHUB_REQUIRED", "Connect GitHub first.", 401);
  return s as Session & { githubUserId: number; githubLogin: string };
}

export function githubTokenOf(ctx: AppContext, s: Session): string {
  if (!s.githubTokenEnc) throw new ForgeError("GITHUB_REAUTH", "Reconnect GitHub.", 401);
  if (s.githubTokenExpiresAt && s.githubTokenExpiresAt.getTime() <= Date.now()) {
    throw new ForgeError("GITHUB_REAUTH", "GitHub authorization expired; reconnect GitHub.", 401);
  }
  return decrypt(ctx.cfg.sessionSecret, "github-user-token", s.githubTokenEnc);
}

export function encryptGithubToken(ctx: AppContext, token: string) {
  return encrypt(ctx.cfg.sessionSecret, "github-user-token", token);
}

export async function revokeSession(ctx: AppContext, s: Session, all = false) {
  if (all && s.githubUserId !== null) {
    await ctx.db.query("UPDATE sessions SET revoked_at = now() WHERE github_user_id = $1 AND revoked_at IS NULL", [s.githubUserId]);
  } else {
    await ctx.db.query("UPDATE sessions SET revoked_at = now() WHERE id_hash = $1", [s.idHash]);
  }
}
