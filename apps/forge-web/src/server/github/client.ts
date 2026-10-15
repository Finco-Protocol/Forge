/**
 * GitHub App REST client. Three distinct credentials, never interchanged:
 *   - App JWT (RS256, the App's private key)  → app-level reads, installation tokens
 *   - installation token                      → what the App can see in a repo
 *   - user-to-server token (OAuth web flow)   → what the SIGNED-IN USER can do
 * Repository administration is only ever concluded from the user's own token
 * AND the installation's view of that user's collaborator permission.
 */
import { createSign } from "node:crypto";
import { ForgeError } from "../errors";

export interface GithubConfig {
  appId: string;
  appSlug: string;
  privateKeyPem: string;
  clientId: string;
  clientSecret: string;
  apiUrl: string;
  webUrl: string;
}

export interface GhRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  disabled?: boolean;
  default_branch: string;
  html_url: string;
  owner: { id: number; login: string; type: string };
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean; pull?: boolean };
}

export interface GhInstallation {
  id: number;
  account: { id: number; login: string; type: string };
  suspended_at: string | null;
  app_id?: number;
}

export interface GhAppMeta {
  id: number;
  slug: string;
  name: string;
  owner: { id: number; login: string; type: string };
  permissions: Record<string, string>;
  events: string[];
  installations_count?: number;
}

export class GithubHttpError extends Error {
  constructor(public readonly status: number, public readonly path: string) {
    super(`GitHub ${status} for ${path}`);
  }
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

export interface GithubClientOptions {
  /** Longest a rate-limited call will wait before one retry; longer waits fail closed. */
  maxRateLimitWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface RateLimitSnapshot {
  limit: number | null;
  remaining: number | null;
  resetAtMs: number | null;
  observedAtMs: number;
}

export class GithubApp {
  private tokenCache = new Map<number, { token: string; expiresAt: number }>();
  /** Last rate-limit headers seen (operators read this via ops tooling; never used for authorization). */
  lastRateLimit: RateLimitSnapshot | null = null;
  private readonly maxRateLimitWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly cfg: GithubConfig, private readonly fetchImpl: typeof fetch = fetch, opts: GithubClientOptions = {}) {
    this.maxRateLimitWaitMs = opts.maxRateLimitWaitMs ?? 5_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  get config() {
    return this.cfg;
  }

  appJwt(nowSeconds = Math.floor(Date.now() / 1000)): string {
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = b64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: this.cfg.appId }));
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    return `${header}.${payload}.${signer.sign(this.cfg.privateKeyPem).toString("base64url")}`;
  }

  /**
   * W05: a primary/secondary rate limit (429, or 403 with remaining=0 or a
   * retry-after) is retried ONCE after a bounded wait; a longer wait fails
   * closed with GITHUB_RATE_LIMITED. A rate-limited verification therefore
   * never degrades into an assumption about repository administration.
   */
  private async call<T>(path: string, auth: string, init: RequestInit = {}, rateLimitRetried = false): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.cfg.apiUrl}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        ...init,
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "finco-forge-w03",
          authorization: auth,
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ForgeError("GITHUB_UNAVAILABLE", "GitHub could not be reached; verification fails closed.", 503);
    }
    this.observeRateLimit(res);
    if (!res.ok) {
      const wait = this.rateLimitWaitMs(res);
      if (wait !== null) {
        if (wait > this.maxRateLimitWaitMs || rateLimitRetried) {
          throw new ForgeError("GITHUB_RATE_LIMITED", "GitHub rate limit reached; verification fails closed. Retry later.", 503, { retryAfterMs: wait });
        }
        await this.sleep(wait);
        return this.call<T>(path, auth, init, true);
      }
      throw new GithubHttpError(res.status, path);
    }
    return (await res.json()) as T;
  }

  private observeRateLimit(res: Response) {
    const n = (h: string) => {
      const v = res.headers.get(h);
      return v !== null && /^\d+$/.test(v) ? Number(v) : null;
    };
    const reset = n("x-ratelimit-reset");
    this.lastRateLimit = { limit: n("x-ratelimit-limit"), remaining: n("x-ratelimit-remaining"), resetAtMs: reset === null ? null : reset * 1000, observedAtMs: this.now() };
  }

  /** Milliseconds to wait if this failed response is a rate limit; null if it is an ordinary error. */
  private rateLimitWaitMs(res: Response): number | null {
    if (res.status !== 429 && res.status !== 403) return null;
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter && /^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
    if (res.headers.get("x-ratelimit-remaining") === "0") {
      const reset = res.headers.get("x-ratelimit-reset");
      return reset && /^\d+$/.test(reset) ? Math.max(0, Number(reset) * 1000 - this.now()) + 1000 : 60_000;
    }
    return res.status === 429 ? 60_000 : null;
  }

  /**
   * W05 installation-token rotation: an installation token the App no longer
   * holds (revoked, expired early, rotated) answers 401; the cached token is
   * dropped and exactly one fresh token is minted. A second 401 propagates
   * (the installation is gone or the App key is wrong) — never retried blindly.
   */
  private async callAsInstallation<T>(installationId: number, path: string, init: RequestInit = {}): Promise<T> {
    try {
      return await this.call<T>(path, `token ${await this.installationToken(installationId)}`, init);
    } catch (e) {
      if (!(e instanceof GithubHttpError) || e.status !== 401) throw e;
      this.forgetInstallation(installationId);
      return this.call<T>(path, `token ${await this.installationToken(installationId)}`, init);
    }
  }

  // ── App-level ───────────────────────────────────────────────────────
  async getInstallation(installationId: number): Promise<GhInstallation | null> {
    try {
      return await this.call<GhInstallation>(`/app/installations/${installationId}`, `Bearer ${this.appJwt()}`);
    } catch (e) {
      if (e instanceof GithubHttpError && e.status === 404) return null;
      throw e;
    }
  }

  /** The App's own metadata (permissions, events, webhook config) — for operator readiness checks. */
  async getApp(): Promise<GhAppMeta> {
    return this.call<GhAppMeta>("/app", `Bearer ${this.appJwt()}`);
  }

  async appWebhookConfig(): Promise<{ url?: string | null; content_type?: string; insecure_ssl?: string | number }> {
    return this.call("/app/hook/config", `Bearer ${this.appJwt()}`);
  }

  async installationToken(installationId: number): Promise<string> {
    const cached = this.tokenCache.get(installationId);
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    const r = await this.call<{ token: string; expires_at: string }>(
      `/app/installations/${installationId}/access_tokens`,
      `Bearer ${this.appJwt()}`,
      { method: "POST" },
    );
    this.tokenCache.set(installationId, { token: r.token, expiresAt: Date.parse(r.expires_at) });
    return r.token;
  }

  forgetInstallation(installationId: number) {
    this.tokenCache.delete(installationId);
  }

  // ── Installation-token reads ────────────────────────────────────────
  async installationRepoIds(installationId: number, maxPages = 20): Promise<Map<number, GhRepo>> {
    const out = new Map<number, GhRepo>();
    for (let page = 1; page <= maxPages; page++) {
      const r = await this.callAsInstallation<{ total_count: number; repositories: GhRepo[] }>(installationId, `/installation/repositories?per_page=100&page=${page}`);
      for (const repo of r.repositories) out.set(repo.id, repo);
      if (r.repositories.length < 100) break;
    }
    return out;
  }

  async repoByIdAsInstallation(installationId: number, repoId: number): Promise<GhRepo | null> {
    try {
      return await this.callAsInstallation<GhRepo>(installationId, `/repositories/${repoId}`);
    } catch (e) {
      if (e instanceof GithubHttpError && (e.status === 404 || e.status === 403)) return null;
      throw e;
    }
  }

  async collaboratorPermission(installationId: number, fullName: string, login: string) {
    try {
      return await this.callAsInstallation<{ permission: string; role_name?: string; user: { id: number; login: string } }>(
        installationId,
        `/repos/${fullName}/collaborators/${encodeURIComponent(login)}/permission`,
      );
    } catch (e) {
      if (e instanceof GithubHttpError && e.status === 404) return null;
      throw e;
    }
  }

  async branchHead(installationId: number, fullName: string, branch: string): Promise<string> {
    const r = await this.callAsInstallation<{ commit: { sha: string } }>(installationId, `/repos/${fullName}/branches/${encodeURIComponent(branch)}`);
    if (!/^[0-9a-f]{40}$/.test(r.commit.sha)) throw new ForgeError("GITHUB_BAD_RESPONSE", "Unexpected commit SHA format.", 502);
    return r.commit.sha;
  }

  // ── User-token reads ────────────────────────────────────────────────
  async getUser(userToken: string) {
    return this.call<{ id: number; login: string }>("/user", `token ${userToken}`);
  }

  async userInstallations(userToken: string): Promise<GhInstallation[]> {
    const r = await this.call<{ installations: GhInstallation[] }>("/user/installations?per_page=100", `token ${userToken}`);
    return r.installations;
  }

  async userInstallationRepos(userToken: string, installationId: number, maxPages = 20): Promise<GhRepo[]> {
    const out: GhRepo[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const r = await this.call<{ repositories: GhRepo[] }>(
        `/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
        `token ${userToken}`,
      );
      out.push(...r.repositories);
      if (r.repositories.length < 100) break;
    }
    return out;
  }

  async repoByIdAsUser(userToken: string, repoId: number): Promise<GhRepo | null> {
    try {
      return await this.call<GhRepo>(`/repositories/${repoId}`, `token ${userToken}`);
    } catch (e) {
      if (e instanceof GithubHttpError && (e.status === 404 || e.status === 403)) return null;
      throw e;
    }
  }

  // ── OAuth (GitHub App user authorization) ───────────────────────────
  authorizeUrl(state: string, redirectUri: string): string {
    const u = new URL(`${this.cfg.webUrl}/login/oauth/authorize`);
    u.searchParams.set("client_id", this.cfg.clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    u.searchParams.set("allow_signup", "false");
    return u.toString();
  }

  installUrl(state: string): string {
    return `${this.cfg.webUrl}/apps/${this.cfg.appSlug}/installations/new?state=${encodeURIComponent(state)}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string; expiresIn: number | null }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.webUrl}/login/oauth/access_token`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "user-agent": "finco-forge-w03" },
        body: JSON.stringify({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, code, redirect_uri: redirectUri }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ForgeError("GITHUB_UNAVAILABLE", "GitHub could not be reached.", 503);
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) throw new ForgeError("GITHUB_OAUTH_FAILED", `GitHub authorization failed${body.error ? `: ${body.error}` : ""}.`, 401);
    return { accessToken: body.access_token, expiresIn: body.expires_in ?? null };
  }
}
