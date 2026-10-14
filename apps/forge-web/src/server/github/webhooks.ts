/**
 * GitHub App webhooks: HMAC-SHA256 verified (constant time) BEFORE parsing,
 * idempotent and replay-resistant by delivery GUID (persisted permanently,
 * processed in the same transaction as its effects — a failure rolls back
 * the delivery record so GitHub's redelivery is processed exactly once).
 *
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

async function revokeUserVerifications(q: Queryable, where: string, params: unknown[], reason: string) {
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
  const payload = JSON.parse(body) as Payload;

  return ctx.db.tx(async (q) => {
    const ins = await q.query(
      "INSERT INTO webhook_deliveries(delivery_id, event, action, payload_sha256) VALUES ($1,$2,$3,$4) ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id",
      [delivery, event, payload.action ?? null, sha256Hex(body)],
    );
    if (!ins.rows.length) return { status: 200, body: { duplicate: true } };
    const outcome = await apply(ctx, q, event, payload, delivery);
    await q.query("UPDATE webhook_deliveries SET processed_at = now(), outcome = $2 WHERE delivery_id = $1", [delivery, outcome]);
    await audit(q, "github:webhook", `webhook_${event}`, payload.repository ? `repo:${payload.repository.id}` : null, { action: payload.action ?? null, delivery, outcome });
    return { status: 200, body: { processed: true, outcome } };
  });
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
