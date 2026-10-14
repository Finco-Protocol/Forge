import { SANDBOX_ROLES, type SandboxDeployment } from "../../scripts/sandbox-lib";
import type { FakeGithub } from "./fake-github";

export const ORIGIN = "http://localhost:3000";

export function sandboxEnv(d: SandboxDeployment, gh: FakeGithub, rpcUrl: string, deploymentFile: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    FORGE_NETWORK: "sandbox",
    FORGE_PUBLIC_ORIGIN: ORIGIN,
    FORGE_RPC_URL: rpcUrl,
    FORGE_CHAIN_ID: String(d.chainId),
    FORGE_DEPLOYMENT_FILE: deploymentFile,
    FORGE_CONFIRMATIONS: "0",
    SESSION_SECRET: "test-session-secret-0123456789abcdef0123456789",
    GITHUB_APP_ID: gh.appId,
    GITHUB_APP_SLUG: gh.appSlug,
    GITHUB_APP_PRIVATE_KEY: gh.privateKeyPem,
    GITHUB_CLIENT_ID: gh.clientId,
    GITHUB_CLIENT_SECRET: gh.clientSecret,
    GITHUB_WEBHOOK_SECRET: "test-webhook-secret-0123456789",
    GITHUB_API_URL: gh.url,
    GITHUB_WEB_URL: gh.url,
    FORGE_AUTHORITY_PRIVATE_KEY: SANDBOX_ROLES.authority,
    FORGE_EVIDENCE_PRIVATE_KEY: SANDBOX_ROLES.evidence,
    FORGE_RELAYER_PRIVATE_KEY: SANDBOX_ROLES.relayer,
    FORGE_REVENUE_ATTESTOR_PRIVATE_KEY: SANDBOX_ROLES.revenueAttestor,
    ...extra,
  };
}

