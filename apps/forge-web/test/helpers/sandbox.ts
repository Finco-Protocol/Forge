import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createAppContext, type AppContext } from "@/server/context";
import { PgliteDb } from "@/server/db";
import { dispatch } from "@/server/api/handlers";
import { deploySandbox, ANVIL_KEYS, type SandboxDeployment } from "../../scripts/sandbox-lib";
import { startAnvil, type Anvil } from "./anvil";
import { FakeGithub } from "./fake-github";
import { sandboxEnv, ORIGIN } from "./env";
export { sandboxEnv, ORIGIN };


export interface Sandbox {
  anvil: Anvil;
  deployment: SandboxDeployment;
  github: FakeGithub;
  ctx: AppContext;
  env: Record<string, string>;
  stop(): Promise<void>;
}

export async function startSandbox(
  extraEnv: Record<string, string> = {},
  opts: { deploy?: (rpcUrl: string) => Promise<SandboxDeployment> } = {},
): Promise<Sandbox> {
  const anvil = await startAnvil();
  // W05: `opts.deploy` lets the genuine-V4 suite inject its own stack; the default (mock) path is unchanged.
  const deployment = await (opts.deploy ?? ((u: string) => deploySandbox(u)))(anvil.url);
  const dir = mkdtempSync(path.join(tmpdir(), "forge-w03-"));
  const deploymentFile = path.join(dir, "deployment.json");
  writeFileSync(deploymentFile, JSON.stringify(deployment));
  const github = new FakeGithub();
  await github.start();
  const env = sandboxEnv(deployment, github, anvil.url, deploymentFile, extraEnv);
  const ctx = await createAppContext(env, { db: await PgliteDb.open() });
  return {
    anvil,
    deployment,
    github,
    ctx,
    env,
    stop: async () => {
      await github.stop();
      await ctx.db.close();
      await anvil.stop();
    },
  };
}

export function chainClients(rpcUrl: string, key: Hex) {
  const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const account = privateKeyToAccount(key);
  return {
    account,
    pub: createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 100 }),
    wallet: createWalletClient({ chain, transport: http(rpcUrl), account, pollingInterval: 100 }),
  };
}

export { ANVIL_KEYS };

/** A cookie-jar "browser" driving the real API dispatcher (same-origin, CSRF header echoed from the cookie). */
export class TestBrowser {
  cookies = new Map<string, string>();
  constructor(private readonly sb: Sandbox, private readonly origin = ORIGIN) {}

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

  async request(method: string, pathOrUrl: string, body?: unknown, opts: { csrf?: boolean; origin?: string | null; headers?: Record<string, string> } = {}) {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.origin}${pathOrUrl}`;
    const headers = new Headers(opts.headers);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; "));
    if (opts.origin !== null) headers.set("origin", opts.origin ?? this.origin);
    if (opts.csrf !== false && this.cookies.get("forge_csrf")) headers.set("x-forge-csrf", this.cookies.get("forge_csrf")!);
    if (body !== undefined) headers.set("content-type", "application/json");
    const res = await dispatch(this.sb.ctx, new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
    this.absorb(res);
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* redirect */
    }
    return { status: res.status, json: json as Record<string, any>, headers: res.headers }; // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  get(p: string) {
    return this.request("GET", p);
  }
  post(p: string, body: unknown = {}) {
    return this.request("POST", p, body);
  }

  /** Full GitHub App OAuth web flow through the fake GitHub's real HTTP endpoints. */
  async signInGithub(userId: number) {
    this.sb.github.nextLoginUser = userId;
    await this.get("/api/me");
    const start = await this.get("/api/auth/github/start");
    const authorize = await fetch(start.headers.get("location")!, { redirect: "manual" });
    const callback = authorize.headers.get("location")!;
    const cb = await this.request("GET", callback);
    if (cb.status !== 302) throw new Error(`callback failed: ${JSON.stringify(cb.json)}`);
    return cb;
  }

  /** SIWE wallet binding with a real secp256k1 signature. */
  async bindWallet(key: Hex) {
    const account = privateKeyToAccount(key);
    const ch = await this.post("/api/wallet/challenge", { address: account.address, chainId: 31337 });
    if (ch.status !== 200) return ch;
    const signature = await account.signMessage({ message: ch.json.message });
    return this.post("/api/wallet/verify", { message: ch.json.message, signature });
  }
}
