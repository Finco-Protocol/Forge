import { z } from "zod";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getAddress, type Address } from "viem";
import robinhoodManifest from "../../config/networks/robinhood-4663.json";

/** Hard production gates carried forward from W02 (see docs/W03-SECURITY-RUNBOOK.md). */
export const PRODUCTION_BLOCKED = true;
export const FORGE_FEE_POLICY_AUTHORITY_UNPROVEN = true;
/** W04 Correction A: no production revenue-attestor custody exists; W05 must approve one. */
export const REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED = false;
/**
 * W05: global custody gate. While false, NO signer (local-test or KMS/HSM)
 * signs for chain 4663 or any chain other than the local dev chains, and the
 * signing-policy guard refuses any EIP-712 domain outside them. Turning this
 * on is a separate, reviewed change (docs/W05-SIGNER-CUSTODY.md §9).
 */
export const PRODUCTION_SIGNING_ENABLED = false;
export const ROBINHOOD_CHAIN_ID = 4663;
export const ORIGINAL_PONS_FACTORY = getAddress(robinhoodManifest.originalPonsFactory.address);

const bool = (def: boolean) =>
  z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => (v === undefined ? def : v === "true" || v === "1"));

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte hex address")
  .transform((v) => getAddress(v));

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
  // W05: "kms" requires an injected KMS backend (no cloud SDK is bundled) and
  // is refused outside local dev chains while PRODUCTION_SIGNING_ENABLED=false.
  FORGE_SIGNER_PROVIDER: z.enum(["local-test", "kms"]).default("local-test"),
  FORGE_AUTHORITY_PRIVATE_KEY: hexKey.optional(),
  FORGE_EVIDENCE_PRIVATE_KEY: hexKey.optional(),
  FORGE_RELAYER_PRIVATE_KEY: hexKey.optional(),
  // W04 Correction A: signs cumulative eligible-revenue ceilings for the
  // revenue splitter. Optional: unset = attestation disabled, so pulls fail
  // closed (no verified headroom). local-test custody only (chain 31337/1337).
  FORGE_REVENUE_ATTESTOR_PRIVATE_KEY: hexKey.optional(),
  FORGE_SIGNING_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(30),
  // W05 signer registry (docs/W05-SIGNER-CUSTODY.md). Key ids are references, never key material.
  FORGE_AUTHORITY_KMS_KEY_ID: z.string().min(1).optional(),
  FORGE_EVIDENCE_KMS_KEY_ID: z.string().min(1).optional(),
  FORGE_REVENUE_ATTESTOR_KMS_KEY_ID: z.string().min(1).optional(),
  FORGE_AUTHORITY_EXPECTED_ADDRESS: address.optional(),
  FORGE_EVIDENCE_EXPECTED_ADDRESS: address.optional(),
  FORGE_REVENUE_ATTESTOR_EXPECTED_ADDRESS: address.optional(),
  FORGE_RELAYER_EXPECTED_ADDRESS: address.optional(),
  /** Comma-separated roles (authority,evidence,revenue) or "all": refused before any custody call. */
  FORGE_SIGNER_KILL_SWITCH: z
    .string()
    .optional()
    .transform((v, c) => {
      const roles = (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      for (const r of roles) if (!["authority", "evidence", "revenue", "all"].includes(r)) c.addIssue({ code: "custom", message: `unknown signer role ${r}` });
      return new Set(roles);
    }),
  FORGE_SIGNER_ROLE_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(1_000),
  DATABASE_URL: z.string().optional(),
  FORGE_PGLITE_DIR: z.string().optional(),
  FORGE_EMBEDDED_WORKER: bool(false),
  FORGE_REVOCATION_SLO_SECONDS: z.coerce.number().int().positive().default(300),
  FORGE_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  FINCO_BURN_ENABLED: bool(false),
});

export interface ForgeAddresses {
  factory: Address;
  registry: Address;
  authorizer: Address;
  launchDeployer: Address;
  locker: Address;
  memeHook: Address;
  /** W04: canonical escrow and buyback vault (from the factory wiring). */
  feeEscrow: Address | null;
  buybackVault: Address | null;
  /** W04: ForgeProtocolRevenueSplitter, or null when not deployed (70/20/10 then unavailable). */
  revenueSplitter: Address | null;
  graduationExecutor: Address | null;
  deployBlock: bigint;
}

export type ForgeConfig = ReturnType<typeof buildConfig>;

function readDeployment(file: string): ForgeAddresses {
  const raw = JSON.parse(readFileSync(path.resolve(file), "utf8")) as Record<string, string>;
  const opt = (k: string): Address | null => (raw[k] ? getAddress(raw[k]!) : null);
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
    feeEscrow: opt("feeEscrow"),
    buybackVault: opt("buybackVault"),
    revenueSplitter: opt("revenueSplitter"),
    graduationExecutor: opt("graduationExecutor"),
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
  if (e.FORGE_SIGNER_PROVIDER === "kms") {
    // Fail early; the KMS signer itself refuses again at construction and on every sign.
    if (!PRODUCTION_SIGNING_ENABLED && e.FORGE_CHAIN_ID !== 31337 && e.FORGE_CHAIN_ID !== 1337) {
      throw new Error(`PRODUCTION_BLOCKED: FORGE_SIGNER_PROVIDER=kms is refused for chain ${e.FORGE_CHAIN_ID} (PRODUCTION_SIGNING_ENABLED=false).`);
    }
    if (e.FORGE_AUTHORITY_PRIVATE_KEY || e.FORGE_EVIDENCE_PRIVATE_KEY || e.FORGE_REVENUE_ATTESTOR_PRIVATE_KEY) {
      throw new Error("FORGE_SIGNER_PROVIDER=kms: in-process authority/evidence/revenue private keys must not be configured.");
    }
    const pairs: [string, string | undefined, string | undefined, boolean][] = [
      ["AUTHORITY", e.FORGE_AUTHORITY_KMS_KEY_ID, e.FORGE_AUTHORITY_EXPECTED_ADDRESS, true],
      ["EVIDENCE", e.FORGE_EVIDENCE_KMS_KEY_ID, e.FORGE_EVIDENCE_EXPECTED_ADDRESS, true],
      ["REVENUE_ATTESTOR", e.FORGE_REVENUE_ATTESTOR_KMS_KEY_ID, e.FORGE_REVENUE_ATTESTOR_EXPECTED_ADDRESS, false],
    ];
    for (const [name, keyId, expected, required] of pairs) {
      if (required && !keyId) throw new Error(`FORGE_SIGNER_PROVIDER=kms requires FORGE_${name}_KMS_KEY_ID.`);
      if (keyId && !expected) throw new Error(`FORGE_${name}_KMS_KEY_ID requires FORGE_${name}_EXPECTED_ADDRESS (the address is verified against custody at startup).`);
    }
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
      revenueAttestorKey: e.FORGE_REVENUE_ATTESTOR_PRIVATE_KEY,
      kmsKeyIds: { authority: e.FORGE_AUTHORITY_KMS_KEY_ID, evidence: e.FORGE_EVIDENCE_KMS_KEY_ID, revenue: e.FORGE_REVENUE_ATTESTOR_KMS_KEY_ID },
      expected: {
        authority: e.FORGE_AUTHORITY_EXPECTED_ADDRESS,
        evidence: e.FORGE_EVIDENCE_EXPECTED_ADDRESS,
        revenue: e.FORGE_REVENUE_ATTESTOR_EXPECTED_ADDRESS,
        relayer: e.FORGE_RELAYER_EXPECTED_ADDRESS,
      },
      killSwitch: e.FORGE_SIGNER_KILL_SWITCH,
      roleRateLimitPerHour: e.FORGE_SIGNER_ROLE_RATE_LIMIT_PER_HOUR,
    },
    db: { url: e.DATABASE_URL, pgliteDir: e.FORGE_PGLITE_DIR },
    embeddedWorker: e.FORGE_EMBEDDED_WORKER,
    revocationSloSeconds: e.FORGE_REVOCATION_SLO_SECONDS,
    trustedProxyHops: e.FORGE_TRUSTED_PROXY_HOPS,
  };
}
