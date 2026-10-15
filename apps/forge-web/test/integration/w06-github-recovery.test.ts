/**
 * W06 GitHub App — network-failure recovery on the real stack (Anvil + real
 * contracts + PGlite; GitHub is the in-process fake: SANDBOX_NOT_EVIDENCE).
 *
 * Property: a GitHub outage / 5xx / rate limit NEVER revokes a binding and
 * NEVER lets a new verification through (fail closed in both directions);
 * once GitHub is reachable again reconciliation converges, including a genuine
 * revocation (admin lost) that happened during the outage.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forgeBindingRegistryAbi } from "@/shared/abis.generated";
import { createAppContext, type AppContext } from "@/server/context";
import { runJobs, runWorkerOnce } from "@/server/worker";
import { reconcileRepository } from "@/server/github/reconcile";
import { verifyRepository } from "@/server/github/verify";
import { startSandbox, type Sandbox } from "../helpers/sandbox";
import { freshScenario, signedLaunch } from "../helpers/scenario";

let sb: Sandbox;
let flaky: AppContext;
type Mode = "up" | "down" | "http500" | "collab500" | "rate429";
let mode: Mode = "up";

beforeAll(async () => {
  sb = await startSandbox();
  const real = fetch;
  const failing: typeof fetch = async (input, init) => {
    const url = String(input);
    if (mode === "down") throw new TypeError("fetch failed (simulated outage)");
    if (mode === "http500") return new Response("{}", { status: 500 });
    if (mode === "rate429") return new Response("{}", { status: 429, headers: { "retry-after": "600" } });
    if (mode === "collab500" && url.includes("/collaborators/")) return new Response("{}", { status: 500 });
    return real(input, init);
  };
  flaky = await createAppContext(sb.env, { db: sb.ctx.db, fetchImpl: failing });
}, 180_000);
afterAll(async () => sb?.stop());

const isActive = (repoId: number, creator: `0x${string}`) =>
  sb.ctx.client.readContract({ address: sb.deployment.registry, abi: forgeBindingRegistryAbi, functionName: "isActive", args: [BigInt(repoId), creator] });
const revokeJobs = async (repoId: number) =>
  (await sb.ctx.db.query("SELECT 1 FROM jobs WHERE kind = 'registry_revoke' AND payload->>'repoId' = $1", [String(repoId)])).rows.length;
const ineligibleReason = async (repoId: number) =>
  (await sb.ctx.db.query<{ r: string | null }>("SELECT ineligible_reason r FROM repositories WHERE repo_id = $1", [repoId])).rows[0]?.r ?? null;

describe("W06 GitHub: outage, 5xx and rate limit never revoke and never verify; recovery converges", () => {
  it("reconciliation under every failure mode throws (job retries), leaves the binding ACTIVE and queues no revocation", async () => {
    mode = "up";
    const s = await freshScenario(sb);
    await signedLaunch(sb, s.browser, s.key, s.draft);
    expect(await isActive(s.repoId, s.address)).toBe(true);

    for (const m of ["down", "http500", "collab500", "rate429"] as const) {
      mode = m;
      await expect(reconcileRepository(flaky, s.repoId), m).rejects.toMatchObject({ status: expect.any(Number) });
      expect(await isActive(s.repoId, s.address), `${m}: binding survives`).toBe(true);
      expect(await revokeJobs(s.repoId), `${m}: no revocation queued`).toBe(0);
      expect(await ineligibleReason(s.repoId), `${m}: repo not marked ineligible`).toBeNull();
    }
    // Worker pass with reconcile during an outage must not revoke either (errors are per-repo, never "assume revoked").
    mode = "down";
    await runWorkerOnce(flaky, { reconcile: true }).catch(() => undefined);
    await runJobs(flaky);
    expect(await isActive(s.repoId, s.address)).toBe(true);

    mode = "up";
    expect((await reconcileRepository(flaky, s.repoId)).outcome).toBe("ok");
  });

  it("a new verification during an outage / 5xx / rate limit fails closed: no verification row is written", async () => {
    mode = "up";
    const s = await freshScenario(sb, { verify: false });
    const token = sb.github.issueUserToken(s.user.id);
    const wallet = (await sb.ctx.db.query<{ id: string }>("SELECT id::text FROM wallet_bindings WHERE github_user_id = $1 AND revoked_at IS NULL", [s.user.id])).rows[0]!;
    const input = { userToken: token, githubUserId: s.user.id, githubLogin: s.user.login, repoId: s.repoId, installationId: s.installationId, wallet: { bindingId: Number(wallet.id), address: s.address } };
    const count = async () => Number((await sb.ctx.db.query<{ c: string }>("SELECT count(*)::text c FROM verifications WHERE repo_id = $1", [s.repoId])).rows[0]!.c);
    for (const m of ["down", "http500", "rate429"] as const) {
      mode = m;
      await expect(verifyRepository(flaky, input), m).rejects.toMatchObject({ status: expect.any(Number) });
      expect(await count(), m).toBe(0);
    }
    mode = "up";
    const v = await verifyRepository(flaky, input);
    expect(v.repoId).toBe(s.repoId);
    expect(await count()).toBe(1);
  });

  it("an admin loss that happened DURING an outage is found and revoked on chain once GitHub is reachable again", async () => {
    mode = "up";
    const s = await freshScenario(sb);
    await signedLaunch(sb, s.browser, s.key, s.draft);
    sb.github.setPermission(s.repoId, s.user.id, "write"); // happens while we cannot see GitHub
    mode = "down";
    await expect(reconcileRepository(flaky, s.repoId)).rejects.toBeTruthy();
    expect(await isActive(s.repoId, s.address)).toBe(true); // still bound: the outage did not decide anything
    mode = "up";
    const r = await reconcileRepository(flaky, s.repoId);
    expect(r.outcome).toBe("revoked:admin_lost");
    await runJobs(flaky);
    expect(await isActive(s.repoId, s.address)).toBe(false);
    expect(await revokeJobs(s.repoId)).toBeGreaterThanOrEqual(1);
  });
});
