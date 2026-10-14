/**
 * Repository eligibility engine. A repository is eligible for a Forge launch
 * by a signed-in GitHub user only if ALL of the following hold, each read
 * live from GitHub at verification time:
 *
 *   U1  the user's own token sees the repository by canonical numeric id
 *       and reports permissions.admin = true for that user;
 *   U2  the user's own token lists the repository under the App
 *       installation (user ↔ installation ↔ repository relationship);
 *   I1  the installation token lists the repository (the App installation
 *       actually covers it) and the installation account owns it;
 *   I2  the installation's collaborator-permission view of THAT user
 *       (matched by numeric user id) is "admin";
 *   I3  identity agrees across sources (id, full name, owner id);
 *   P   policy: not archived/disabled, private only if allowed, forks only
 *       if allowed.
 *
 * An installation token by itself is NEVER treated as proof that the user
 * administers the repository: I1 only proves App coverage.
 */
import type { AppContext } from "../context";
import { canonicalJson, sha256Hex, uuid } from "../crypto";
import { ForgeError } from "../errors";
import { audit } from "../audit";
import type { GhRepo } from "./client";
import type { Queryable } from "../db";

export interface VerificationRecord {
  id: string;
  repoId: number;
  fullName: string;
  ownerLogin: string;
  defaultBranch: string;
  commitSha: string;
  private: boolean;
  installationId: number;
  githubUserId: number;
  githubLogin: string;
  walletAddress: string | null;
  verifiedAt: string;
  expiresAt: string;
  evidenceHash: string;
}

export interface VerifyInput {
  userToken: string;
  githubUserId: number;
  githubLogin: string;
  repoId: number;
  installationId: number;
  wallet: { bindingId: number; address: string } | null;
}

const permissionOf = (r: GhRepo) =>
  r.permissions?.admin ? "admin" : r.permissions?.maintain ? "maintain" : r.permissions?.push ? "write" : r.permissions?.pull ? "read" : "none";

export async function upsertRepository(q: Queryable, r: GhRepo, installationId: number | null, source: string) {
  await q.query(
    `INSERT INTO repositories(repo_id, full_name, owner_id, owner_login, installation_id, private, fork, archived, default_branch)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (repo_id) DO UPDATE SET full_name = EXCLUDED.full_name, owner_id = EXCLUDED.owner_id, owner_login = EXCLUDED.owner_login,
       installation_id = COALESCE(EXCLUDED.installation_id, repositories.installation_id), private = EXCLUDED.private, fork = EXCLUDED.fork,
       archived = EXCLUDED.archived, default_branch = EXCLUDED.default_branch, updated_at = now()`,
    [r.id, r.full_name, r.owner.id, r.owner.login, installationId, r.private, r.fork, r.archived, r.default_branch],
  );
  await q.query("INSERT INTO repository_names(repo_id, full_name, source) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [r.id, r.full_name, source]);
}

export async function verifyRepository(ctx: AppContext, input: VerifyInput): Promise<VerificationRecord> {
  const { github, cfg, db } = ctx;
  const reasons: string[] = [];
  const fail = async (code: string, message: string, extra: Record<string, unknown> = {}): Promise<never> => {
    await audit(db, `github:${input.githubUserId}`, "verification_failed", `repo:${input.repoId}`, { code, ...extra });
    throw new ForgeError(code, message, 403, { repoId: input.repoId, ...extra });
  };

  const inst = await db.query<{ removed_at: Date | null; suspended_at: Date | null }>(
    "SELECT removed_at, suspended_at FROM installations WHERE installation_id = $1",
    [input.installationId],
  );
  if (inst.rows[0]?.removed_at) return fail("APP_NOT_INSTALLED", "The Forge GitHub App installation was removed.");
  if (inst.rows[0]?.suspended_at) return fail("APP_SUSPENDED", "The Forge GitHub App installation is suspended.");
  const liveInstallation = await github.getInstallation(input.installationId);
  if (!liveInstallation) return fail("APP_NOT_INSTALLED", "The Forge GitHub App is not installed for this account.");
  if (liveInstallation.suspended_at) return fail("APP_SUSPENDED", "The Forge GitHub App installation is suspended.");

  // U1 — the user's own authority over the repository, by canonical id.
  const userRepo = await github.repoByIdAsUser(input.userToken, input.repoId);
  if (!userRepo || userRepo.id !== input.repoId) return fail("REPO_NOT_ACCESSIBLE", "Your GitHub account cannot access this repository.");
  const userPermission = permissionOf(userRepo);
  if (userPermission !== "admin") return fail("NOT_ADMIN", "You must be an administrator of the repository.", { userPermission });

  // U2 — the user reaches it through THIS installation.
  const userInstRepos = await github.userInstallationRepos(input.userToken, input.installationId);
  if (!userInstRepos.some((r) => r.id === input.repoId)) {
    return fail("APP_NOT_INSTALLED", "The Forge GitHub App installation does not cover this repository.");
  }

  // I1 — the installation itself covers the repository, on the owner's account.
  const instRepos = await github.installationRepoIds(input.installationId);
  const instRepo = instRepos.get(input.repoId);
  if (!instRepo) return fail("APP_NOT_INSTALLED", "The Forge GitHub App installation does not cover this repository.");
  if (liveInstallation.account.id !== instRepo.owner.id) {
    return fail("INSTALLATION_OWNER_MISMATCH", "The App installation is not on the repository owner's account.");
  }

  // I3 — identity agrees across sources.
  if (instRepo.full_name !== userRepo.full_name || instRepo.owner.id !== userRepo.owner.id) {
    return fail("IDENTITY_MISMATCH", "GitHub returned inconsistent repository identity; retry later.");
  }

  // I2 — independent admin confirmation for this exact user id.
  const collab = await github.collaboratorPermission(input.installationId, instRepo.full_name, input.githubLogin);
  if (!collab || collab.user.id !== input.githubUserId) return fail("NOT_ADMIN", "GitHub did not confirm your administrator role.");
  const installationPermission = collab.permission;
  if (installationPermission !== "admin") return fail("NOT_ADMIN", "You must be an administrator of the repository.", { installationPermission });

  // P — eligibility policy.
  if (instRepo.archived) reasons.push("ARCHIVED");
  if (instRepo.disabled) reasons.push("DISABLED");
  if (instRepo.private && !cfg.policy.allowPrivateRepos) reasons.push("PRIVATE_NOT_ALLOWED");
  if (instRepo.fork && !cfg.policy.allowForkRepos) reasons.push("FORK_NOT_ALLOWED");
  if (reasons.length) return fail("REPO_INELIGIBLE", `Repository is not eligible: ${reasons.join(", ")}.`, { reasons });

  const commitSha = await github.branchHead(input.installationId, instRepo.full_name, instRepo.default_branch);
  const verifiedAt = new Date();
  const expiresAt = new Date(verifiedAt.getTime() + cfg.policy.verificationTtlSeconds * 1000);
  const evidence = {
    schema: "forge.github-verification.v1",
    githubApiUrl: cfg.github.apiUrl,
    appId: cfg.github.appId,
    user: { id: input.githubUserId, login: input.githubLogin },
    repository: {
      id: instRepo.id,
      fullName: instRepo.full_name,
      owner: { id: instRepo.owner.id, login: instRepo.owner.login, type: instRepo.owner.type },
      private: instRepo.private,
      fork: instRepo.fork,
      archived: instRepo.archived,
      defaultBranch: instRepo.default_branch,
      htmlUrl: instRepo.html_url,
      commitSha,
    },
    installation: { id: liveInstallation.id, accountId: liveInstallation.account.id, accountLogin: liveInstallation.account.login },
    checks: {
      U1_userTokenPermission: userPermission,
      U2_userSeesRepoViaInstallation: true,
      I1_installationCoversRepo: true,
      I2_collaboratorPermission: installationPermission,
      I3_identityConsistent: true,
    },
    policy: { allowPrivateRepos: cfg.policy.allowPrivateRepos, allowForkRepos: cfg.policy.allowForkRepos },
    wallet: input.wallet ? input.wallet.address : null,
    verifiedAt: verifiedAt.toISOString(),
  };
  const evidenceHash = sha256Hex(canonicalJson(evidence));
  const id = uuid();

  await db.tx(async (q) => {
    await q.query(
      `INSERT INTO installations(installation_id, account_id, account_login, account_type, suspended_at, removed_at)
       VALUES ($1,$2,$3,$4,NULL,NULL)
       ON CONFLICT (installation_id) DO UPDATE SET account_id = EXCLUDED.account_id, account_login = EXCLUDED.account_login, updated_at = now()`,
      [liveInstallation.id, liveInstallation.account.id, liveInstallation.account.login, liveInstallation.account.type],
    );
    await upsertRepository(q, instRepo, input.installationId, "verification");
    // A full fresh verification on the CURRENT owner supersedes webhook-marked ineligibility.
    await q.query("UPDATE repositories SET ineligible_reason = NULL WHERE repo_id = $1 AND owner_id = $2", [instRepo.id, instRepo.owner.id]);
    await q.query(
      `INSERT INTO verifications(id, repo_id, github_user_id, github_login, installation_id, wallet_binding_id, wallet_address, full_name,
         owner_login, owner_id, default_branch, commit_sha, private, user_permission, installation_permission, evidence, evidence_hash, verified_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        id,
        instRepo.id,
        input.githubUserId,
        input.githubLogin,
        input.installationId,
        input.wallet?.bindingId ?? null,
        input.wallet?.address ?? null,
        instRepo.full_name,
        instRepo.owner.login,
        instRepo.owner.id,
        instRepo.default_branch,
        commitSha,
        instRepo.private,
        userPermission,
        installationPermission,
        JSON.stringify(evidence),
        evidenceHash,
        verifiedAt,
        expiresAt,
      ],
    );
  });
  await audit(db, `github:${input.githubUserId}`, "verification_passed", `repo:${instRepo.id}`, { verificationId: id, evidenceHash, commitSha });

  return {
    id,
    repoId: instRepo.id,
    fullName: instRepo.full_name,
    ownerLogin: instRepo.owner.login,
    defaultBranch: instRepo.default_branch,
    commitSha,
    private: instRepo.private,
    installationId: input.installationId,
    githubUserId: input.githubUserId,
    githubLogin: input.githubLogin,
    walletAddress: input.wallet?.address ?? null,
    verifiedAt: verifiedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    evidenceHash,
  };
}

export interface DiscoveredRepo {
  repoId: number;
  fullName: string;
  installationId: number;
  private: boolean;
  fork: boolean;
  archived: boolean;
  admin: boolean;
  htmlUrl: string;
  policyBlockers: string[];
}

/** Repositories the signed-in user can reach through the Forge App (user token only; a hint, not proof). */
export async function discoverRepositories(ctx: AppContext, userToken: string): Promise<{ installations: Array<{ id: number; account: string }>; repositories: DiscoveredRepo[] }> {
  const installations = await ctx.github.userInstallations(userToken);
  const repositories: DiscoveredRepo[] = [];
  for (const inst of installations) {
    await ctx.db.query(
      `INSERT INTO installations(installation_id, account_id, account_login, account_type, suspended_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (installation_id) DO UPDATE SET account_login = EXCLUDED.account_login, suspended_at = EXCLUDED.suspended_at, updated_at = now()`,
      [inst.id, inst.account.id, inst.account.login, inst.account.type, inst.suspended_at],
    );
    for (const r of await ctx.github.userInstallationRepos(userToken, inst.id)) {
      const policyBlockers: string[] = [];
      if (r.archived) policyBlockers.push("ARCHIVED");
      if (r.private && !ctx.cfg.policy.allowPrivateRepos) policyBlockers.push("PRIVATE_NOT_ALLOWED");
      if (r.fork && !ctx.cfg.policy.allowForkRepos) policyBlockers.push("FORK_NOT_ALLOWED");
      repositories.push({
        repoId: r.id,
        fullName: r.full_name,
        installationId: inst.id,
        private: r.private,
        fork: r.fork,
        archived: r.archived,
        admin: r.permissions?.admin === true,
        htmlUrl: r.html_url,
        policyBlockers,
      });
    }
  }
  return { installations: installations.map((i) => ({ id: i.id, account: i.account.login })), repositories };
}
