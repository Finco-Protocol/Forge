/**
 * W06 process-based staging stack: the same topology as
 * ops/staging/docker-compose.staging.yml, as separate OS processes:
 *
 *   PostgreSQL database (existing local server, one scratch DB per stack)
 *   Anvil (local dev chain 31337)            ← SIMULATED CHAIN
 *   simulated GitHub (FakeGithub)            ← SIMULATED EXTERNAL SERVICE, never evidence
 *   migrate (one-shot CLI)  →  web (`next start`)  +  worker (`tsx scripts/worker.ts`)
 *
 * Needs `pnpm build` (the production Next.js build) and `forge build --profile forge`.
 * Everything is loopback-only; the staging guard (src/server/staging/guard.ts) validates the environment.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deploySandbox, writeDeployment, type SandboxDeployment } from "../sandbox-lib";
import { startAnvil, freePort, rpc, type Anvil } from "../../test/helpers/anvil";
import { FakeGithub } from "../../test/helpers/fake-github";
import { sandboxEnv } from "../../test/helpers/env";
import { createDatabaseSql, dropDatabaseSql } from "../w05/sql-ident";
import { APP_ROOT, withDb } from "./staging-lib";

const BIN = path.join(APP_ROOT, "node_modules", ".bin");

export interface ManagedProc {
  proc: ChildProcess;
  name: string;
  logFile: string;
  exited: Promise<number | null>;
}

function launch(name: string, cmd: string, args: string[], env: NodeJS.ProcessEnv, logDir: string): ManagedProc {
  const logFile = path.join(logDir, `${name}-${Date.now()}.log`);
  const out = createWriteStream(logFile);
  const proc = spawn(cmd, args, { cwd: APP_ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  proc.stdout!.pipe(out);
  proc.stderr!.pipe(out);
  const exited = new Promise<number | null>((r) => proc.on("exit", (c) => r(c)));
  return { proc, name, logFile, exited };
}

export async function stopProc(p: ManagedProc | undefined, signal: NodeJS.Signals = "SIGTERM", graceMs = 15_000): Promise<number | null> {
  if (!p || p.proc.exitCode !== null || p.proc.signalCode !== null) return p?.proc.exitCode ?? null;
  const kill = (s: NodeJS.Signals) => {
    try {
      process.kill(-p.proc.pid!, s);
    } catch {
      p.proc.kill(s);
    }
  };
  kill(signal);
  const code = await Promise.race([p.exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), graceMs))]);
  if (code === "timeout") {
    kill("SIGKILL");
    return p.exited;
  }
  return code;
}

/** Cookie-jar HTTP client for the real web server (same-origin, CSRF echoed). */
export class HttpClient {
  cookies = new Map<string, string>();
  constructor(readonly origin: string) {}
  private absorb(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const i = kv!.indexOf("=");
      const name = kv!.slice(0, i);
      const value = decodeURIComponent(kv!.slice(i + 1));
      if (/Max-Age=0/.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  async request(method: string, pathOrUrl: string, body?: unknown, headers: Record<string, string> = {}) {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.origin}${pathOrUrl}`;
    const h = new Headers(headers);
    if (this.cookies.size) h.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; "));
    h.set("origin", this.origin);
    if (this.cookies.get("forge_csrf")) h.set("x-forge-csrf", this.cookies.get("forge_csrf")!);
    if (body !== undefined) h.set("content-type", "application/json");
    const res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    this.absorb(res);
    const text = await res.text();
    let json: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* redirect / html */
    }
    return { status: res.status, json, headers: res.headers };
  }
  get(p: string, headers?: Record<string, string>) {
    return this.request("GET", p, undefined, headers);
  }
  post(p: string, body: unknown = {}) {
    return this.request("POST", p, body);
  }
  async signInGithub(gh: FakeGithub, userId: number) {
    gh.nextLoginUser = userId;
    await this.get("/api/me");
    const start = await this.get("/api/auth/github/start");
    const authorize = await fetch(start.headers.get("location")!, { redirect: "manual" });
    const cb = await this.request("GET", authorize.headers.get("location")!);
    if (cb.status !== 302) throw new Error(`callback failed: ${JSON.stringify(cb.json)}`);
  }
  async bindWallet(key: Hex) {
    const account = privateKeyToAccount(key);
    const ch = await this.post("/api/wallet/challenge", { address: account.address, chainId: 31337 });
    if (ch.status !== 200) return ch;
    const signature = await account.signMessage({ message: ch.json.message });
    return this.post("/api/wallet/verify", { message: ch.json.message, signature });
  }
}

export interface StackOptions {
  /** Admin URL of a PostgreSQL server (creates and drops a scratch database for this stack). */
  adminUrl: string;
  workdir?: string;
  /** Job lease (seconds, min 10): short so worker-crash recovery is observable. */
  leaseSeconds?: number;
  extraEnv?: Record<string, string>;
}

export class StagingStack {
  anvil!: Anvil;
  deployment!: SandboxDeployment;
  github!: FakeGithub;
  dbName!: string;
  dbUrl!: string;
  web?: ManagedProc;
  worker?: ManagedProc;
  webPort = 0;
  workdir: string;
  deploymentFile!: string;
  env: Record<string, string> = {};
  opsToken = randomBytes(24).toString("hex");
  private constructor(private readonly opts: StackOptions) {
    this.workdir = opts.workdir ?? mkdtempSync(path.join(tmpdir(), "forge-w06-stack-"));
    mkdirSync(path.join(this.workdir, "logs"), { recursive: true });
  }
  get origin() {
    return `http://localhost:${this.webPort}`;
  }
  get logDir() {
    return path.join(this.workdir, "logs");
  }

  static async create(opts: StackOptions): Promise<StagingStack> {
    const s = new StagingStack(opts);
    if (!existsSync(path.join(APP_ROOT, ".next", "BUILD_ID"))) throw new Error("production build missing: run `pnpm build` in apps/forge-web first");
    s.dbName = `forge_staging_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: opts.adminUrl });
    await admin.connect();
    try {
      await admin.query(createDatabaseSql(s.dbName));
    } finally {
      await admin.end();
    }
    s.dbUrl = withDb(opts.adminUrl, s.dbName);
    s.anvil = await startAnvil();
    s.deployment = await deploySandbox(s.anvil.url);
    s.deploymentFile = path.join(s.workdir, "deployment.json");
    writeDeployment(s.deployment, s.deploymentFile);
    s.github = new FakeGithub();
    await s.github.start();
    s.seedGithub();
    s.webPort = await freePort();
    s.env = {
      ...sandboxEnv(s.deployment, s.github, s.anvil.url, s.deploymentFile, {
        FORGE_PUBLIC_ORIGIN: s.origin,
        SESSION_SECRET: randomBytes(32).toString("hex"),
      }),
      FORGE_STAGING: "true",
      DATABASE_URL: s.dbUrl,
      FORGE_OPS_TOKEN: s.opsToken,
      FORGE_EMBEDDED_WORKER: "false",
      FORGE_JOB_LEASE_SECONDS: String(opts.leaseSeconds ?? 10),
      FORGE_WORKER_HEARTBEAT_STALE_SECONDS: "15",
      FORGE_WORKER_INTERVAL_MS: "500",
      ...opts.extraEnv,
    };
    return s;
  }

  seedGithub() {
    const org = { id: 9001, login: "finco-labs", type: "Organization" };
    this.github.addUser(1001, "alice-admin");
    this.github.addRepo({ id: 5001, name: "forge-demo", owner: org });
    this.github.setPermission(5001, 1001, "admin");
    this.github.install(7001, org, [5001]);
  }

  private procEnv(role: "web" | "worker" | "cli", extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { ...process.env, ...this.env, NODE_ENV: role === "web" ? "production" : "development", FORGE_PROCESS_ROLE: role, PORT: String(this.webPort), ...extra };
  }

  /** One-shot migrate CLI (the production pattern: web and worker then run with FORGE_DB_MIGRATE=verify). Returns the exit code and output. */
  async migrate(extra: Record<string, string> = {}, timeoutMs = 120_000): Promise<{ code: number | null; output: string }> {
    const p = launch("migrate", path.join(BIN, "tsx"), ["scripts/migrate.ts"], this.procEnv("cli", extra), this.logDir);
    const code = await Promise.race([p.exited, new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
    if (code === null) await stopProc(p, "SIGKILL", 1_000);
    return { code, output: readFileSync(p.logFile, "utf8") };
  }

  async startWeb(extra: Record<string, string> = {}): Promise<void> {
    this.web = launch("web", path.join(BIN, "next"), ["start", "-p", String(this.webPort)], this.procEnv("web", { FORGE_DB_MIGRATE: "verify", ...extra }), this.logDir);
    await this.waitHttp("/api/live", 60_000, this.web);
  }
  startWorker(extra: Record<string, string> = {}): void {
    this.worker = launch("worker", path.join(BIN, "tsx"), ["scripts/worker.ts"], this.procEnv("worker", { FORGE_DB_MIGRATE: "verify", ...extra }), this.logDir);
  }
  async stopWeb(signal: NodeJS.Signals = "SIGTERM") {
    return stopProc(this.web, signal);
  }
  async stopWorker(signal: NodeJS.Signals = "SIGTERM") {
    return stopProc(this.worker, signal);
  }

  async waitHttp(p: string, timeoutMs: number, proc?: ManagedProc): Promise<void> {
    const t0 = Date.now();
    for (;;) {
      if (proc && proc.proc.exitCode !== null) throw new Error(`${proc.name} exited (${proc.proc.exitCode}) before ${p} answered:\n${readFileSync(proc.logFile, "utf8").slice(-3000)}`);
      try {
        const r = await fetch(`${this.origin}${p}`);
        if (r.ok) return;
      } catch {
        /* booting */
      }
      if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${p}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async until<T>(what: string, fn: () => Promise<T | null | false | undefined>, timeoutMs = 60_000, everyMs = 300): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      const v = await fn().catch(() => null);
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
      await new Promise((r) => setTimeout(r, everyMs));
    }
  }

  opsGet(p: string) {
    return fetch(`${this.origin}${p}`, { headers: { authorization: `Bearer ${this.opsToken}` } }).then(async (r) => ({ status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> })); // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  chain(key: Hex) {
    const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [this.anvil.url] } } });
    const account = privateKeyToAccount(key);
    return { account, pub: createPublicClient({ chain, transport: http(this.anvil.url), pollingInterval: 100 }), wallet: createWalletClient({ chain, transport: http(this.anvil.url), account, pollingInterval: 100 }) };
  }

  rpc<T = unknown>(method: string, params: unknown[] = []) {
    return rpc<T>(this.anvil.url, method, params);
  }

  async stop(opts: { dropDb?: boolean } = {}) {
    await stopProc(this.worker);
    await stopProc(this.web);
    await this.github?.stop().catch(() => undefined);
    await this.anvil?.stop().catch(() => undefined);
    if (opts.dropDb !== false && this.dbName) {
      const admin = new pg.Client({ connectionString: this.opts.adminUrl });
      await admin.connect();
      try {
        await admin.query(dropDatabaseSql(this.dbName, true));
      } finally {
        await admin.end();
      }
    }
  }

  writeManifestNote(file: string, data: unknown) {
    writeFileSync(file, JSON.stringify(data, null, 2));
  }
}
