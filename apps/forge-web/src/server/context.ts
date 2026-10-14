import { buildConfig, type ForgeConfig } from "./config";
import { openDb, type Db } from "./db";
import { migrate } from "./db/migrate";
import { GithubApp } from "./github/client";
import { makePublicClient, makeRelayer, type ForgePublicClient, type ForgeWalletClient } from "./chain/clients";
import { LocalTestDigestSigner } from "./signer/local";
import { AuthoritySigner } from "./signer/policy";
import type { DigestSigner } from "./signer/types";

export interface AppContext {
  cfg: ForgeConfig;
  db: Db;
  github: GithubApp;
  client: ForgePublicClient;
  relayer: ForgeWalletClient;
  authority: AuthoritySigner;
  evidenceSigner: DigestSigner;
}

function requireKey(name: string, v: `0x${string}` | string | undefined): `0x${string}` {
  if (!v) throw new Error(`${name} is required for FORGE_SIGNER_PROVIDER=local-test (sandbox only).`);
  return v as `0x${string}`;
}

export async function createAppContext(env: Record<string, string | undefined> = process.env, opts: { db?: Db; fetchImpl?: typeof fetch } = {}): Promise<AppContext> {
  const cfg = buildConfig(env);
  const db = opts.db ?? (await openDb(cfg.db));
  await migrate(db);
  const client = makePublicClient(cfg);
  const relayer = makeRelayer(cfg, requireKey("FORGE_RELAYER_PRIVATE_KEY", cfg.signer.relayerKey));
  // Only the local-test provider exists in W03; KMS/HSM adapters implement
  // DigestSigner and require separately approved custody (PRODUCTION_BLOCKED).
  const authorityDigest = new LocalTestDigestSigner("authority", requireKey("FORGE_AUTHORITY_PRIVATE_KEY", cfg.signer.authorityKey), cfg);
  const evidenceSigner = new LocalTestDigestSigner("evidence", requireKey("FORGE_EVIDENCE_PRIVATE_KEY", cfg.signer.evidenceKey), cfg);
  if (authorityDigest.address === evidenceSigner.address || authorityDigest.address === relayer.account.address) {
    throw new Error("Authority, evidence and relayer keys must be distinct.");
  }
  const github = new GithubApp(cfg.github, opts.fetchImpl);
  const authority = new AuthoritySigner({ cfg, db, client, authority: authorityDigest });
  return { cfg, db, github, client, relayer, authority, evidenceSigner };
}

/**
 * Process-wide context. Kept on globalThis: Next.js loads route handlers and
 * instrumentation (embedded worker) in separate module graphs, and both must
 * share ONE database handle (PGlite is single-process).
 */
const g = globalThis as unknown as { __forgeAppContext?: Promise<AppContext> | null };
export function getAppContext(): Promise<AppContext> {
  g.__forgeAppContext ??= createAppContext().catch((e) => {
    g.__forgeAppContext = null;
    throw e;
  });
  return g.__forgeAppContext;
}
