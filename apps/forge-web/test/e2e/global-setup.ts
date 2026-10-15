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
import { sandboxEnv } from "../helpers/env";
import { E2E_PORT } from "../../playwright.config";

export default async function globalSetup() {
  const anvil = await startAnvil();
  const deployment = await deploySandbox(anvil.url);
  const dir = path.resolve(process.cwd(), ".sandbox");
  mkdirSync(dir, { recursive: true });
  const deploymentFile = path.join(dir, "e2e-deployment.json");
  writeFileSync(deploymentFile, JSON.stringify(deployment, null, 2));

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
  const server = spawn("npx", ["next", "start", "-p", String(E2E_PORT)], { env, stdio: "pipe", detached: true });
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
