/**
 * Local sandbox GitHub (the mocked external boundary) for `pnpm dev` and the
 * Playwright E2E. Seeds a demo org/repo/admin and writes the App credentials
 * into .sandbox/github.env for the web app to load. NEVER for production.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FakeGithub } from "../test/helpers/fake-github";

const port = Number(process.env.FAKE_GITHUB_PORT ?? 8787);
const gh = new FakeGithub();
const org = { id: 9001, login: "finco-labs", type: "Organization" };
gh.addUser(1001, "alice-admin");
gh.addUser(1002, "bob-writer");
gh.addRepo({ id: 5001, name: "forge-demo", owner: org });
gh.addRepo({ id: 5002, name: "private-tool", owner: org, private: true });
gh.setPermission(5001, 1001, "admin");
gh.setPermission(5002, 1001, "admin");
gh.setPermission(5001, 1002, "write");
gh.install(7001, org, [5001, 5002]);
gh.nextLoginUser = Number(process.env.FAKE_GITHUB_LOGIN_AS ?? 1001);
// FAKE_GITHUB_HOST=0.0.0.0 only inside the staging compose network (internal: true); FAKE_GITHUB_PUBLIC_URL is the URL services use to reach it.
await gh.start(port, process.env.FAKE_GITHUB_HOST ?? "127.0.0.1", process.env.FAKE_GITHUB_PUBLIC_URL);
// W07: the staging compose stack mounts the shared `sandbox` volume at /sandbox and its
// healthcheck tests /sandbox/github.env there; local runs keep the historical .sandbox dir.
const dir = path.resolve(process.env.FAKE_GITHUB_ENV_DIR ?? path.join(process.cwd(), ".sandbox"));
mkdirSync(dir, { recursive: true });
const env = {
  GITHUB_APP_ID: gh.appId,
  GITHUB_APP_SLUG: gh.appSlug,
  GITHUB_CLIENT_ID: gh.clientId,
  GITHUB_CLIENT_SECRET: gh.clientSecret,
  GITHUB_API_URL: gh.url,
  GITHUB_WEB_URL: gh.url,
  GITHUB_APP_PRIVATE_KEY: gh.privateKeyPem.replace(/\n/g, "\\n"),
};
writeFileSync(path.join(dir, "github.env"), Object.entries(env).map(([k, v]) => `${k}="${v}"`).join("\n") + "\n");
console.log(`[fake-github] listening on ${gh.url}; credentials in .sandbox/github.env (login-as user ${gh.nextLoginUser})`);
