/**
 * W03 positive acceptance path (1–15) over the REAL W02 contracts on a local
 * Anvil chain, the REAL API/session/CSRF stack, real Postgres semantics
 * (PGlite) and the fake GitHub boundary. No step is stubbed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress, parseEther, type Address, type Hex } from "viem";
import { forgeBindingRegistryAbi, ponsV2BondingCurveAbi, ponsV2LaunchFactoryAbi } from "@/shared/abis.generated";
import { runWorkerOnce } from "@/server/worker";
import { verifyLedger } from "@/server/proof/ledger";
import { startSandbox, TestBrowser, chainClients, ANVIL_KEYS, type Sandbox } from "../helpers/sandbox";
import { rpc } from "../helpers/anvil";
import { ALICE, INSTALLATION_ID, REPO_ID, seedGithub, launchThroughApi, DRAFT } from "../helpers/scenario";

const CREATOR_KEY = ANVIL_KEYS[5];
const BUYER_KEY = ANVIL_KEYS[6];

let sb: Sandbox;
let browser: TestBrowser;
let token: Address;
let curve: Address;

beforeAll(async () => {
  sb = await startSandbox();
  seedGithub(sb);
  browser = new TestBrowser(sb);
});
afterAll(async () => sb?.stop());

describe("creator → token acceptance path", () => {
  it("1. GitHub user authenticates through the App OAuth flow", async () => {
    await browser.signInGithub(ALICE.id);
    const me = await browser.get("/api/me");
    expect(me.json.github).toEqual({ id: ALICE.id, login: ALICE.login });
    expect(me.json.wallet).toBeNull();
  });

  it("2. repository is discovered through the installation", async () => {
    const r = await browser.get("/api/github/repositories");
    expect(r.status).toBe(200);
    const repo = r.json.repositories.find((x: { repoId: number }) => x.repoId === REPO_ID);
    expect(repo).toMatchObject({ fullName: "finco-labs/forge-demo", installationId: INSTALLATION_ID, admin: true, policyBlockers: [] });
  });

  it("3. admin permission is independently verified (user token AND installation view)", async () => {
    const v = await browser.post("/api/github/verify", { repoId: REPO_ID, installationId: INSTALLATION_ID });
    expect(v.status).toBe(200);
    expect(v.json.verification.commitSha).toBe(sb.github.repos.get(REPO_ID)!.headSha);
    const row = (await sb.ctx.db.query<{ user_permission: string; installation_permission: string; evidence: { checks: Record<string, unknown> } }>(
      "SELECT user_permission, installation_permission, evidence FROM verifications WHERE id = $1",
      [v.json.verification.id],
    )).rows[0]!;
    expect(row.user_permission).toBe("admin");
    expect(row.installation_permission).toBe("admin");
    expect(row.evidence.checks).toMatchObject({ U2_userSeesRepoViaInstallation: true, I1_installationCoversRepo: true });
    // Both GitHub credential types were exercised.
    expect(sb.github.requests).toEqual(expect.arrayContaining([`GET /repositories/${REPO_ID}`, "GET /installation/repositories", `GET /repos/finco-labs/forge-demo/collaborators/${ALICE.login}/permission`]));
  });

  it("4–5. wallet connects and the GitHub/wallet binding is established via SIWE", async () => {
    const r = await browser.bindWallet(CREATOR_KEY);
    expect(r.status).toBe(200);
    const me = await browser.get("/api/me");
    expect(me.json.wallet.address).toBe(chainClients(sb.anvil.url, CREATOR_KEY).account.address);
  });

  let launch: Awaited<ReturnType<typeof launchThroughApi>>;
  it("6–11. registry op confirmed, economics previewed, attestation issued, creator signs exact intent, token launches through the W02 factory", async () => {
    launch = await launchThroughApi(sb, browser, CREATOR_KEY);
    // 8. economics came from the factory itself.
    const econ = launch.draft.json.economics;
    const onchain = await sb.ctx.client.readContract({ address: sb.deployment.factory, abi: ponsV2LaunchFactoryAbi, functionName: "previewLaunchEconomics", args: [0n, "0x0000000000000000000000000000000000000000"] });
    expect(econ.digest).toBe(onchain);
    expect(econ.supply).toBe(sb.deployment.launchConfig.supply);
    expect(econ.graduationThreshold).toBe(sb.deployment.launchConfig.graduationThreshold);
    // 6. registry binding confirmed on chain for (repo, creator) under epoch 1.
    const creator = chainClients(sb.anvil.url, CREATOR_KEY).account.address;
    const active = await sb.ctx.client.readContract({ address: sb.deployment.registry, abi: forgeBindingRegistryAbi, functionName: "isActive", args: [BigInt(REPO_ID), creator] });
    expect(active).toBe(true);
    expect(launch.auth.json.eligibility.bindingEpoch).toBe("1");
    expect(launch.auth.json.eligibility.bindingTx).toMatch(/^0x[0-9a-f]{64}$/);
    // 10–11. simulation predicted the CREATE2 addresses; the tx is recorded.
    expect(launch.signed.json.simulation.token).toBe(launch.draft.json.predicted.token);
    expect(launch.submitted.status).toBe(200);
    expect(["included", "confirmed"]).toContain(launch.submitted.json.status);
    token = getAddress(launch.submitted.json.token);
    curve = getAddress(launch.submitted.json.curve);
    expect(token).toBe(launch.draft.json.predicted.token);
  });

  it("12. launch event is indexed and the intent becomes confirmed only after indexing", async () => {
    const pass = await runWorkerOnce(sb.ctx);
    expect(pass.indexed).toBeGreaterThan(0);
    expect(pass.receipts).toContain(token);
    const intent = await browser.get(`/api/launch/intents/${launch.auth.json.intentId}`);
    expect(intent.json.status).toBe("confirmed");
  });

  it("13. token appears on Explore with its verified repository", async () => {
    const r = await browser.get("/api/tokens");
    const t = r.json.tokens.find((x: { token: string }) => x.token === token);
    expect(t).toMatchObject({ name: DRAFT.name, symbol: DRAFT.symbol, repo_id: String(REPO_ID), full_name: "finco-labs/forge-demo", phase: "launched" });
    expect(t.last_verified_at).toBeTruthy();
  });

  it("14. project page shows canonical evidence and the ledger verifies", async () => {
    const r = await browser.get(`/api/tokens/${token}`);
    expect(r.status).toBe(200);
    const receipt = r.json.receipts[0].receipt;
    expect(receipt.githubRepoId).toBe(String(REPO_ID));
    expect(receipt.launchTx).toBe(launch.txHash.toLowerCase());
    expect(receipt.service.commitSha).toBe(sb.github.repos.get(REPO_ID)!.headSha);
    expect(receipt.service.repoFullNameAtVerification).toBe("finco-labs/forge-demo");
    expect(receipt.onchain.launchAuthorizedLog.txHash).toBe(launch.txHash.toLowerCase());
    expect(receipt.onchain.bindingOp.epoch).toBe("1");
    expect(receipt.classification.disclaimer).toMatch(/NOT a code audit/);
    expect(await verifyLedger(sb.ctx)).toEqual({ ok: true, entries: 1 });
  });

  it("15. lifecycle follows actual contract events: curve trades → graduation → V4 pool + lock", async () => {
    const buyer = chainClients(sb.anvil.url, BUYER_KEY);
    // Clear the launch-window snipe tax (15 s) like any patient buyer.
    await rpc(sb.anvil.url, "evm_increaseTime", [20]);
    await rpc(sb.anvil.url, "evm_mine");
    let h = await buyer.wallet.writeContract({ address: curve, abi: ponsV2BondingCurveAbi, functionName: "buy", args: [parseEther("5"), 0n, buyer.account.address], value: parseEther("5") });
    await buyer.pub.waitForTransactionReceipt({ hash: h });
    await runWorkerOnce(sb.ctx);
    let t = (await browser.get(`/api/tokens/${token}`)).json.token;
    expect(t.phase).toBe("bonding_curve_active");
    expect(t.buy_count).toBe(1);
    expect(t.reconcile_error).toBeNull();
    expect(BigInt(t.quote_volume)).toBe(parseEther("5"));

    // Threshold-crossing buy auto-graduates (curve swept into the factory).
    h = await buyer.wallet.writeContract({ address: curve, abi: ponsV2BondingCurveAbi, functionName: "buy", args: [parseEther("100"), 0n, buyer.account.address], value: parseEther("100") });
    await buyer.pub.waitForTransactionReceipt({ hash: h });
    await runWorkerOnce(sb.ctx);
    t = (await browser.get(`/api/tokens/${token}`)).json.token;
    expect(t.phase).toBe("graduation_initiated");
    expect(t.onchain_phase).toBe(1);
    expect(t.reconcile_error).toBeNull();

    // Anyone may seed the graduated pool; the position is locked.
    h = await buyer.wallet.writeContract({ address: sb.deployment.factory, abi: ponsV2LaunchFactoryAbi, functionName: "createGraduatedPool", args: [token] });
    await buyer.pub.waitForTransactionReceipt({ hash: h });
    await runWorkerOnce(sb.ctx);
    t = (await browser.get(`/api/tokens/${token}`)).json.token;
    expect(t.phase).toBe("graduated");
    expect(t.onchain_phase).toBe(2);
    expect(t.liquidity_locked).toBe(true);
    expect(t.reconcile_error).toBeNull();
  });

  it("ledger stays valid and append-only", async () => {
    await expect(sb.ctx.db.query("UPDATE evidence_receipts SET kind = 'x'")).rejects.toThrow(/append-only/);
    expect((await verifyLedger(sb.ctx)).ok).toBe(true);
  });
});

export type { Hex };
