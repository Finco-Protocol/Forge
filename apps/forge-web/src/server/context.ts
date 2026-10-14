import { buildConfig, type ForgeConfig } from "./config";
import { openDb, type Db } from "./db";
import { assertDatabaseReady, migrate } from "./db/migrate";
import { GithubApp } from "./github/client";
import { makePublicClient, makeRelayer, type ForgePublicClient, type ForgeWalletClient } from "./chain/clients";
import { AuthoritySigner } from "./signer/policy";
import type { GuardedSigner } from "./signer/guard";
import { buildDigestSigners, SignerRegistry, type KmsBackendFactory } from "./signer/registry";

export interface AppContext {
  cfg: ForgeConfig;
  db: Db;
  github: GithubApp;
  client: ForgePublicClient;
  relayer: ForgeWalletClient;
  authority: AuthoritySigner;
  /** Evidence signer behind the W05 signing-policy guard (EIP-191 over a receipt hash only). */
  evidenceSigner: GuardedSigner;
  /** W04: revenue attestor (null = attestation disabled, pulls fail closed). W05: behind the signing-policy guard. */
  revenueAttestor: GuardedSigner | null;
  /** W05: signer registry — startup verification state, key versions, guards. */
  signers: SignerRegistry;
}

function requireKey(name: string, v: `0x${string}` | string | undefined): `0x${string}` {
  if (!v) throw new Error(`${name} is required for FORGE_SIGNER_PROVIDER=local-test (sandbox only).`);
  return v as `0x${string}`;
}

export async function createAppContext(
  env: Record<string, string | undefined> = process.env,
  opts: { db?: Db; fetchImpl?: typeof fetch; /** W05: KMS backends (only used when FORGE_SIGNER_PROVIDER=kms). */ kms?: KmsBackendFactory } = {},
): Promise<AppContext> {
  const cfg = buildConfig(env);
  const db = opts.db ?? (await openDb(cfg.db));
  // W05: migrations run under a cluster-wide advisory lock and refuse drift /
  // downgrade; then the schema, server version and session TimeZone are
  // verified (fail closed) before anything else touches the database.
  try {
    if (cfg.db.migrate === "apply") await migrate(db, undefined, { lockTimeoutMs: cfg.db.migrationLockTimeoutMs });
    await assertDatabaseReady(db);
  } catch (e) {
    if (!opts.db) await db.close().catch(() => undefined);
    throw e;
  }
  const client = makePublicClient(cfg);
  const relayer = makeRelayer(cfg, requireKey("FORGE_RELAYER_PRIVATE_KEY", cfg.signer.relayerKey));
  // Custody: local-test (default, dev chains only) or KMS (injected backend; also dev chains only
  // while PRODUCTION_SIGNING_ENABLED=false). Every custody signer sits behind the W05 GuardedSigner.
  const custody = await buildDigestSigners(cfg, opts.kms);
  if (custody.authority!.address === custody.evidence!.address || custody.authority!.address === relayer.account.address) {
    throw new Error("Authority, evidence and relayer keys must be distinct.");
  }
  if (custody.revenue && [custody.authority!.address, custody.evidence!.address, relayer.account.address].includes(custody.revenue.address)) {
    throw new Error("The revenue attestor key must be distinct from the authority, evidence and relayer keys.");
  }
  const signers = await SignerRegistry.create({
    cfg,
    db,
    client,
    signers: { authority: custody.authority, evidence: custody.evidence, revenue: custody.revenue },
    keyRefs: custody.keyRefs,
    relayerAddress: relayer.account.address,
  });
  const github = new GithubApp(cfg.github, opts.fetchImpl);
  const authority = new AuthoritySigner({ cfg, db, client, authority: signers.guarded("authority")! });
  return { cfg, db, github, client, relayer, authority, evidenceSigner: signers.guarded("evidence")!, revenueAttestor: signers.guarded("revenue"), signers };
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
