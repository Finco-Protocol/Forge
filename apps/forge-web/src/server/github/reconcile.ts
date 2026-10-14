/**
 * Reconciliation: webhook delivery is not assumed infallible. For every
 * repository with an ACTIVE on-chain binding, re-derive eligibility from
 * live GitHub state (installation token only — this check can only narrow)
 * and revoke on chain when it no longer holds. GitHub outages never revoke
 * (they throw and the job retries); they only ever block NEW attestations.
 */
import { getAddress } from "viem";
import type { AppContext } from "../context";
import { readRegistryState } from "../chain/forge";
import { invalidateRepository } from "./webhooks";
import { audit } from "../audit";

export type ReconcileOutcome = { repoId: string; outcome: "ok" | "no_active_binding" | `revoked:${string}` };

export async function reconcileRepository(ctx: AppContext, repoIdRaw: string | number): Promise<ReconcileOutcome> {
  const repoId = String(repoIdRaw);
  const state = await readRegistryState(ctx.client, ctx.cfg.addresses, BigInt(repoId));
  if (!state.binding.exists || state.binding.revokedAt !== 0n) return { repoId, outcome: "no_active_binding" };
  const creator = getAddress(state.binding.creator);
  const invalidate = async (reason: string): Promise<ReconcileOutcome> => {
    await ctx.db.tx((q) => invalidateRepository(q, repoId, reason, `reconcile:${Date.now()}`));
    await audit(ctx.db, "forge:reconcile", "reconcile_invalidated", `repo:${repoId}`, { reason, creator });
    return { repoId, outcome: `revoked:${reason}` };
  };
  const { rows } = await ctx.db.query<{ github_user_id: string; github_login: string; installation_id: string; owner_id: string; full_name: string }>(
    `SELECT v.github_user_id::text, v.github_login, v.installation_id::text, v.owner_id::text, v.full_name
       FROM registry_ops o JOIN verifications v ON v.id = o.verification_id
      WHERE o.repo_id = $1 AND o.creator = $2 AND o.revoke = false AND o.status = 'confirmed'
      ORDER BY o.block_number DESC LIMIT 1`,
    [repoId, creator],
  );
  const v = rows[0];
  if (!v) return invalidate("binding_without_service_evidence");
  const instId = Number(v.installation_id);
  const wallet = await ctx.db.query("SELECT 1 FROM wallet_bindings WHERE github_user_id = $1 AND wallet_address = $2 AND revoked_at IS NULL", [v.github_user_id, creator]);
  if (!wallet.rows.length) return invalidate("wallet_binding_revoked");
  const inst = await ctx.github.getInstallation(instId);
  if (!inst) return invalidate("installation_removed");
  if (inst.suspended_at) return invalidate("installation_suspended");
  const covered = await ctx.github.installationRepoIds(instId);
  const repo = covered.get(Number(repoId));
  if (!repo) return invalidate("installation_repository_removed");
  if (String(repo.owner.id) !== v.owner_id) return invalidate("transferred");
  if (repo.archived) return invalidate("archived");
  if (repo.private && !ctx.cfg.policy.allowPrivateRepos) return invalidate("privatized");
  if (repo.fork && !ctx.cfg.policy.allowForkRepos) return invalidate("fork");
  const collab = await ctx.github.collaboratorPermission(instId, repo.full_name, v.github_login);
  if (!collab || String(collab.user.id) !== v.github_user_id || collab.permission !== "admin") return invalidate("admin_lost");
  if (repo.full_name !== v.full_name) {
    await ctx.db.query("UPDATE repositories SET full_name = $2, updated_at = now() WHERE repo_id = $1", [repoId, repo.full_name]);
    await ctx.db.query("INSERT INTO repository_names(repo_id, full_name, source) VALUES ($1,$2,'reconcile') ON CONFLICT DO NOTHING", [repoId, repo.full_name]);
  }
  return { repoId, outcome: "ok" };
}

export async function reconcileAll(ctx: AppContext): Promise<ReconcileOutcome[]> {
  const { rows } = await ctx.db.query<{ repo_id: string }>("SELECT DISTINCT repo_id::text FROM registry_ops WHERE revoke = false AND status = 'confirmed'");
  const out: ReconcileOutcome[] = [];
  for (const r of rows) out.push(await reconcileRepository(ctx, r.repo_id));
  return out;
}
