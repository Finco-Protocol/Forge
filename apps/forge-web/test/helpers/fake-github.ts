/**
 * Local stand-in for the GitHub REST API + OAuth endpoints — the ONLY mocked
 * external boundary in W03 acceptance. The production GithubApp client talks
 * to it over real HTTP. It enforces what GitHub enforces: App JWTs are
 * RS256-verified against the App's public key; installation tokens only see
 * covered repositories; user tokens only see what that user can access, with
 * that user's permissions. Scenario mutators model admin loss, uninstall,
 * transfer, rename, archive, etc.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createVerify, generateKeyPairSync, randomBytes } from "node:crypto";

export type Perm = "admin" | "maintain" | "write" | "read";
export interface FakeUser {
  id: number;
  login: string;
}
export interface FakeRepo {
  id: number;
  name: string;
  owner: { id: number; login: string; type: string };
  private: boolean;
  fork: boolean;
  archived: boolean;
  default_branch: string;
  headSha: string;
  collaborators: Map<number, Perm>;
}
export interface FakeInstallation {
  id: number;
  account: { id: number; login: string; type: string };
  suspended: boolean;
  repoIds: Set<number>;
}

export class FakeGithub {
  readonly appId = "424242";
  readonly appSlug = "finco-forge-sandbox";
  readonly clientId = "Iv1.fakeforgeclient";
  readonly clientSecret = randomBytes(16).toString("hex");
  readonly privateKeyPem: string;
  private readonly publicKeyPem: string;
  users = new Map<number, FakeUser>();
  repos = new Map<number, FakeRepo>();
  installations = new Map<number, FakeInstallation>();
  private userTokens = new Map<string, number>();
  private instTokens = new Map<string, number>();
  private codes = new Map<string, number>();
  /** Which user "signs in" at the next /login/oauth/authorize. */
  nextLoginUser: number | null = null;
  server: Server | null = null;
  url = "";
  requests: string[] = [];

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    this.publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  }

  // ── scenario helpers ─────────────────────────────────────────────────
  addUser(id: number, login: string) {
    this.users.set(id, { id, login });
    return this.issueUserToken(id);
  }
  issueUserToken(userId: number) {
    const t = `ghu_${randomBytes(18).toString("hex")}`;
    this.userTokens.set(t, userId);
    return t;
  }
  addRepo(r: Omit<FakeRepo, "collaborators" | "headSha" | "default_branch" | "fork" | "archived" | "private"> & Partial<FakeRepo>) {
    const repo: FakeRepo = {
      private: false,
      fork: false,
      archived: false,
      default_branch: "main",
      headSha: randomBytes(20).toString("hex"),
      collaborators: new Map(),
      ...r,
    };
    this.repos.set(repo.id, repo);
    return repo;
  }
  install(id: number, account: FakeInstallation["account"], repoIds: number[]) {
    this.installations.set(id, { id, account, suspended: false, repoIds: new Set(repoIds) });
  }
  setPermission(repoId: number, userId: number, perm: Perm | null) {
    const r = this.repos.get(repoId)!;
    if (perm) r.collaborators.set(userId, perm);
    else r.collaborators.delete(userId);
  }
  uninstall(id: number) {
    this.installations.delete(id);
  }
  removeRepoFromInstallation(instId: number, repoId: number) {
    this.installations.get(instId)?.repoIds.delete(repoId);
  }
  transfer(repoId: number, newOwner: FakeRepo["owner"]) {
    const r = this.repos.get(repoId)!;
    for (const inst of this.installations.values()) inst.repoIds.delete(repoId);
    r.owner = newOwner;
    r.collaborators = new Map([[newOwner.id, "admin" as Perm]]);
  }
  rename(repoId: number, name: string) {
    this.repos.get(repoId)!.name = name;
  }

  fullName(r: FakeRepo) {
    return `${r.owner.login}/${r.name}`;
  }

  // ── HTTP ─────────────────────────────────────────────────────────────
  async start(port = 0): Promise<string> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: String(e) }));
      });
    });
    await new Promise<void>((r) => this.server!.listen(port, "127.0.0.1", () => r()));
    const addr = this.server.address();
    this.url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}`;
    return this.url;
  }
  async stop() {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private verifyAppJwt(auth: string | undefined): boolean {
    const m = /^Bearer (.+)\.(.+)\.(.+)$/.exec(auth ?? "");
    if (!m) return false;
    const [, h, p, s] = m;
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${p}`);
    if (!v.verify(this.publicKeyPem, Buffer.from(s!, "base64url"))) return false;
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString()) as { iss: string; exp: number; iat: number };
    const now = Math.floor(Date.now() / 1000);
    return claims.iss === this.appId && claims.exp > now && claims.iat <= now + 60 && claims.exp - claims.iat <= 660;
  }

  private repoJson(r: FakeRepo, perms?: Perm | null) {
    return {
      id: r.id,
      name: r.name,
      full_name: this.fullName(r),
      private: r.private,
      fork: r.fork,
      archived: r.archived,
      disabled: false,
      default_branch: r.default_branch,
      html_url: `https://github.com/${this.fullName(r)}`,
      owner: r.owner,
      ...(perms !== undefined
        ? {
            permissions: {
              admin: perms === "admin",
              maintain: perms === "admin" || perms === "maintain",
              push: perms === "admin" || perms === "maintain" || perms === "write",
              triage: !!perms,
              pull: !!perms || !r.private,
            },
          }
        : {}),
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    this.requests.push(`${req.method} ${url.pathname}`);
    const auth = req.headers.authorization;
    const userId = auth?.startsWith("token ") ? this.userTokens.get(auth.slice(6)) : undefined;
    const instId = auth?.startsWith("token ") ? this.instTokens.get(auth.slice(6)) : undefined;
    const p = url.pathname;
    let m: RegExpExecArray | null;

    if (req.method === "GET" && p === "/login/oauth/authorize") {
      if (url.searchParams.get("client_id") !== this.clientId || this.nextLoginUser === null) return send(400, { error: "bad_client_or_no_user" });
      const code = randomBytes(10).toString("hex");
      this.codes.set(code, this.nextLoginUser);
      const to = new URL(url.searchParams.get("redirect_uri")!);
      to.searchParams.set("code", code);
      to.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: to.toString() });
      return res.end();
    }
    if (req.method === "POST" && p === "/login/oauth/access_token") {
      const body = JSON.parse(await readBody(req)) as { client_id: string; client_secret: string; code: string };
      const uid = this.codes.get(body.code);
      this.codes.delete(body.code);
      if (body.client_id !== this.clientId || body.client_secret !== this.clientSecret || uid === undefined) return send(200, { error: "bad_verification_code" });
      return send(200, { access_token: this.issueUserToken(uid), token_type: "bearer", expires_in: 28800 });
    }
    if ((m = /^\/app\/installations\/(\d+)(\/access_tokens)?$/.exec(p))) {
      if (!this.verifyAppJwt(auth)) return send(401, { message: "Bad credentials" });
      const inst = this.installations.get(Number(m[1]));
      if (!inst) return send(404, { message: "Not Found" });
      if (m[2] && req.method === "POST") {
        if (inst.suspended) return send(403, { message: "suspended" });
        const t = `ghs_${randomBytes(18).toString("hex")}`;
        this.instTokens.set(t, inst.id);
        return send(201, { token: t, expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
      return send(200, { id: inst.id, account: inst.account, suspended_at: inst.suspended ? new Date().toISOString() : null, app_id: Number(this.appId) });
    }
    if (req.method === "GET" && p === "/user") {
      if (userId === undefined) return send(401, { message: "Bad credentials" });
      return send(200, this.users.get(userId));
    }
    if (req.method === "GET" && p === "/user/installations") {
      if (userId === undefined) return send(401, { message: "Bad credentials" });
      const list = [...this.installations.values()].filter((i) => [...i.repoIds].some((rid) => this.repos.get(rid)?.collaborators.has(userId)));
      return send(200, { total_count: list.length, installations: list.map((i) => ({ id: i.id, account: i.account, suspended_at: null })) });
    }
    if ((m = /^\/user\/installations\/(\d+)\/repositories$/.exec(p))) {
      if (userId === undefined) return send(401, { message: "Bad credentials" });
      const inst = this.installations.get(Number(m[1]));
      if (!inst) return send(404, { message: "Not Found" });
      const repos = [...inst.repoIds].map((id) => this.repos.get(id)!).filter((r) => r && r.collaborators.has(userId));
      const page = Number(url.searchParams.get("page") ?? "1");
      const slice = page === 1 ? repos : [];
      return send(200, { total_count: repos.length, repositories: slice.map((r) => this.repoJson(r, r.collaborators.get(userId))) });
    }
    if (req.method === "GET" && p === "/installation/repositories") {
      if (instId === undefined) return send(401, { message: "Bad credentials" });
      const inst = this.installations.get(instId);
      if (!inst) return send(401, { message: "Bad credentials" });
      const page = Number(url.searchParams.get("page") ?? "1");
      const repos = page === 1 ? [...inst.repoIds].map((id) => this.repos.get(id)!).filter(Boolean) : [];
      return send(200, { total_count: inst.repoIds.size, repositories: repos.map((r) => this.repoJson(r)) });
    }
    if ((m = /^\/repositories\/(\d+)$/.exec(p))) {
      const r = this.repos.get(Number(m[1]));
      if (!r) return send(404, { message: "Not Found" });
      if (userId !== undefined) {
        const perm = r.collaborators.get(userId) ?? null;
        if (r.private && !perm) return send(404, { message: "Not Found" });
        return send(200, this.repoJson(r, perm));
      }
      if (instId !== undefined) {
        const inst = this.installations.get(instId);
        if (!inst) return send(401, { message: "Bad credentials" });
        if (r.private && !inst.repoIds.has(r.id)) return send(404, { message: "Not Found" });
        return send(200, this.repoJson(r));
      }
      return send(401, { message: "Requires authentication" });
    }
    const findRepo = (owner: string, name: string) => [...this.repos.values()].find((r) => r.owner.login === owner && r.name === name);
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/collaborators\/([^/]+)\/permission$/.exec(p))) {
      const inst = instId !== undefined ? this.installations.get(instId) : undefined;
      const r = findRepo(m[1]!, m[2]!);
      if (!inst || !r || !inst.repoIds.has(r.id)) return send(404, { message: "Not Found" });
      const u = [...this.users.values()].find((x) => x.login === decodeURIComponent(m![3]!));
      if (!u) return send(404, { message: "Not Found" });
      const perm = r.collaborators.get(u.id);
      const legacy = perm === "admin" ? "admin" : perm === "maintain" || perm === "write" ? "write" : perm === "read" || !r.private ? "read" : "none";
      return send(200, { permission: legacy, role_name: perm ?? "read", user: { id: u.id, login: u.login } });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/branches\/([^/]+)$/.exec(p))) {
      const inst = instId !== undefined ? this.installations.get(instId) : undefined;
      const r = findRepo(m[1]!, m[2]!);
      if (!inst || !r || !inst.repoIds.has(r.id) || decodeURIComponent(m[3]!) !== r.default_branch) return send(404, { message: "Not Found" });
      return send(200, { name: r.default_branch, commit: { sha: r.headSha } });
    }
    if (req.method === "POST" && p === "/__control/login-as") {
      const body = JSON.parse(await readBody(req)) as { userId: number };
      this.nextLoginUser = body.userId;
      return send(200, { ok: true });
    }
    return send(404, { message: "Not Found" });
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
