/**
 * W06 staging guard. A staging stack (FORGE_STAGING=true) may NEVER hold real
 * money or talk to real production systems. `stagingViolations` is a pure
 * function over the process environment; `assertStagingEnv` throws on any
 * violation and `assertStagingChain` additionally probes the RPC for its
 * chain id. Both run before the database is opened (see context.ts), so a
 * refused configuration never touches state.
 *
 * This is an additional guard: it narrows what W05 already refuses (chain
 * 4663, kms outside dev chains, burn flag) and never relaxes any of it.
 */
import { privateKeyToAddress } from "viem/accounts";

export type StagingViolationCode =
  | "STAGING_MARKER_MISSING"
  | "STAGING_NETWORK"
  | "STAGING_CHAIN_ID"
  | "STAGING_RPC_HOST"
  | "STAGING_RPC_CHAIN_MISMATCH"
  | "STAGING_GITHUB_REAL"
  | "STAGING_SIGNER_PROVIDER"
  | "STAGING_KEY_NOT_TEST_ONLY"
  | "STAGING_FLAG"
  | "STAGING_DATABASE"
  | "STAGING_SECRET"
  | "STAGING_PUBLIC_ORIGIN";

export interface StagingViolation {
  code: StagingViolationCode;
  detail: string;
}

/** Anvil/Hardhat default dev accounts (public, test-only). The only keys a staging stack may hold. */
export const TEST_ONLY_ADDRESSES: ReadonlySet<string> = new Set(
  [
    "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
    "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
    "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
    "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
    "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f",
    "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
  ].map((a) => a.toLowerCase()),
);

export const STAGING_CHAIN_IDS: ReadonlySet<number> = new Set([31337, 1337]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
/** Hosts that are never acceptable for staging services, even when allow-listed by mistake. */
const FORBIDDEN_HOST = /(^|\.)(github\.com|githubusercontent\.com|robinhood\.com|arbitrum\.io|alchemy\.com|infura\.io|quicknode\.[a-z]+|ankr\.com|amazonaws\.com|rds\.[a-z0-9.-]+|googleapis\.com|azure\.com|supabase\.co|neon\.tech)$/i;
const SAMPLE_SECRET = /change-?me|replace-with|example|sample|password|test-session-secret/i;

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Comma-separated extra hostnames (compose service names such as `anvil`, `postgres`). Loopback is always allowed. */
function allowlist(env: Record<string, string | undefined>): Set<string> {
  return new Set([...LOOPBACK, ...(env.FORGE_STAGING_HOST_ALLOWLIST ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)]);
}

function hostOk(host: string | null, allow: Set<string>): boolean {
  return host !== null && allow.has(host) && !FORBIDDEN_HOST.test(host);
}

export function stagingViolations(env: Record<string, string | undefined>): StagingViolation[] {
  const v: StagingViolation[] = [];
  const add = (code: StagingViolationCode, detail: string) => v.push({ code, detail });
  const allow = allowlist(env);

  if (env.FORGE_STAGING !== "true") add("STAGING_MARKER_MISSING", "FORGE_STAGING=true is required for a staging stack");
  if ((env.FORGE_NETWORK ?? "sandbox") !== "sandbox") add("STAGING_NETWORK", `FORGE_NETWORK must be "sandbox" (got ${env.FORGE_NETWORK})`);
  const chainId = Number(env.FORGE_CHAIN_ID ?? "31337");
  if (!STAGING_CHAIN_IDS.has(chainId)) add("STAGING_CHAIN_ID", `FORGE_CHAIN_ID ${env.FORGE_CHAIN_ID} is not a local dev chain (31337/1337); chain 4663 and every public chain are refused`);

  const rpcHost = hostOf(env.FORGE_RPC_URL ?? "http://127.0.0.1:8545");
  if (!hostOk(rpcHost, allow)) add("STAGING_RPC_HOST", `FORGE_RPC_URL host ${rpcHost ?? "(invalid)"} is not loopback or allow-listed (FORGE_STAGING_HOST_ALLOWLIST) or is a known public provider`);

  for (const k of ["GITHUB_API_URL", "GITHUB_WEB_URL"] as const) {
    const h = hostOf(env[k]);
    if (h === null || !hostOk(h, allow)) add("STAGING_GITHUB_REAL", `${k} host ${h ?? "(unset)"} must be the simulated GitHub (loopback/allow-listed); a real GitHub App is a separate, operator-gated step (EXTERNAL_GITHUB_APP_CONFIGURATION_REQUIRED)`);
  }

  if ((env.FORGE_SIGNER_PROVIDER ?? "local-test") !== "local-test") add("STAGING_SIGNER_PROVIDER", "staging signs with test-only local keys; FORGE_SIGNER_PROVIDER must be local-test");
  for (const k of ["FORGE_AUTHORITY_PRIVATE_KEY", "FORGE_EVIDENCE_PRIVATE_KEY", "FORGE_RELAYER_PRIVATE_KEY", "FORGE_REVENUE_ATTESTOR_PRIVATE_KEY"] as const) {
    const key = env[k];
    if (!key) continue;
    let addr: string | null = null;
    try {
      addr = privateKeyToAddress(key as `0x${string}`).toLowerCase();
    } catch {
      addr = null;
    }
    if (addr === null || !TEST_ONLY_ADDRESSES.has(addr)) add("STAGING_KEY_NOT_TEST_ONLY", `${k} is not a well-known test-only development key (never put a real key in staging)`);
  }

  if ((env.FINCO_BURN_ENABLED ?? "false") !== "false" && env.FINCO_BURN_ENABLED !== "0") add("STAGING_FLAG", "FINCO_BURN_ENABLED must stay false");
  for (const k of ["PRODUCTION_SIGNING_ENABLED", "REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED", "DEPLOY_WRITE_ENABLED"] as const) {
    if (env[k] !== undefined && env[k] !== "false" && env[k] !== "0") add("STAGING_FLAG", `${k} must not be enabled in staging`);
  }
  if (env.PRODUCTION_BLOCKED !== undefined && env.PRODUCTION_BLOCKED !== "true" && env.PRODUCTION_BLOCKED !== "1") add("STAGING_FLAG", "PRODUCTION_BLOCKED must stay true");

  if (!env.DATABASE_URL) add("STAGING_DATABASE", "DATABASE_URL (PostgreSQL) is required: staging never uses the embedded PGlite store");
  else {
    let u: URL | null = null;
    try {
      u = new URL(env.DATABASE_URL);
    } catch {
      add("STAGING_DATABASE", "DATABASE_URL is not a valid URL");
    }
    if (u) {
      const dbName = u.pathname.replace(/^\//, "");
      if (!/^postgres(ql)?:$/.test(u.protocol)) add("STAGING_DATABASE", "DATABASE_URL must be a postgres:// URL");
      if (!/^forge_staging[a-z0-9_]*$/.test(dbName)) add("STAGING_DATABASE", `database name "${dbName}" must start with forge_staging (production-looking names are refused)`);
      if (!hostOk(u.hostname.toLowerCase(), allow)) add("STAGING_DATABASE", `database host ${u.hostname} is not loopback or allow-listed or is a managed-cloud host`);
    }
  }
  if (env.FORGE_PGLITE_DIR) add("STAGING_DATABASE", "FORGE_PGLITE_DIR must be unset in staging");

  const s = env.SESSION_SECRET ?? "";
  if (s.length < 32 || SAMPLE_SECRET.test(s)) add("STAGING_SECRET", "SESSION_SECRET must be >= 32 characters and not a sample value");
  if (!env.FORGE_OPS_TOKEN || env.FORGE_OPS_TOKEN.length < 32 || SAMPLE_SECRET.test(env.FORGE_OPS_TOKEN)) add("STAGING_SECRET", "FORGE_OPS_TOKEN (>= 32 chars, not a sample value) is required so the operator endpoints can be exercised");

  const originHost = hostOf(env.FORGE_PUBLIC_ORIGIN ?? "http://localhost:3000");
  if (!hostOk(originHost, allow)) add("STAGING_PUBLIC_ORIGIN", `FORGE_PUBLIC_ORIGIN host ${originHost ?? "(invalid)"} is not loopback or allow-listed`);
  return v;
}

export class StagingConfigError extends Error {
  constructor(readonly violations: StagingViolation[]) {
    super(`STAGING_CONFIG_REFUSED: ${violations.map((x) => `${x.code}: ${x.detail}`).join("; ")}`);
  }
}

export function assertStagingEnv(env: Record<string, string | undefined>): void {
  const v = stagingViolations(env);
  if (v.length) throw new StagingConfigError(v);
}

/** Probes the RPC: a staging stack refuses any endpoint whose chain id is not a local dev chain. */
export async function assertStagingChain(rpcUrl: string, fetchImpl: typeof fetch = fetch, timeoutMs = 5_000): Promise<number> {
  const r = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = (await r.json()) as { result?: string };
  const id = j.result ? Number(BigInt(j.result)) : NaN;
  if (!STAGING_CHAIN_IDS.has(id)) throw new StagingConfigError([{ code: "STAGING_RPC_CHAIN_MISMATCH", detail: `RPC reports chain id ${Number.isNaN(id) ? "(none)" : id}; staging requires a local dev chain (31337/1337)` }]);
  return id;
}
