/**
 * GitHub App webhooks: HMAC-SHA256 verified (constant time) BEFORE parsing,
 * idempotent and replay-resistant by delivery GUID (persisted permanently).
 *
 * W07 delivery lifecycle: a VERIFIED delivery is durably RECEIVED in its own
 * committed transaction (before any trust is placed in the payload), then
 * PROCESSED in a second transaction that carries all side effects. A
 * processing failure leaves the receipt behind (attempts, last error, next
 * retry) so monitoring can observe it and the worker can retry it with capped
 * backoff; after `cfg.worker.webhookMaxAttempts` failed attempts the delivery
 * is terminal `failed` (audited, still recoverable by a GitHub redelivery).
 * Effects only ever NARROW eligibility. On-chain revocations are queued as
 * jobs (the worker signs/relays them); reconciliation (reconcile.ts)
 * covers missed deliveries.
 */
import { createHmac } from "node:crypto";
import type { AppContext } from "../context";
import type { Queryable } from "../db";
import { safeEqual, sha256Hex } from "../crypto";
import { ForgeError } from "../errors";
import { audit } from "../audit";

export function signWebhookBody(secret: string, body: string) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** Bounded retry backoff for webhook processing failures (matches non-critical worker jobs). */
export function webhookRetryBackoffSeconds(attempts: number): number {
  return Math.min(3600, 2 ** attempts * 5);
}

/** Invalidates future launches for a repository: off-chain immediately, on-chain via a queued revocation. */
export async function invalidateRepository(q: Queryable, repoId: number | string, reason: string, source: string) {
  await q.query("UPDATE repositories SET ineligible_reason = $2, updated_at = now() WHERE repo_id = $1", [repoId, reason]);
  await q.query("UPDATE verifications SET revoked_at = now(), revoke_reason = $2 WHERE repo_id = $1 AND revoked_at IS NULL", [repoId, reason]);
  await q.query(
    "UPDATE launch_intents SET status = 'superseded', failure_reason = $2, updated_at = now() WHERE repo_id = $1 AND status IN ('awaiting_signature','signed')",
    [repoId, `eligibility_revoked:${reason}`],
  );
  await q.query("INSERT INTO jobs(kind, dedupe_key, payload) VALUES ('registry_revoke', $1, $2) ON CONFLICT (dedupe_key) DO NOTHING", [
    `revoke:${repoId}:${reason}:${source}`,
    JSON.stringify({ repoId: String(repoId), reason }),
  ]);
}

/** The only WHERE fragments this helper may splice into SQL (all constant; values are always bind parameters). */
type VerificationScope = "repo_id = $1 AND github_user_id = $2" | "github_user_id = $1 AND owner_id = $2" | "owner_id = $1";

async function revokeUserVerifications(q: Queryable, where: VerificationScope, params: unknown[], reason: string) {
  await q.query(`UPDATE verifications SET revoked_at = now(), revoke_reason = $${params.length + 1} WHERE revoked_at IS NULL AND ${where}`, [...params, reason]);
}

interface Repo {
  id: number;
  full_name: string;
  private?: boolean;
  owner?: { id: number; login: string };
}

type Payload = Record<string, unknown> & {
  action?: string;
  installation?: { id: number; account?: { id: number; login: string; type: string } };
  repository?: Repo & { archived?: boolean; default_branch?: string };
  repositories?: Repo[];
  repositories_removed?: Repo[];
  repositories_added?: Repo[];
  member?: { id: number; login: string };
  membership?: { user?: { id: number; login: string } };
  organization?: { id: number; login: string };
  changes?: { owner?: { from?: { user?: { id: number }; organization?: { id: number } } } };
};

export async function handleWebhook(ctx: AppContext, req: Request): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = await req.text();
  if (body.length > 5 * 1024 * 1024) throw new ForgeError("PAYLOAD_TOO_LARGE", "Payload too large.", 413);
  const sig = req.headers.get("x-hub-signature-256") ?? "";
  if (!safeEqual(sig, signWebhookBody(ctx.cfg.github.webhookSecret, body))) {
    await audit(ctx.db, "github:webhook", "webhook_signature_rejected", null, {});
    throw new ForgeError("BAD_SIGNATURE", "Webhook signature invalid.", 401);
  }
  const delivery = req.headers.get("x-github-delivery") ?? "";
  const event = req.headers.get("x-github-event") ?? "";
  if (!/^[0-9a-fA-F-]{8,64}$/.test(delivery) || !/^[a-z_]{1,64}$/.test(event)) throw new ForgeError("BAD_DELIVERY", "Missing delivery headers.", 400);
  // W07: the signature is valid, but the payload itself may be garbage — a
  // controlled 400 (audited, no state change, nothing queued), never a 5xx.
  let payload: Payload;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
    payload = parsed as Payload;
  } catch {
    await audit(ctx.db, "github:webhook", "webhook_invalid_payload", null, { delivery, event });
    throw new ForgeError("INVALID_PAYLOAD", "Webhook payload is not a valid JSON object.", 400);
  }

  // Phase 1 (own transaction): durably RECEIPT a verified delivery BEFORE any
  // trust is placed in it. The stored body is the retry source of truth.
  const ins = await ctx.db.tx((q) =>
    q.query("INSERT INTO webhook_deliveries(delivery_id, event, action, payload_sha256, body, signature_verified, status) VALUES ($1,$2,$3,$4,$5,true,'received') ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id", [
      delivery,
      event,
      payload.action ?? null,
      sha256Hex(body),
      body,
    ]),
  );
  if (!ins.rows.length) {
    // Duplicate delivery GUID. Three cases (W07 Correction A §2.3):
    //   processed            → idempotent no-op (no audit insert, no mutations);
    //   same authenticated payload, not yet processed → re-activation for a
    //     fresh bounded processing chance (genuine GitHub redelivery);
    //   DIFFERENT payload or event under the same GUID → refused: a delivery
    //     id permanently binds the payload it was authenticated with; it must
    //     never silently substitute a different event.
    const prior = await ctx.db.tx(async (q) => {
      const r = await q.query<{ status: string; payload_sha256: string; event: string }>(
        "SELECT status, payload_sha256, event FROM webhook_deliveries WHERE delivery_id = $1 FOR UPDATE",
        [delivery],
      );
      const p = r.rows[0];
      if (!p) return null;
      // The delivery-id/payload binding is checked BEFORE any status shortcut:
      // a repeated GUID with a different payload or event is refused even when
      // the original was already processed (the caller is told, not misled).
      if (p.payload_sha256 !== sha256Hex(body) || p.event !== event) return { kind: "mismatch" as const, status: p.status };
      if (p.status === "processed") return { kind: "duplicate" as const };
      await q.query(
        "UPDATE webhook_deliveries SET status = 'received', attempts = 0, last_error = NULL, next_retry_at = NULL, received_at = now(), processed_at = NULL, outcome = NULL WHERE delivery_id = $1 AND status <> 'processed'",
        [delivery],
      );
      return { kind: "reactivated" as const };
    });
    if (prior !== null && prior.kind === "duplicate") return { status: 200, body: { duplicate: true } };
    if (prior !== null && prior.kind === "mismatch") {
      await audit(ctx.db, "github:webhook", "webhook_payload_mismatch", `delivery:${delivery}`, { event, currentStatus: prior.status });
      throw new ForgeError("PAYLOAD_MISMATCH", "Delivery ID already bound to a different authenticated payload.", 409);
    }
    // null (row vanished; phase 2 surfaces it) or "reactivated" (failed delivery
    // re-activated for a fresh bounded processing chance) — fall through to phase 2.
  }

  // Phase 2 (own transaction): lock the delivery row, verify it is still
  // eligible, then run all side effects + the processed marker atomically. The
  // row lock serializes this path against the worker retry loop and a second
  // simultaneous request: whoever commits first wins, the loser sees
  // status='processed' and returns a duplicate no-op WITHOUT running apply()
  // again (no duplicate audit events, no repository mutations, no extra jobs).
  try {
    const outcome = await ctx.db.tx(async (q) => {
      const locked = await q.query<{ status: string; body: string; payload_sha256: string; event: string }>(
        "SELECT status, body, payload_sha256, event FROM webhook_deliveries WHERE delivery_id = $1 FOR UPDATE",
        [delivery],
      );
      const d = locked.rows[0];
      if (!d) throw new ForgeError("BAD_DELIVERY", "Delivery receipt vanished before processing.", 409);
      if (d.status === "processed") return { duplicate: true as const };
      if (d.status === "failed") throw new ForgeError("DELIVERY_TERMINAL", "Delivery already exhausted its retries; redeliver from GitHub.", 409);
      if (sha256Hex(d.body) !== d.payload_sha256) throw new ForgeError("PAYLOAD_MISMATCH", "Receipt does not match its committed payload hash.", 409);
      const o = await apply(ctx, q, event, payload, delivery);
      await q.query("UPDATE webhook_deliveries SET status = 'processed', processed_at = now(), outcome = $2, attempts = attempts + 1, last_error = NULL, next_retry_at = NULL WHERE delivery_id = $1", [delivery, o]);
      await audit(q, "github:webhook", `webhook_${event}`, payload.repository ? `repo:${payload.repository.id}` : null, { action: payload.action ?? null, delivery, outcome: o });
      return { duplicate: false as const, outcome: o };
    });
    if (outcome.duplicate) return { status: 200, body: { duplicate: true } };
    return { status: 200, body: { processed: true, outcome: outcome.outcome } };
  } catch (e) {
    // Phase 3 (own transaction): durably record the failed attempt. GitHub
    // still sees a 5xx (it retries too), and the worker retry loop takes over.
    // The guard `AND status <> 'processed'` makes the bookkeeping unable to
    // downgrade a delivery another processor successfully committed (W07
    // Correction A §2.2) — a lost race produces no false terminal alert.
    const msg = (e as Error).message.split("\n")[0]!;
    const max = ctx.cfg.worker.webhookMaxAttempts;
    const row = await ctx.db.tx(async (q) => {
      const r = await q.query<{ status: string; attempts: string }>(
        `UPDATE webhook_deliveries SET attempts = attempts + 1, last_error = $2, next_retry_at = now() + ($3 || ' seconds')::interval,
           status = CASE WHEN attempts + 1 >= $4 THEN 'failed' ELSE 'received' END
         WHERE delivery_id = $1 AND signature_verified AND status <> 'processed'
         RETURNING status, attempts::text`,
        [delivery, msg, String(webhookRetryBackoffSeconds(1)), max],
      );
      return r.rows[0];
    });
    if (row?.status === "failed") {
      await audit(ctx.db, "github:webhook", "ALERT:webhook_delivery_failed", `delivery:${delivery}`, { event, attempts: Number(row.attempts), error: msg });
    }
    throw e;
  }
}

/**
 * W07 worker step: re-process RECEIVED deliveries inside the worker. Two
 * cases are due: (a) failed first attempts whose backoff elapsed
 * (`attempts > 0`), and (b) receipts orphaned by a crash between the durable
 * phase-1 commit and phase-2 processing (`attempts = 0` older than the crash
 * window). The stored body is re-checked against its committed sha256 and may
 * only be processed when the receipt records a verified signature. Each
 * delivery is claimed and processed in ONE transaction (`FOR UPDATE SKIP
 * LOCKED` keeps concurrent workers from double-claiming); a failure records
 * the attempt and schedules the bounded retry without rolling the claim back.
 * Returns the number of deliveries handled (processed or retried).
 */
export async function retryDueWebhookDeliveries(ctx: AppContext, limit = 20): Promise<number> {
  let handled = 0;
  for (let i = 0; i < limit; i++) {
    const result = await ctx.db.tx(async (q) => {
      const claimed = await q.query<{ delivery_id: string; event: string; body: string; payload_sha256: string; attempts: string }>(
        `SELECT delivery_id, event, body, payload_sha256, attempts::text FROM webhook_deliveries
          WHERE status = 'received' AND signature_verified AND body IS NOT NULL
            AND ((attempts > 0 AND next_retry_at <= now()) OR (attempts = 0 AND received_at <= now() - interval '60 seconds'))
          ORDER BY received_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      const d = claimed.rows[0];
      if (!d) return { handled: false as const };
      // The attempt record must survive a FAILED apply without committing any
      // partial side effects: apply runs under a savepoint that is rolled back
      // on failure, so exactly the failure bookkeeping commits.
      await q.query("SAVEPOINT apply_delivery");
      try {
        if (sha256Hex(d.body) !== d.payload_sha256) throw new Error("stored payload does not match its committed sha256");
        const payload = JSON.parse(d.body) as Payload;
        const o = await apply(ctx, q, d.event, payload, d.delivery_id);
        await q.query("UPDATE webhook_deliveries SET status = 'processed', processed_at = now(), outcome = $2, attempts = attempts + 1, last_error = NULL, next_retry_at = NULL WHERE delivery_id = $1", [d.delivery_id, o]);
        await audit(q, "github:webhook", `webhook_${d.event}`, payload.repository ? `repo:${payload.repository.id}` : null, { action: payload.action ?? null, delivery: d.delivery_id, outcome: o, retry: true });
        await q.query("RELEASE SAVEPOINT apply_delivery");
        return { handled: true as const, failed: false as const, event: d.event, delivery: d.delivery_id, outcome: o };
      } catch (e) {
        await q.query("ROLLBACK TO SAVEPOINT apply_delivery");
        const msg = (e as Error).message.split("\n")[0]!;
        const max = ctx.cfg.worker.webhookMaxAttempts;
        const r = await q.query<{ status: string; attempts: string }>(
          `UPDATE webhook_deliveries SET attempts = attempts + 1, last_error = $2, next_retry_at = now() + ($3 || ' seconds')::interval,
             status = CASE WHEN attempts + 1 >= $4 THEN 'failed' ELSE 'received' END
           WHERE delivery_id = $1
           RETURNING status, attempts::text`,
          [d.delivery_id, msg, String(webhookRetryBackoffSeconds(Number(d.attempts) + 1)), max],
        );
        return { handled: true as const, failed: true as const, event: d.event, delivery: d.delivery_id, terminal: r.rows[0]?.status === "failed", attempts: Number(r.rows[0]?.attempts ?? 0), error: msg };
      }
    });
    if (!result.handled) break;
    handled++;
    if (!result.failed) {
      await audit(ctx.db, "forge:worker", "webhook_delivery_retried", `delivery:${result.delivery}`, { event: result.event, outcome: result.outcome });
    } else if (result.terminal) {
      await audit(ctx.db, "forge:worker", "ALERT:webhook_delivery_failed", `delivery:${result.delivery}`, { event: result.event, attempts: result.attempts, error: result.error });
    }
  }
  return handled;
}

async function apply(ctx: AppContext, q: Queryable, event: string, p: Payload, delivery: string): Promise<string> {
  const instId = p.installation?.id;
  switch (event) {
    case "installation": {
      if (!instId) return "ignored";
      if (p.action === "created" && p.installation?.account) {
        await q.query(
          `INSERT INTO installations(installation_id, account_id, account_login, account_type) VALUES ($1,$2,$3,$4)
           ON CONFLICT (installation_id) DO UPDATE SET removed_at = NULL, suspended_at = NULL, updated_at = now()`,
          [instId, p.installation.account.id, p.installation.account.login, p.installation.account.type],
        );
        return "installation_created";
      }
      if (p.action === "deleted" || p.action === "suspend") {
        await q.query(
          `UPDATE installations SET ${p.action === "deleted" ? "removed_at" : "suspended_at"} = now(), updated_at = now() WHERE installation_id = $1`,
          [instId],
        );
        ctx.github.forgetInstallation(instId);
        const repos = await q.query<{ repo_id: string }>("SELECT repo_id::text FROM repositories WHERE installation_id = $1", [instId]);
        for (const r of repos.rows) await invalidateRepository(q, r.repo_id, p.action === "deleted" ? "installation_removed" : "installation_suspended", delivery);
        for (const r of p.repositories ?? []) await invalidateRepository(q, r.id, p.action === "deleted" ? "installation_removed" : "installation_suspended", delivery);
        return `installation_${p.action}`;
      }
      if (p.action === "unsuspend") {
        await q.query("UPDATE installations SET suspended_at = NULL, updated_at = now() WHERE installation_id = $1", [instId]);
        return "installation_unsuspended (re-verification required)";
      }
      return "ignored";
    }
    case "installation_repositories": {
      for (const r of p.repositories_removed ?? []) await invalidateRepository(q, r.id, "installation_repository_removed", delivery);
      return `removed:${(p.repositories_removed ?? []).length}`;
    }
    case "repository": {
      const r = p.repository;
      if (!r) return "ignored";
      switch (p.action) {
        case "renamed":
          // Canonical identity is the numeric id: a rename never touches bindings.
          await q.query("UPDATE repositories SET full_name = $2, updated_at = now() WHERE repo_id = $1", [r.id, r.full_name]);
          await q.query("INSERT INTO repository_names(repo_id, full_name, source) VALUES ($1,$2,'webhook:renamed') ON CONFLICT DO NOTHING", [r.id, r.full_name]);
          return "renamed";
        case "transferred":
          await q.query("UPDATE repositories SET full_name = $2, owner_id = COALESCE($3, owner_id), owner_login = COALESCE($4, owner_login), updated_at = now() WHERE repo_id = $1", [
            r.id,
            r.full_name,
            r.owner?.id ?? null,
            r.owner?.login ?? null,
          ]);
          await invalidateRepository(q, r.id, "transferred", delivery);
          return "transferred";
        case "archived":
          await q.query("UPDATE repositories SET archived = true WHERE repo_id = $1", [r.id]);
          await invalidateRepository(q, r.id, "archived", delivery);
          return "archived";
        case "deleted":
          await invalidateRepository(q, r.id, "deleted", delivery);
          return "deleted";
        case "privatized":
          await q.query("UPDATE repositories SET private = true WHERE repo_id = $1", [r.id]);
          if (!ctx.cfg.policy.allowPrivateRepos) await invalidateRepository(q, r.id, "privatized", delivery);
          return "privatized";
        case "publicized":
        case "unarchived":
          await q.query(`UPDATE repositories SET ${p.action === "publicized" ? "private = false" : "archived = false"} WHERE repo_id = $1`, [r.id]);
          return `${p.action} (re-verification required)`;
        case "edited":
          if (r.default_branch) await q.query("UPDATE repositories SET default_branch = $2 WHERE repo_id = $1", [r.id, r.default_branch]);
          return "edited";
        default:
          return "ignored";
      }
    }
    case "member": {
      // Collaborator added/removed/permission edited on one repository.
      if (!p.repository || !p.member) return "ignored";
      if (p.action === "removed" || p.action === "edited") {
        await revokeUserVerifications(q, "repo_id = $1 AND github_user_id = $2", [p.repository.id, p.member.id], `permission_changed:${p.action}`);
        await queueRevalidation(q, p.repository.id, delivery);
      }
      return `member_${p.action}`;
    }
    case "organization": {
      if (p.action === "member_removed" && p.membership?.user && p.organization) {
        await revokeUserVerifications(q, "github_user_id = $1 AND owner_id = $2", [p.membership.user.id, p.organization.id], "org_membership_removed");
        const repos = await q.query<{ repo_id: string }>("SELECT repo_id::text FROM repositories WHERE owner_id = $1", [p.organization.id]);
        for (const r of repos.rows) await queueRevalidation(q, r.repo_id, delivery);
        return "org_member_removed";
      }
      return "ignored";
    }
    case "team":
    case "membership": {
      // Team permission changes can grant or remove repo admin indirectly: re-verify everything in the org.
      if (p.organization) {
        await revokeUserVerifications(q, "owner_id = $1", [p.organization.id], `${event}_changed`);
        const repos = await q.query<{ repo_id: string }>("SELECT repo_id::text FROM repositories WHERE owner_id = $1", [p.organization.id]);
        for (const r of repos.rows) await queueRevalidation(q, r.repo_id, delivery);
      }
      return `${event}_${p.action ?? "event"}`;
    }
    default:
      return "ignored";
  }
}

/** The on-chain binding is re-checked against live GitHub permissions by the worker. */
async function queueRevalidation(q: Queryable, repoId: number | string, delivery: string) {
  await q.query("INSERT INTO jobs(kind, dedupe_key, payload) VALUES ('repo_revalidate', $1, $2) ON CONFLICT (dedupe_key) DO NOTHING", [
    `revalidate:${repoId}:${delivery}`,
    JSON.stringify({ repoId: String(repoId) }),
  ]);
}
