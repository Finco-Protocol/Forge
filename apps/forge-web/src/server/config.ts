import { z } from "zod";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getAddress, type Address } from "viem";
import robinhoodManifest from "../../config/networks/robinhood-4663.json";

/** Hard production gates carried forward from W02 (see docs/W03-SECURITY-RUNBOOK.md). */
export const PRODUCTION_BLOCKED = true;
export const FORGE_FEE_POLICY_AUTHORITY_UNPROVEN = true;
export const ROBINHOOD_CHAIN_ID = 4663;
export const ORIGINAL_PONS_FACTORY = getAddress(robinhoodManifest.originalPonsFactory.address);

const bool = (def: boolean) =>
  z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => (v === undefined ? def : v === "true" || v === "1"));

const hexKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 32-byte hex private key");

const EnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  FORGE_NETWORK: z.enum(["sandbox", "robinhood"]).default("sandbox"),
  FORGE_PUBLIC_ORIGIN: z.string().url().default("http://localhost:3000"),
  FORGE_RPC_URL: z.string().url().default("http://127.0.0.1:8545"),
  FORGE_CHAIN_ID: z.coerce.number().int().positive().default(31337),
  FORGE_DEPLOYMENT_FILE: z.string().optional(),
  FORGE_CONFIRMATIONS: z.coerce.number().int().min(0).max(1000).default(0),
  FORGE_INDEXER_REORG_WINDOW: z.coerce.number().int().min(1).max(10_000).default(64),
  FORGE_INDEXER_BATCH_BLOCKS: z.coerce.number().int().min(1).max(100_000).default(2_000),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be >= 32 chars"),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(8 * 60 * 60),
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_SLUG: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(16),
  GITHUB_API_URL: z.string().url().default("https://api.github.com"),
  GITHUB_WEB_URL: z.string().url().default("https://github.com"),
  FORGE_ALLOW_PRIVATE_REPOS: bool(false),
  FORGE_ALLOW_FORK_REPOS: bool(false),
  FORGE_VERIFICATION_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  FORGE_BINDING_HORIZON_SECONDS: z.coerce.number().int().positive().max(30 * 24 * 3600).default(7 * 24 * 3600),
  FORGE_ATTESTATION_TTL_SECONDS: z.coerce.number().int().positive().max(3 * 24 * 3600).default(30 * 60),
  FORGE_CONSENT_TTL_SECONDS: z.coerce.number().int().positive().max(24 * 3600).default(20 * 60),
  FORGE_SIGNER_PROVIDER: z.enum(["local-test"]).default("local-test"),
  FORGE_AUTHORITY_PRIVATE_KEY: hexKey.optional(),
  FORGE_EVIDENCE_PRIVATE_KEY: hexKey.optional(),
  FORGE_RELAYER_PRIVATE_KEY: hexKey.optional(),
  FORGE_SIGNING_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(30),
  DATABASE_URL: z.string().optional(),
  FORGE_PGLITE_DIR: z.string().optional(),
  FORGE_EMBEDDED_WORKER: bool(false),
  FINCO_BURN_ENABLED: bool(false),
});

export interface ForgeAddresses {
  factory: Address;
  registry: Address;
  authorizer: Address;
  launchDeployer: Address;
  locker: Address;
  memeHook: Address;
  deployBlock: bigint;
}

export type ForgeConfig = ReturnType<typeof buildConfig>;

function readDeployment(file: string): ForgeAddresses {
  const raw = JSON.parse(readFileSync(path.resolve(file), "utf8")) as Record<string, string>;
  const need = (k: string): Address => {
    const v = raw[k];
    if (!v) throw new Error(`deployment file missing ${k}`);
    return getAddress(v);
  };
  return {
    factory: need("factory"),
    registry: need("registry"),
    authorizer: need("authorizer"),
    launchDeployer: need("launchDeployer"),
    locker: need("locker"),
    memeHook: need("memeHook"),
    deployBlock: BigInt(raw.deployBlock ?? "0"),
  };
}

export function buildConfig(env: Record<string, string | undefined>) {
  const e = EnvSchema.parse(env);
  if (e.FINCO_BURN_ENABLED) throw new Error("FINCO_BURN_ENABLED=true is out of scope for W03 and refused.");
  if (e.FORGE_NETWORK === "robinhood") {
    if (e.FORGE_CHAIN_ID !== ROBINHOOD_CHAIN_ID) throw new Error("FORGE_NETWORK=robinhood requires FORGE_CHAIN_ID=4663");
    if (PRODUCTION_BLOCKED && robinhoodManifest.forge.factory === null) {
      // Read-only browsing of the manifest is fine; no Forge stack exists to drive.
      throw new Error("PRODUCTION_BLOCKED: no Forge factory is deployed on Robinhood Chain (4663). See docs/W03-SECURITY-RUNBOOK.md.");
    }
  }
  if (e.FORGE_NETWORK === "sandbox" && e.FORGE_CHAIN_ID === ROBINHOOD_CHAIN_ID) {
    throw new Error("Sandbox mode may not target chain 4663.");
  }
  const deploymentFile = e.FORGE_DEPLOYMENT_FILE ?? path.resolve(process.cwd(), ".sandbox", "deployment.json");
  const addresses = readDeployment(deploymentFile);
  if (addresses.factory === ORIGINAL_PONS_FACTORY) throw new Error("The original PONS factory is not a Forge factory.");
  const origin = new URL(e.FORGE_PUBLIC_ORIGIN);
  return {
    network: e.FORGE_NETWORK,
    production: e.NODE_ENV === "production",
    origin: origin.origin,
    host: origin.host,
    secureCookies: origin.protocol === "https:",
    rpcUrl: e.FORGE_RPC_URL,
    chainId: e.FORGE_CHAIN_ID,
    confirmations: e.FORGE_CONFIRMATIONS,
    reorgWindow: e.FORGE_INDEXER_REORG_WINDOW,
    indexerBatchBlocks: BigInt(e.FORGE_INDEXER_BATCH_BLOCKS),
    addresses,
    sessionSecret: e.SESSION_SECRET,
    sessionTtlSeconds: e.SESSION_TTL_SECONDS,
    github: {
      appId: e.GITHUB_APP_ID,
      appSlug: e.GITHUB_APP_SLUG,
      privateKeyPem: e.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
      clientId: e.GITHUB_CLIENT_ID,
      clientSecret: e.GITHUB_CLIENT_SECRET,
      webhookSecret: e.GITHUB_WEBHOOK_SECRET,
      apiUrl: e.GITHUB_API_URL.replace(/\/$/, ""),
      webUrl: e.GITHUB_WEB_URL.replace(/\/$/, ""),
    },
    policy: {
      allowPrivateRepos: e.FORGE_ALLOW_PRIVATE_REPOS,
      allowForkRepos: e.FORGE_ALLOW_FORK_REPOS,
      verificationTtlSeconds: e.FORGE_VERIFICATION_TTL_SECONDS,
      bindingHorizonSeconds: e.FORGE_BINDING_HORIZON_SECONDS,
      attestationTtlSeconds: e.FORGE_ATTESTATION_TTL_SECONDS,
      consentTtlSeconds: e.FORGE_CONSENT_TTL_SECONDS,
      signingRateLimitPerHour: e.FORGE_SIGNING_RATE_LIMIT_PER_HOUR,
    },
    signer: {
      provider: e.FORGE_SIGNER_PROVIDER,
      authorityKey: e.FORGE_AUTHORITY_PRIVATE_KEY,
      evidenceKey: e.FORGE_EVIDENCE_PRIVATE_KEY,
      relayerKey: e.FORGE_RELAYER_PRIVATE_KEY,
    },
    db: { url: e.DATABASE_URL, pgliteDir: e.FORGE_PGLITE_DIR },
    embeddedWorker: e.FORGE_EMBEDDED_WORKER,
  };
}
