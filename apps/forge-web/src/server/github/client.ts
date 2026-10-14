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

export class GithubHttpError extends Error {
  constructor(public readonly status: number, public readonly path: string) {
    super(`GitHub ${status} for ${path}`);
  }
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

export class GithubApp {
  private tokenCache = new Map<number, { token: string; expiresAt: number }>();

  constructor(private readonly cfg: GithubConfig, private readonly fetchImpl: typeof fetch = fetch) {}

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

  private async call<T>(path: string, auth: string, init: RequestInit = {}): Promise<T> {
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
    if (!res.ok) throw new GithubHttpError(res.status, path);
    return (await res.json()) as T;
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
    const token = await this.installationToken(installationId);
    const out = new Map<number, GhRepo>();
    for (let page = 1; page <= maxPages; page++) {
      const r = await this.call<{ total_count: number; repositories: GhRepo[] }>(
        `/installation/repositories?per_page=100&page=${page}`,
        `token ${token}`,
      );
      for (const repo of r.repositories) out.set(repo.id, repo);
      if (r.repositories.length < 100) break;
    }
    return out;
  }

  async repoByIdAsInstallation(installationId: number, repoId: number): Promise<GhRepo | null> {
    const token = await this.installationToken(installationId);
    try {
      return await this.call<GhRepo>(`/repositories/${repoId}`, `token ${token}`);
    } catch (e) {
      if (e instanceof GithubHttpError && (e.status === 404 || e.status === 403)) return null;
      throw e;
    }
  }

  async collaboratorPermission(installationId: number, fullName: string, login: string) {
    const token = await this.installationToken(installationId);
    try {
      return await this.call<{ permission: string; role_name?: string; user: { id: number; login: string } }>(
        `/repos/${fullName}/collaborators/${encodeURIComponent(login)}/permission`,
        `token ${token}`,
      );
    } catch (e) {
      if (e instanceof GithubHttpError && e.status === 404) return null;
      throw e;
    }
  }

  async branchHead(installationId: number, fullName: string, branch: string): Promise<string> {
    const token = await this.installationToken(installationId);
    const r = await this.call<{ commit: { sha: string } }>(`/repos/${fullName}/branches/${encodeURIComponent(branch)}`, `token ${token}`);
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
