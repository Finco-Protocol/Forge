/**
 * Operator tool: verifies a REGISTERED GitHub App against the W05 readiness
 * policy. Read-only: it calls GET /app and GET /app/hook/config with the
 * App JWT; it never registers or edits an App and never touches an
 * organization.
 *
 *   GITHUB_APP_ID=… GITHUB_APP_PRIVATE_KEY=… GITHUB_APP_SLUG=… \
 *   FORGE_PUBLIC_ORIGIN=https://forge.example tsx scripts/w05/github-app-check.ts [--out report.json]
 *
 * Results:
 *   EXTERNAL_CREDENTIALS_REQUIRED  no App credentials in the environment (exit 3)
 *   SANDBOX_NOT_EVIDENCE           GITHUB_API_URL is not https://api.github.com — a fake GitHub
 *                                  can never count as live acceptance (exit 4)
 *   PASS / FAIL                    live evaluation (exit 0 / 1)
 */
import { writeFileSync } from "node:fs";
import { GithubApp } from "../../src/server/github/client";
import { evaluateAppConfig, OPERATOR_SETUP } from "../../src/server/github/app-readiness";

async function main() {
  const env = process.env;
  const out = process.argv.indexOf("--out") > 0 ? process.argv[process.argv.indexOf("--out") + 1] : undefined;
  const finish = (report: object, code: number) => {
    if (out) writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
    process.exit(code);
  };
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY || !env.GITHUB_APP_SLUG) {
    finish({ status: "EXTERNAL_CREDENTIALS_REQUIRED", reason: "GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_SLUG are not set; register the App first (docs/W05-GITHUB-APP-OPERATIONS.md).", setup: OPERATOR_SETUP }, 3);
  }
  const apiUrl = (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const live = apiUrl === "https://api.github.com";
  const app = new GithubApp({
    appId: env.GITHUB_APP_ID!,
    appSlug: env.GITHUB_APP_SLUG!,
    privateKeyPem: env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, "\n"),
    clientId: env.GITHUB_CLIENT_ID ?? "",
    clientSecret: env.GITHUB_CLIENT_SECRET ?? "",
    apiUrl,
    webUrl: (env.GITHUB_WEB_URL ?? "https://github.com").replace(/\/$/, ""),
  });
  const meta = await app.getApp();
  const webhook = await app.appWebhookConfig().catch(() => null);
  const r = evaluateAppConfig({
    source: live ? "LIVE_GITHUB" : "SANDBOX",
    app: { id: meta.id, slug: meta.slug, permissions: meta.permissions, events: meta.events },
    webhook,
    expectedOrigin: env.FORGE_PUBLIC_ORIGIN ?? "",
    expectedSlug: env.GITHUB_APP_SLUG!,
  });
  finish({ ...r, app: { id: meta.id, slug: meta.slug, owner: meta.owner.login }, rateLimit: app.lastRateLimit }, r.status === "PASS" ? 0 : r.status === "SANDBOX_NOT_EVIDENCE" ? 4 : 1);
}
main().catch((e) => {
  console.error((e as Error).message);
  process.exit(2);
});
