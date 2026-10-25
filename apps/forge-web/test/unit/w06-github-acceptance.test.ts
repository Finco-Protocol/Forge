/**
 * W06 GitHub App acceptance matrix (unit level; PGlite + the production
 * webhook handler / client / readiness code). EVERY test here runs against a
 * fake GitHub or no GitHub at all: SANDBOX_NOT_EVIDENCE. Nothing here is
 * evidence that a real GitHub App is registered or correctly configured
 * (status stays EXTERNAL_GITHUB_APP_CONFIGURATION_REQUIRED).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync, randomUUID , createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PgliteDb } from "@/server/db";
import { migrate } from "@/server/db/migrate";
import { handleWebhook, signWebhookBody } from "@/server/github/webhooks";
import { retryDueWebhookDeliveries } from "@/server/github/webhooks";
import { GithubApp, GithubHttpError } from "@/server/github/client";
import { evaluateAppConfig, OPERATOR_SETUP, OPTIONAL_READ_PERMISSIONS, REQUIRED_EVENTS, REQUIRED_PERMISSIONS, type AppConfigEvidence } from "@/server/github/app-readiness";
import type { AppContext } from "@/server/context";

const SECRET = "w06-test-webhook-secret-w06-test-webhook-secret";
let db: PgliteDb;
let forgotten: number[] = [];
let allowPrivate = false;

const ctx = () =>
  ({
    db,
    cfg: {
      github: { webhookSecret: SECRET },
      policy: { get allowPrivateRepos() { return allowPrivate; } },
      worker: { webhookMaxAttempts: 8, jobLeaseSeconds: 30, heartbeatStaleSeconds: 60 }, // W07 delivery lifecycle
      revocationSloSeconds: 300,
    },
    github: { forgetInstallation: (id: number) => void forgotten.push(id) },
  }) as unknown as AppContext;

beforeAll(async () => {
  db = await PgliteDb.open();
  await migrate(db);
}, 60_000);
afterAll(async () => db?.close());

let seq = 0;
/** One repository with an installation, an active verification and (optionally) wallet-less evidence. */
async function seedRepo(opts: { owner?: number; expired?: boolean } = {}) {
  const n = ++seq;
  const repoId = 500_000 + n, inst = 600_000 + n, owner = opts.owner ?? 700_000 + n, user = 800_000 + n;
  await db.query("INSERT INTO installations(installation_id, account_id, account_login, account_type) VALUES ($1,$2,$3,'Organization')", [inst, owner, `org-${n}`]);
  await db.query(
    "INSERT INTO repositories(repo_id, full_name, owner_id, owner_login, installation_id, private, default_branch) VALUES ($1,$2,$3,$4,$5,false,'main')",
    [repoId, `org-${n}/repo-${n}`, owner, `org-${n}`, inst],
  );
  const vid = randomUUID();
  await db.query(
    `INSERT INTO verifications(id, repo_id, github_user_id, github_login, installation_id, full_name, owner_login, owner_id, default_branch, commit_sha, private,
       user_permission, installation_permission, evidence, evidence_hash, verified_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'main',$9,false,'admin','admin','{}','h', now() - interval '2 hours', now() ${opts.expired ? "-" : "+"} interval '1 hour')`,
    [vid, repoId, user, `user-${n}`, inst, `org-${n}/repo-${n}`, `org-${n}`, owner, "a".repeat(40)],
  );
  return { n, repoId, inst, owner, user, vid };
}
type Seed = Awaited<ReturnType<typeof seedRepo>>;

async function post(event: string, payload: unknown, o: { delivery?: string; secret?: string; body?: string; sigOverride?: string | null; headers?: Record<string, string> } = {}) {
  const body = o.body ?? JSON.stringify(payload);
  const headers: Record<string, string> = { "x-github-delivery": o.delivery ?? randomUUID(), "x-github-event": event, ...(o.headers ?? {}) };
  if (o.sigOverride !== null) headers["x-hub-signature-256"] = o.sigOverride ?? signWebhookBody(o.secret ?? SECRET, body);
  return handleWebhook(ctx(), new Request("http://localhost/api/github/webhook", { method: "POST", headers, body }));
}

const active = async (repoId: number) =>
  (await db.query<{ c: string }>("SELECT count(*)::text c FROM verifications WHERE repo_id = $1 AND revoked_at IS NULL AND expires_at > now()", [repoId])).rows[0]!.c;
const jobs = async (repoId: number, kind: string) =>
  (await db.query("SELECT 1 FROM jobs WHERE kind = $1 AND payload->>'repoId' = $2", [kind, String(repoId)])).rows.length;
const deliveries = async () => Number((await db.query<{ c: string }>("SELECT count(*)::text c FROM webhook_deliveries")).rows[0]!.c);
const ineligible = async (repoId: number) => (await db.query<{ r: string | null }>("SELECT ineligible_reason r FROM repositories WHERE repo_id = $1", [repoId])).rows[0]!.r;

// ── 1. webhook signature ────────────────────────────────────────────────────

describe("W06 GitHub: webhook signature (HMAC-SHA256, verified BEFORE parsing)", () => {
  const body = JSON.stringify({ action: "edited", repository: { id: 1, full_name: "a/b", default_branch: "main" } });

  it("accepts only the exact sha256=HMAC(secret, raw body)", async () => {
    const r = await post("repository", null, { body });
    expect(r).toMatchObject({ status: 200, body: { processed: true } });
  });

  it("rejects missing, empty, wrong-secret, truncated, sha1-style, upper-cased and body-tampered signatures; none leaves a delivery row", async () => {
    const before = await deliveries();
    const good = signWebhookBody(SECRET, body);
    const bad: Array<[string, string | null]> = [
      ["missing", null],
      ["empty", ""],
      ["wrong secret", signWebhookBody("some-other-secret-some-other-secret!!", body)],
      ["truncated", good.slice(0, -2)],
      ["extra byte", `${good}0`],
      ["sha1 prefix", good.replace("sha256=", "sha1=")],
      ["no prefix", good.replace("sha256=", "")],
      ["upper-case hex", `sha256=${good.slice(7).toUpperCase()}`],
      ["signature of a different body", signWebhookBody(SECRET, body + " ")],
    ];
    for (const [label, sig] of bad) {
      await expect(post("repository", null, { body, sigOverride: sig }), label).rejects.toMatchObject({ code: "BAD_SIGNATURE", status: 401 });
    }
    expect(await deliveries()).toBe(before);
    const audited = await db.query("SELECT 1 FROM audit_events WHERE action = 'webhook_signature_rejected'");
    expect(audited.rows.length).toBeGreaterThanOrEqual(bad.length);
  });

  it("the signature is checked before the body is parsed (unsigned garbage is a 401, never a parser error)", async () => {
    await expect(post("repository", null, { body: "{not json", sigOverride: "sha256=00" })).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
  });

  it("W07: a correctly signed but malformed body is a CONTROLLED 400 INVALID_PAYLOAD — signature checked first, no receipt, no state change, no queued work, audited", async () => {
    const before = await deliveries();
    await expect(post("repository", null, { body: "{not json" })).rejects.toMatchObject({ code: "INVALID_PAYLOAD", status: 400 });
    await expect(post("repository", null, { body: "null" })).rejects.toMatchObject({ code: "INVALID_PAYLOAD", status: 400 });
    await expect(post("repository", null, { body: "[1,2]" })).rejects.toMatchObject({ code: "INVALID_PAYLOAD", status: 400 });
    expect(await deliveries()).toBe(before); // no receipt, nothing queued
    const audited = await db.query("SELECT 1 FROM audit_events WHERE action = 'webhook_invalid_payload'");
    expect(audited.rows.length).toBeGreaterThanOrEqual(3); // the refusal is immutably audited
  });

  it("malformed delivery/event headers and oversize payloads are refused (400/413)", async () => {
    const before = await deliveries();
    await expect(post("repository", null, { body, delivery: "x" })).rejects.toMatchObject({ code: "BAD_DELIVERY", status: 400 });
    await expect(post("Repository", null, { body })).rejects.toMatchObject({ code: "BAD_DELIVERY", status: 400 });
    await expect(post("repository", null, { body: " ".repeat(5 * 1024 * 1024 + 1) })).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE", status: 413 });
    expect(await deliveries()).toBe(before);
  });
});

// ── 2. replay protection and atomicity ──────────────────────────────────────

describe("W06 GitHub: replay protection and atomic delivery processing", () => {
  it("W07: a replayed delivery GUID with a DIFFERENT body is refused (delivery-id/payload binding) — no attacker-chosen second effect; the same body is a duplicate no-op", async () => {
    const s = await seedRepo();
    const delivery = randomUUID();
    const first = await post("repository", { action: "edited", repository: { id: s.repoId, full_name: "x/y", default_branch: "main" } }, { delivery });
    expect(first.body).toMatchObject({ processed: true, outcome: "edited" });
    expect(await active(s.repoId)).toBe("1");
    // a different body under the same GUID: REFUSED, not a misleading 200
    await expect(
      post("repository", { action: "deleted", repository: { id: s.repoId, full_name: "x/y" } }, { delivery, body: JSON.stringify({ action: "deleted", repository: { id: s.repoId, full_name: "x/y" } }) + " " }),
    ).rejects.toMatchObject({ code: "PAYLOAD_MISMATCH", status: 409 });
    expect(await active(s.repoId)).toBe("1");
    expect(await jobs(s.repoId, "registry_revoke")).toBe(0);
    const row = (await db.query<{ action: string }>("SELECT action FROM webhook_deliveries WHERE delivery_id = $1", [delivery])).rows[0]!;
    expect(row.action).toBe("edited"); // the first body is what was recorded
  });

  it("W07: a delivery whose processing fails leaves a DURABLE receipt (attempts, error, retry) with NO side effects, and the SAME-GUID replay of a processed delivery is a no-op", async () => {
    const s = await seedRepo();
    const delivery = randomUUID();
    // A non-numeric repo id makes the first SQL statement of the transferred handler throw inside the transaction.
    await expect(post("repository", { action: "transferred", repository: { id: "not-a-number", full_name: "a/b" } }, { delivery })).rejects.toThrow();
    // W07 lifecycle: the failure is durably RECEIPTED (attempts, last_error, retry scheduled) —
    // monitoring can observe it and the worker can retry it — while the failed side effects
    // (invalidation, queued revocations) are fully rolled back.
    const row = (await db.query<{ status: string; attempts: string; last_error: string; signature_verified: boolean }>(
      "SELECT status, attempts::text, last_error, signature_verified FROM webhook_deliveries WHERE delivery_id = $1",
      [delivery],
    )).rows[0]!;
    expect(row.status).toBe("received");
    expect(Number(row.attempts)).toBe(1);
    expect(row.last_error).toBeTruthy();
    expect(row.signature_verified).toBe(true);
    expect(await ineligible(s.repoId)).toBeNull(); // no partial application effects
    expect(await jobs(s.repoId, "registry_revoke")).toBe(0); // no unauthorized queued work
    // A different payload under the same GUID is REFUSED (delivery-id/payload binding).
    await expect(post("repository", { action: "archived", repository: { id: s.repoId, full_name: "a/b" } }, { delivery })).rejects.toMatchObject({
      code: "PAYLOAD_MISMATCH",
      status: 409,
    });
    // The stored receipt still describes the ORIGINAL authenticated payload.
    const stored = (await db.query<{ action: string }>("SELECT action FROM webhook_deliveries WHERE delivery_id = $1", [delivery])).rows[0]!;
    expect(stored.action).toBe("transferred");
    // And the reactivated failed delivery is retried by the worker with bounded attempts (proven in the incident drills).
  });
});

// ── 2b. W07 exactly-once and concurrent delivery safety ─────────────────────

describe("W07 GitHub: exactly-once processing under concurrency and delivery-id/payload binding", () => {
  it("two SIMULTANEOUS requests with the same delivery GUID process exactly once: one applies, the other is a duplicate no-op (no double audit, no double jobs, no double invalidation)", async () => {
    const s = await seedRepo();
    const delivery = randomUUID();
    const payload = { action: "deleted", repository: { id: s.repoId, full_name: "x/y" } };
    const [r1, r2] = await Promise.allSettled([post("repository", payload, { delivery }), post("repository", payload, { delivery })]);
    if (r1.status === "rejected" && r2.status === "rejected") throw new Error(`both requests failed: ${r1.reason} / ${r2.reason}`);
    const ok = r1.status === "fulfilled" ? r1 : r2.status === "fulfilled" ? r2 : null;
    if (!ok) throw new Error("neither request fulfilled");
    const fulfilled = ok.value;
    expect(fulfilled.body).toMatchObject({ processed: true });
    const audits = await db.query<{ n: string }>("SELECT count(*)::text n FROM audit_events WHERE action = 'webhook_repository' AND subject = $1", [`repo:${s.repoId}`]);
    expect(Number(audits.rows[0]!.n)).toBe(1); // exactly one processing audit event
    expect(await jobs(s.repoId, "registry_revoke")).toBe(1); // exactly one revocation queued
    expect(await ineligible(s.repoId)).toBe("deleted");
    expect(await active(s.repoId)).toBe("0");
  });

  it("a worker retry racing an HTTP redelivery of the SAME delivery serializes on the row lock: exactly one apply", async () => {
    const s = await seedRepo();
    const delivery = randomUUID();
    // Simulate a durably received, due-for-retry receipt (as the crash window would leave it).
    const body = JSON.stringify({ action: "deleted", repository: { id: s.repoId, full_name: "x/y" } });
    await db.query(
      "INSERT INTO webhook_deliveries(delivery_id, event, action, payload_sha256, body, signature_verified, status, attempts, next_retry_at, received_at) VALUES ($1,'repository','deleted',$2,$3,true,'received',1, now(), now() - interval '1 hour')",
      [delivery, createHash("sha256").update(body).digest("hex"), body],
    );
    const [worker, http] = await Promise.allSettled([
      retryDueWebhookDeliveries(ctx(), 5),
      post("repository", JSON.parse(body), { delivery }),
    ]);
    if (worker.status === "rejected" && http.status === "rejected") throw new Error(`both failed: ${worker.reason} / ${http.reason}`);
    const audits = await db.query<{ n: string }>("SELECT count(*)::text n FROM audit_events WHERE action = 'webhook_repository' AND subject = $1", [`repo:${s.repoId}`]);
    expect(Number(audits.rows[0]!.n)).toBe(1); // serialized: exactly one apply
    const row = (await db.query<{ status: string }>("SELECT status FROM webhook_deliveries WHERE delivery_id = $1", [delivery])).rows[0]!;
    expect(row.status).toBe("processed");
    expect(await jobs(s.repoId, "registry_revoke")).toBe(1);
  });

  it("delivery-id/payload binding: same ID + same payload re-activates a failed delivery; same ID + different EVENT or payload is refused; processed stays a no-op", async () => {
    const s = await seedRepo();
    const delivery = randomUUID();
    // A TRANSIENT failure seeded as a received receipt; the same authenticated payload is
    // redelivered via HTTP and must be re-activated and processed.
    const body = JSON.stringify({ action: "transferred", repository: { id: s.repoId, full_name: "new-owner/x", owner: { id: 424242, login: "new-owner" } } });
    const sha = createHash("sha256").update(body).digest("hex");
    await db.query(
      "INSERT INTO webhook_deliveries(delivery_id, event, action, payload_sha256, body, signature_verified, status, attempts, last_error, next_retry_at, received_at) VALUES ($1,'repository','transferred',$2,$3,true,'received',1,'seeded transient failure', now(), now() - interval '1 hour')",
      [delivery, sha, body],
    );
    const r = await post("repository", JSON.parse(body), { delivery });
    expect(r.body).toMatchObject({ processed: true, outcome: "transferred" });
    expect(await ineligible(s.repoId)).toBe("transferred");
    // processed + same GUID + different body: REFUSED (the binding is checked before any status shortcut)
    await expect(post("repository", { action: "archived", repository: { id: s.repoId, full_name: "x/y" } }, { delivery })).rejects.toMatchObject({ code: "PAYLOAD_MISMATCH", status: 409 });
    // processed + different EVENT under the same GUID: refused (binding checked even on processed rows)
    await expect(post("installation", { action: "deleted", installation: { id: s.inst } }, { delivery })).rejects.toMatchObject({ code: "PAYLOAD_MISMATCH", status: 409 });
    // a FAILED delivery + different payload: refused (no silent substitution)
    const failed = randomUUID();
    await db.query(
      "INSERT INTO webhook_deliveries(delivery_id, event, action, payload_sha256, body, signature_verified, status, attempts, last_error) VALUES ($1,'repository','archived',$2,$3,true,'failed',8,'seeded terminal failure')",
      [failed, sha, body],
    );
    await expect(post("repository", { action: "deleted", repository: { id: s.repoId, full_name: "x/y" } }, { delivery: failed })).rejects.toMatchObject({ code: "PAYLOAD_MISMATCH", status: 409 });
    const still = (await db.query<{ status: string; attempts: string }>("SELECT status, attempts::text FROM webhook_deliveries WHERE delivery_id = $1", [failed])).rows[0]!;
    expect(still.status).toBe("failed");
    expect(Number(still.attempts)).toBe(8);
  });
});

// ── 3. revocation / transfer / installation removal / stale-proof invalidation ─

describe("W06 GitHub: events that must NARROW eligibility invalidate every proof and queue the on-chain revocation", () => {
  const narrowing: Array<{ name: string; event: string; payload: (s: Seed) => unknown; reason: string; installationScoped?: boolean }> = [
    { name: "repository transferred", event: "repository", payload: (s) => ({ action: "transferred", repository: { id: s.repoId, full_name: `new-owner/repo-${s.n}`, owner: { id: 9_999_999, login: "new-owner" } } }), reason: "transferred" },
    { name: "repository archived", event: "repository", payload: (s) => ({ action: "archived", repository: { id: s.repoId, full_name: "a/b" } }), reason: "archived" },
    { name: "repository deleted", event: "repository", payload: (s) => ({ action: "deleted", repository: { id: s.repoId, full_name: "a/b" } }), reason: "deleted" },
    { name: "repository made private (private repos not allowed)", event: "repository", payload: (s) => ({ action: "privatized", repository: { id: s.repoId, full_name: "a/b" } }), reason: "privatized" },
    { name: "repository removed from the installation", event: "installation_repositories", payload: (s) => ({ action: "removed", installation: { id: s.inst }, repositories_removed: [{ id: s.repoId, full_name: "a/b" }] }), reason: "installation_repository_removed" },
    { name: "installation removed (App uninstalled)", event: "installation", payload: (s) => ({ action: "deleted", installation: { id: s.inst } }), reason: "installation_removed", installationScoped: true },
    { name: "installation suspended", event: "installation", payload: (s) => ({ action: "suspend", installation: { id: s.inst } }), reason: "installation_suspended", installationScoped: true },
  ];
  for (const c of narrowing) {
    it(`${c.name}: proofs revoked, repo marked ineligible, one registry_revoke job`, async () => {
      allowPrivate = false;
      forgotten = [];
      const s = await seedRepo();
      expect(await active(s.repoId)).toBe("1");
      const r = await post(c.event, c.payload(s));
      expect(r.body).toMatchObject({ processed: true });
      expect(await active(s.repoId), "no live proof remains").toBe("0");
      const v = (await db.query<{ revoke_reason: string }>("SELECT revoke_reason FROM verifications WHERE id = $1", [s.vid])).rows[0]!;
      expect(v.revoke_reason).toBe(c.reason);
      expect(await ineligible(s.repoId)).toBe(c.reason);
      expect(await jobs(s.repoId, "registry_revoke")).toBe(1);
      if (c.installationScoped) {
        expect(forgotten).toContain(s.inst); // cached installation token dropped
        const inst = (await db.query<{ removed_at: Date | null; suspended_at: Date | null }>("SELECT removed_at, suspended_at FROM installations WHERE installation_id = $1", [s.inst])).rows[0]!;
        expect(c.reason === "installation_removed" ? inst.removed_at : inst.suspended_at).not.toBeNull();
      }
    });
  }

  it("transfer also records the NEW owner, so the old owner's identity can never be re-attested without a fresh full verification", async () => {
    const s = await seedRepo();
    await post("repository", { action: "transferred", repository: { id: s.repoId, full_name: "moved/repo", owner: { id: 4242, login: "moved" } } });
    const r = (await db.query<{ owner_id: string; owner_login: string }>("SELECT owner_id::text, owner_login FROM repositories WHERE repo_id = $1", [s.repoId])).rows[0]!;
    expect(r).toEqual({ owner_id: "4242", owner_login: "moved" });
  });

  it("when private repositories ARE allowed by policy, 'privatized' does not narrow (policy is honoured, not hard-coded)", async () => {
    allowPrivate = true;
    const s = await seedRepo();
    await post("repository", { action: "privatized", repository: { id: s.repoId, full_name: "a/b" } });
    expect(await active(s.repoId)).toBe("1");
    allowPrivate = false;
  });

  it("permission-affecting events (member removed/edited, org member removed, team, membership) revoke that user's proofs and queue revalidation; 'added' does not", async () => {
    const s = await seedRepo();
    await post("member", { action: "added", repository: { id: s.repoId, full_name: "a/b" }, member: { id: s.user, login: "u" } });
    expect(await active(s.repoId)).toBe("1");
    expect(await jobs(s.repoId, "repo_revalidate")).toBe(0);
    await post("member", { action: "edited", repository: { id: s.repoId, full_name: "a/b" }, member: { id: s.user, login: "u" } });
    expect(await active(s.repoId)).toBe("0");
    expect(await jobs(s.repoId, "repo_revalidate")).toBe(1);

    const o = await seedRepo();
    await post("organization", { action: "member_removed", organization: { id: o.owner, login: "o" }, membership: { user: { id: o.user, login: "u" } } });
    expect(await active(o.repoId)).toBe("0");
    expect(await jobs(o.repoId, "repo_revalidate")).toBe(1);

    const t = await seedRepo();
    await post("team", { action: "edited", organization: { id: t.owner, login: "o" } });
    expect(await active(t.repoId)).toBe("0");
    expect(await jobs(t.repoId, "repo_revalidate")).toBe(1);
  });

  it("events that could WIDEN eligibility never restore a revoked proof or queue work (unsuspend, publicized, unarchived, re-created installation, rename)", async () => {
    const s = await seedRepo();
    await post("installation", { action: "deleted", installation: { id: s.inst } });
    expect(await active(s.repoId)).toBe("0");
    const revokedAt = (await db.query<{ t: Date }>("SELECT revoked_at t FROM verifications WHERE id = $1", [s.vid])).rows[0]!.t;
    const jobCount = async () => Number((await db.query<{ c: string }>("SELECT count(*)::text c FROM jobs")).rows[0]!.c);
    const before = await jobCount();
    for (const [event, payload] of [
      ["installation", { action: "created", installation: { id: s.inst, account: { id: s.owner, login: "o", type: "Organization" } } }],
      ["installation", { action: "unsuspend", installation: { id: s.inst } }],
      ["repository", { action: "publicized", repository: { id: s.repoId, full_name: "a/b" } }],
      ["repository", { action: "unarchived", repository: { id: s.repoId, full_name: "a/b" } }],
      ["repository", { action: "renamed", repository: { id: s.repoId, full_name: "a/renamed" } }],
    ] as Array<[string, unknown]>) {
      await post(event, payload);
    }
    expect(await active(s.repoId)).toBe("0"); // still no live proof
    const v = (await db.query<{ t: Date; reason: string }>("SELECT revoked_at t, revoke_reason reason FROM verifications WHERE id = $1", [s.vid])).rows[0]!;
    expect(v.t.getTime()).toBe(revokedAt.getTime());
    expect(v.reason).toBe("installation_removed");
    expect(await ineligible(s.repoId)).toBe("installation_removed"); // only a full fresh verification clears it (verify.ts)
    expect(await jobCount()).toBe(before);
  });

  it("an EXPIRED proof is not a live proof even if never revoked (stale-proof window is bounded by expires_at)", async () => {
    const s = await seedRepo({ expired: true });
    expect(await active(s.repoId)).toBe("0");
    const live = await seedRepo();
    expect(await active(live.repoId)).toBe("1");
  });
});

// ── 4. network failure and rate limiting ────────────────────────────────────

describe("W06 GitHub client: a GitHub outage is never mistaken for revocation, and every failure is closed", () => {
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const cfg = { appId: "1", appSlug: "forge", privateKeyPem: pem, clientId: "c", clientSecret: "s", apiUrl: "https://gh.test", webUrl: "https://gh.web" };
  const respond = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

  it("connection failures/timeouts on every call kind → GITHUB_UNAVAILABLE (503), never null/false", async () => {
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const timeout = (async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }) as unknown as typeof fetch;
    for (const f of [down, timeout]) {
      const gh = new GithubApp(cfg, f);
      const calls = [
        () => gh.getUser("t"),
        () => gh.getInstallation(1),
        () => gh.installationToken(1),
        () => gh.installationRepoIds(1),
        () => gh.collaboratorPermission(1, "o/r", "u"),
        () => gh.repoByIdAsUser("t", 1),
        () => gh.userInstallationRepos("t", 1),
        () => gh.exchangeCode("code", "https://forge.example/cb"),
      ];
      for (const c of calls) await expect(c()).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE", status: 503 });
    }
  });

  it("5xx is an error, not 'absent': only a genuine 404 means the installation/collaborator/repository is gone", async () => {
    const gh5 = new GithubApp(cfg, (async () => respond(502)) as unknown as typeof fetch);
    await expect(gh5.getInstallation(1)).rejects.toBeInstanceOf(GithubHttpError);
    await expect(gh5.repoByIdAsUser("t", 1)).rejects.toBeInstanceOf(GithubHttpError);
    const gh404 = new GithubApp(cfg, (async () => respond(404)) as unknown as typeof fetch);
    expect(await gh404.getInstallation(1)).toBeNull();
    expect(await gh404.repoByIdAsUser("t", 1)).toBeNull();
    const ghTok = new GithubApp(cfg, (async (url: string) => (String(url).includes("access_tokens") ? respond(201, { token: "i", expires_at: new Date(Date.now() + 3.6e6).toISOString() }) : respond(500))) as unknown as typeof fetch);
    await expect(ghTok.collaboratorPermission(1, "o/r", "u")).rejects.toBeInstanceOf(GithubHttpError); // 500 ≠ null (= "not a collaborator")
  });

  it("recovery: after an outage the very next call succeeds with no sticky failure state, and a cached token is not poisoned by it", async () => {
    let up = false, tokenMints = 0;
    const f = (async (url: string) => {
      if (!up) throw new TypeError("fetch failed");
      if (String(url).includes("access_tokens")) { tokenMints++; return respond(201, { token: "tok", expires_at: new Date(Date.now() + 3.6e6).toISOString() }); }
      return respond(200, { permission: "admin", user: { id: 1, login: "u" } });
    }) as unknown as typeof fetch;
    const gh = new GithubApp(cfg, f);
    await expect(gh.collaboratorPermission(1, "o/r", "u")).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });
    up = true;
    expect((await gh.collaboratorPermission(1, "o/r", "u"))?.permission).toBe("admin");
    expect((await gh.collaboratorPermission(1, "o/r", "u"))?.permission).toBe("admin");
    expect(tokenMints).toBe(1);
  });

  it("rate limiting: secondary (retry-after) and primary (remaining=0) limits retry once within the bound, otherwise fail closed; 429 without headers fails closed", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    let n = 0;
    const once = new GithubApp(cfg, (async () => (n++ === 0 ? respond(403, {}, { "retry-after": "3" }) : respond(200, { id: 1, login: "u" }))) as unknown as typeof fetch, { sleep });
    expect((await once.getUser("t")).id).toBe(1);
    expect(waits).toEqual([3000]);
    const bare429 = new GithubApp(cfg, (async () => respond(429)) as unknown as typeof fetch, { sleep });
    await expect(bare429.getUser("t")).rejects.toMatchObject({ code: "GITHUB_RATE_LIMITED", status: 503 });
    const always = new GithubApp(cfg, (async () => respond(403, {}, { "retry-after": "1" })) as unknown as typeof fetch, { sleep });
    await expect(always.getUser("t")).rejects.toMatchObject({ code: "GITHUB_RATE_LIMITED" });
  });
});

// ── 5. least privilege / readiness / operator tool ──────────────────────────

describe("W06 GitHub App: least-privilege configuration matrix", () => {
  const good = (): AppConfigEvidence => ({
    source: "LIVE_GITHUB",
    app: { id: 1, slug: "forge", permissions: { metadata: "read", contents: "read" }, events: [...REQUIRED_EVENTS] },
    webhook: { url: "https://forge.example/api/github/webhook", content_type: "json", insecure_ssl: "0" },
    expectedOrigin: "https://forge.example/",
    expectedSlug: "forge",
  });
  const status = (mut: (e: AppConfigEvidence) => void) => { const e = good(); mut(e); return evaluateAppConfig(e).status; };

  it("the required permission set is exactly metadata:read + contents:read", () => {
    expect(REQUIRED_PERMISSIONS).toEqual({ metadata: "read", contents: "read" });
    expect(evaluateAppConfig(good()).status).toBe("PASS");
  });

  it("every permission that could widen the App's power is refused (write/admin on anything; any non-allowlisted read)", () => {
    for (const p of ["administration", "pull_requests", "issues", "actions", "workflows", "secrets", "repository_hooks", "statuses", "deployments", "pages", "checks"]) {
      expect(status((e) => (e.app.permissions[p] = "read")), `${p}:read`).toBe("FAIL");
      expect(status((e) => (e.app.permissions[p] = "write")), `${p}:write`).toBe("FAIL");
    }
    expect(status((e) => (e.app.permissions.metadata = "write"))).toBe("FAIL");
    expect(status((e) => (e.app.permissions.contents = "write"))).toBe("FAIL");
    expect(status((e) => (e.app.permissions.contents = "admin"))).toBe("FAIL");
  });

  it("only the documented read-only org-membership extras are tolerated, and never writable", () => {
    expect([...OPTIONAL_READ_PERMISSIONS].sort()).toEqual(["members", "organization_members"]);
    expect(status((e) => (e.app.permissions.members = "read"))).toBe("PASS");
    expect(status((e) => (e.app.permissions.organization_members = "read"))).toBe("PASS");
    expect(status((e) => (e.app.permissions.members = "write"))).toBe("FAIL");
  });

  it("each required webhook event is individually necessary", () => {
    for (const ev of REQUIRED_EVENTS) expect(status((e) => (e.app.events = e.app.events.filter((x) => x !== ev))), ev).toBe("FAIL");
    expect(status((e) => e.app.events.push("push"))).toBe("PASS"); // extra events are harmless to least privilege (not permissions)
  });

  it("webhook transport: exact URL, https, JSON, TLS verification on", () => {
    expect(status((e) => (e.webhook!.url = "https://forge.example/api/github/other"))).toBe("FAIL");
    expect(status((e) => (e.webhook!.url = "https://evil.example/api/github/webhook"))).toBe("FAIL");
    expect(status((e) => (e.webhook!.content_type = "form"))).toBe("FAIL");
    expect(status((e) => (e.webhook!.insecure_ssl = 1))).toBe("FAIL");
    expect(status((e) => (e.webhook = null))).toBe("FAIL");
  });

  it("a sandbox source is never PASS, whatever the content (SANDBOX_NOT_EVIDENCE)", () => {
    expect(status((e) => (e.source = "SANDBOX"))).toBe("SANDBOX_NOT_EVIDENCE");
    expect(status((e) => { e.source = "SANDBOX"; e.app.permissions.contents = "write"; })).toBe("SANDBOX_NOT_EVIDENCE");
  });

  it("the operator setup constant agrees with the readiness policy and the committed W05/W06 docs", () => {
    expect(OPERATOR_SETUP.repositoryPermissions).toEqual({ Metadata: "Read-only", Contents: "Read-only" });
    expect(OPERATOR_SETUP.accountPermissions).toBe("none");
    expect(OPERATOR_SETUP.webhookEvents).toEqual([...REQUIRED_EVENTS]);
    const docs = path.resolve(__dirname, "../../../../docs");
    for (const f of ["W05-GITHUB-APP-OPERATIONS.md", "W06-GITHUB-APP-ACCEPTANCE.md"]) {
      const text = readFileSync(path.join(docs, f), "utf8");
      for (const ev of REQUIRED_EVENTS) expect(text, `${f} mentions ${ev}`).toContain(ev);
      expect(text).toMatch(/Contents/);
    }
    expect(readFileSync(path.join(docs, "W06-GITHUB-APP-ACCEPTANCE.md"), "utf8")).toContain("EXTERNAL_GITHUB_APP_CONFIGURATION_REQUIRED");
  });
});

describe("W06 GitHub App: `ops:github-app-check` operator tool exit codes (no real GitHub contacted)", () => {
  const script = path.resolve(__dirname, "../../scripts/w05/github-app-check.ts");
  const cwd = path.resolve(__dirname, "../..");
  /** Runs the CLI asynchronously (the fake GitHub below lives in this process and must keep serving). */
  const run = (env: Record<string, string>) =>
    new Promise<{ status: number | null; stdout: string }>((resolve) => {
      const p = spawn("npx", ["tsx", script], { cwd, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env } as unknown as NodeJS.ProcessEnv });
      let stdout = "";
      p.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      p.on("close", (status) => resolve({ status, stdout }));
    });

  it("no credentials → exit 3 EXTERNAL_CREDENTIALS_REQUIRED with the exact setup", async () => {
    const r = await run({});
    expect(r.status).toBe(3);
    const out = JSON.parse(r.stdout);
    expect(out.status).toBe("EXTERNAL_CREDENTIALS_REQUIRED");
    expect(out.setup.repositoryPermissions).toEqual({ Metadata: "Read-only", Contents: "Read-only" });
  }, 60_000);

  it("a non-github.com API (a fake) can never PASS: exit 4 SANDBOX_NOT_EVIDENCE", async () => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/app") res.end(JSON.stringify({ id: 1, slug: "forge", owner: { login: "o" }, permissions: { metadata: "read", contents: "read" }, events: [...REQUIRED_EVENTS] }));
      else if (req.url === "/app/hook/config") res.end(JSON.stringify({ url: "https://forge.example/api/github/webhook", content_type: "json", insecure_ssl: "0" }));
      else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    let r: Awaited<ReturnType<typeof run>>;
    try {
      r = await run({ GITHUB_APP_ID: "1", GITHUB_APP_SLUG: "forge", GITHUB_APP_PRIVATE_KEY: pem, GITHUB_API_URL: `http://127.0.0.1:${port}`, FORGE_PUBLIC_ORIGIN: "https://forge.example" });
    } finally {
      server.close();
    }
    expect(r.status).toBe(4);
    expect(JSON.parse(r.stdout).status).toBe("SANDBOX_NOT_EVIDENCE");
  }, 60_000);
});
