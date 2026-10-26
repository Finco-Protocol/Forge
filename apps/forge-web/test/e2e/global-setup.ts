/**
 * E2E stack: Anvil (+ real W02 contracts) → fake GitHub boundary → the
 * production Next.js build (`next start`) with the embedded worker.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startAnvil } from "../helpers/anvil";
import { FakeGithub } from "../helpers/fake-github";
import { deploySandbox } from "../../scripts/sandbox-lib";
import { deployGenuineV4Local } from "../../scripts/w05/genuine-v4";
import { sandboxEnv } from "../helpers/env";
import { E2E_PORT } from "../../playwright.config";

export default async function globalSetup() {
  const anvil = await startAnvil();
  // W08-1: separate isolated browser acceptance; the default mock journey
  // remains untouched. Genuine contracts are deployed from pinned Uniswap
  // artifacts on local Anvil only, then checked against runtime bytecode.
  if (process.env.W08_E2E_GENUINE_V4 && !["true", "false"].includes(process.env.W08_E2E_GENUINE_V4)) {
    throw new Error("W08_E2E_GENUINE_V4 must be true or false");
  }
  const genuine = process.env.W08_E2E_GENUINE_V4 === "true" ? await deployGenuineV4Local(anvil.url) : null;
  const deployment = genuine
    ? await deploySandbox(anvil.url, {
        v4: { poolManager: genuine.poolManager, positionManager: genuine.positionManager, permit2: genuine.permit2 },
        hookVia: "create2-proxy",
      })
    : await deploySandbox(anvil.url);
  if (genuine && (genuine.chainId !== 31337 || genuine.mode !== "local-genuine" || deployment.v4Source !== "GENUINE_UNISWAP_V4" || !genuine.stateView || genuine.provenance.some((p) => !p.runtimeCheck.equalAfterMasking))) {
    throw new Error("W08_GENUINE_V4_DEPLOYMENT_UNVERIFIED");
  }
  const dir = path.resolve(process.cwd(), ".sandbox");
  mkdirSync(dir, { recursive: true });
  const deploymentFile = path.join(dir, "e2e-deployment.json");
  writeFileSync(deploymentFile, JSON.stringify(deployment, null, 2));
  if (genuine) {
    writeFileSync(path.join(dir, "e2e-genuine-v4-evidence.json"), JSON.stringify({
      kind: "W08_GENUINE_V4_BROWSER_BOOTSTRAP",
      evidenceClass: "LOCAL_ANVIL_FAKE_GITHUB_TEST_ONLY",
      chainId: genuine.chainId,
      v4Source: deployment.v4Source,
      poolManager: genuine.poolManager,
      positionManager: genuine.positionManager,
      permit2: genuine.permit2,
      stateView: genuine.stateView,
      hook: deployment.memeHook,
      provenance: genuine.provenance,
    }, null, 2));
  }

  const gh = new FakeGithub();
  const org = { id: 9001, login: "finco-labs", type: "Organization" };
  gh.addUser(1001, "alice-admin");
  gh.addUser(1002, "bob-writer");
  gh.addRepo({ id: 5001, name: "forge-demo", owner: org });
  gh.setPermission(5001, 1001, "admin");
  gh.setPermission(5001, 1002, "write");
  // W06 journey actors (simulated GitHub): carol administers the journey repos; dave only has write access.
  gh.addUser(1003, "carol-admin");
  gh.addUser(1004, "dave-writer");
  for (const [id, name] of [[5003, "journey-main"], [5004, "journey-revoke"], [5005, "journey-stale"]] as const) {
    gh.addRepo({ id, name, owner: org });
    gh.setPermission(id, 1003, "admin");
    gh.setPermission(id, 1004, "write");
  }
  gh.install(7001, org, [5001, 5003, 5004, 5005]);
  gh.nextLoginUser = 1001;
  await gh.start();

  const origin = `http://localhost:${E2E_PORT}`;
  const busy = await fetch(`${origin}/api/health`).then(() => true, () => false);
  if (busy) throw new Error(`Port ${E2E_PORT} is already in use (stale server?)`);
  const env = { ...process.env, ...sandboxEnv(deployment, gh, anvil.url, deploymentFile, { FORGE_PUBLIC_ORIGIN: origin, FORGE_EMBEDDED_WORKER: "true" }), PORT: String(E2E_PORT) } as NodeJS.ProcessEnv;
  // The repo-local next binary via node (NOT `npx`): Node >=18.20 on Windows refuses to spawn
  // .cmd shims without a shell, which made the whole E2E stack Windows-unrunnable.
  const here: string = typeof __dirname !== "undefined" ? __dirname : import.meta.dirname;
  const server = spawn(process.execPath, [path.resolve(here, "../../node_modules/next/dist/bin/next"), "start", "-p", String(E2E_PORT)], { env, stdio: "pipe", detached: true });
  let log = "";
  server.stdout.on("data", (d: Buffer) => (log += d.toString()));
  server.stderr.on("data", (d: Buffer) => (log += d.toString()));
  for (let i = 0; i < 300; i++) {
    try {
      const r = await fetch(`${origin}/api/health`);
      if (r.ok) break;
    } catch {
      /* booting */
    }
    if (i === 299) throw new Error(`next start did not come up:\n${log}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  process.env.E2E_ANVIL_URL = anvil.url;
  process.env.E2E_FAKE_GITHUB_URL = gh.url;
  process.env.E2E_FACTORY = deployment.factory;
  process.env.E2E_V4_SOURCE = deployment.v4Source ?? "W02_MINI_MOCKS";
  if (genuine) {
    process.env.E2E_V4_STATE_VIEW = genuine.stateView!;
    process.env.E2E_V4_POOL_MANAGER = genuine.poolManager;
    process.env.E2E_V4_POSITION_MANAGER = genuine.positionManager;
    process.env.E2E_V4_HOOK = deployment.memeHook;
  }
  return async () => {
    try {
      process.kill(-server.pid!, "SIGTERM");
    } catch {
      server.kill("SIGTERM");
    }
    await gh.stop();
    await anvil.stop();
    if (process.env.E2E_SERVER_LOG) console.log(log);
  };
}
