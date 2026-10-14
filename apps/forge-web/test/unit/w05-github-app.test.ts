import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { GithubApp, GithubHttpError } from "@/server/github/client";
import { ForgeError } from "@/server/errors";
import { evaluateAppConfig, REQUIRED_EVENTS, type AppConfigEvidence } from "@/server/github/app-readiness";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const cfg = { appId: "1", appSlug: "forge", privateKeyPem: pem, clientId: "c", clientSecret: "s", apiUrl: "https://gh.test", webUrl: "https://gh.web" };

type Reply = { status: number; headers?: Record<string, string>; body?: unknown };
function fakeFetch(script: Reply[]) {
  const calls: Array<{ url: string; auth: string }> = [];
  const f = (async (url: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    calls.push({ url: String(url), auth: h.get("authorization") ?? "" });
    const r = script.shift() ?? { status: 500 };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const tokenReply = (t: string): Reply => ({ status: 201, body: { token: t, expires_at: new Date(Date.now() + 3_600_000).toISOString() } });

describe("W05 GitHub client: rate limits", () => {
  it("retries once after a bounded retry-after wait", async () => {
    const waits: number[] = [];
    const { f, calls } = fakeFetch([{ status: 403, headers: { "retry-after": "2" } }, { status: 200, body: { id: 7, login: "u" } }]);
    const gh = new GithubApp(cfg, f, { sleep: async (ms) => void waits.push(ms) });
    expect(await gh.getUser("tok")).toEqual({ id: 7, login: "u" });
    expect(waits).toEqual([2000]);
    expect(calls).toHaveLength(2);
  });

  it("fails closed (GITHUB_RATE_LIMITED) when the wait exceeds the bound, and never retries twice", async () => {
    const gh = new GithubApp(cfg, fakeFetch([{ status: 429, headers: { "retry-after": "120" } }]).f, { sleep: async () => undefined });
    await expect(gh.getUser("t")).rejects.toMatchObject({ code: "GITHUB_RATE_LIMITED", status: 503 });
    const twice = new GithubApp(cfg, fakeFetch([{ status: 403, headers: { "retry-after": "1" } }, { status: 403, headers: { "retry-after": "1" } }]).f, { sleep: async () => undefined });
    await expect(twice.getUser("t")).rejects.toBeInstanceOf(ForgeError);
  });

  it("an ordinary 403 (permission) is NOT treated as a rate limit", async () => {
    const gh = new GithubApp(cfg, fakeFetch([{ status: 403 }]).f, { sleep: async () => undefined });
    await expect(gh.getUser("t")).rejects.toBeInstanceOf(GithubHttpError);
  });

  it("primary limit: remaining=0 waits until reset, beyond the bound fails closed; headers are recorded", async () => {
    const now = 1_000_000_000_000;
    const reset = String(Math.floor(now / 1000) + 1);
    const ok = new GithubApp(cfg, fakeFetch([{ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } }, { status: 200, headers: { "x-ratelimit-remaining": "4999", "x-ratelimit-limit": "5000" }, body: { id: 1, login: "a" } }]).f, { sleep: async () => undefined, now: () => now });
    await ok.getUser("t");
    expect(ok.lastRateLimit).toMatchObject({ limit: 5000, remaining: 4999 });
    const far = String(Math.floor(now / 1000) + 3600);
    const bad = new GithubApp(cfg, fakeFetch([{ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": far } }]).f, { sleep: async () => undefined, now: () => now });
    await expect(bad.getUser("t")).rejects.toMatchObject({ code: "GITHUB_RATE_LIMITED" });
  });
});

describe("W05 GitHub client: installation-token rotation", () => {
  it("a 401 from a cached/revoked installation token mints exactly one fresh token and retries once", async () => {
    const { f, calls } = fakeFetch([tokenReply("old"), { status: 401 }, tokenReply("new"), { status: 200, body: { permission: "admin", user: { id: 1, login: "u" } } }]);
    const gh = new GithubApp(cfg, f);
    const r = await gh.collaboratorPermission(9, "o/r", "u");
    expect(r?.permission).toBe("admin");
    expect(calls.map((c) => c.auth.replace(/Bearer .*/, "Bearer <jwt>"))).toEqual(["Bearer <jwt>", "token old", "Bearer <jwt>", "token new"]);
  });

  it("a second 401 propagates (installation removed or key wrong) — no retry loop", async () => {
    const gh = new GithubApp(cfg, fakeFetch([tokenReply("a"), { status: 401 }, tokenReply("b"), { status: 401 }]).f);
    await expect(gh.collaboratorPermission(9, "o/r", "u")).rejects.toBeInstanceOf(GithubHttpError);
  });
});

describe("W05 GitHub App readiness evaluation", () => {
  const good = (over: Partial<AppConfigEvidence> = {}): AppConfigEvidence => ({
    source: "LIVE_GITHUB",
    app: { id: 1, slug: "forge", permissions: { metadata: "read", contents: "read" }, events: [...REQUIRED_EVENTS] },
    webhook: { url: "https://forge.example/api/github/webhook", content_type: "json", insecure_ssl: "0" },
    expectedOrigin: "https://forge.example",
    expectedSlug: "forge",
    ...over,
  });

  it("a least-privilege live configuration passes", () => {
    expect(evaluateAppConfig(good()).status).toBe("PASS");
  });

  it("a sandbox/fake GitHub is NEVER evidence, even when every check passes", () => {
    const r = evaluateAppConfig(good({ source: "SANDBOX" }));
    expect(r.status).toBe("SANDBOX_NOT_EVIDENCE");
  });

  it("any write/admin permission, missing read, missing event, plain-http or unverified-TLS webhook fails", () => {
    const fails = (e: AppConfigEvidence) => evaluateAppConfig(e).status === "FAIL";
    expect(fails(good({ app: { ...good().app, permissions: { metadata: "read", contents: "write" } } }))).toBe(true);
    expect(fails(good({ app: { ...good().app, permissions: { metadata: "read", contents: "read", administration: "read" } } }))).toBe(true);
    expect(fails(good({ app: { ...good().app, permissions: { metadata: "read" } } }))).toBe(true);
    expect(fails(good({ app: { ...good().app, events: ["installation"] } }))).toBe(true);
    expect(fails(good({ webhook: { url: "http://forge.example/api/github/webhook", content_type: "json", insecure_ssl: "0" } }))).toBe(true);
    expect(fails(good({ webhook: { url: "https://forge.example/api/github/webhook", content_type: "json", insecure_ssl: "1" } }))).toBe(true);
    expect(fails(good({ webhook: null }))).toBe(true);
    expect(fails(good({ expectedSlug: "other" }))).toBe(true);
  });
});
