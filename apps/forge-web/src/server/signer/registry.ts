/**
 * Signer registry & startup verification (W05).
 *
 * Five roles, strictly separated:
 *
 *   server-held   authority (BindingOp + EligibilityAttestation), evidence
 *                 (Proof-of-Build receipts), revenue (EligibleRevenue),
 *                 relayer (gas only — a viem wallet, never a custody role)
 *   external      treasury recipient and governance (Safe owners of the
 *                 factory/registry/authorizer/splitter): NEVER held by the
 *                 server; the registry asserts no server key equals them.
 *
 * At startup each custody role's address is DERIVED from its provider
 * (local-test key or KMS GetPublicKey) and must equal:
 *   - the configured expected address (required for KMS),
 *   - the enrolled active key version (signer_keys),
 *   - the on-chain role holder where one exists: registry AND authorizer
 *     `eligibilityAuthority` (authority), splitter `revenueAttestor` (revenue).
 * Any mismatch disables THAT role (fail closed, logged as an ALERT audit
 * event); the process still starts so reads and other roles keep working.
 * Key overlap between server roles, or a server key equal to an external
 * governance/treasury address, refuses startup altogether.
 *
 * AUTHORITY FRESHNESS (PR #5 Correction A): startup verification is NOT a
 * permanent authorization. EVERY signing request re-reads the authoritative
 * on-chain state (ONE snapshot per request: registry + authorizer
 * eligibilityAuthority, splitter revenueAttestor/owner/treasuryRecipient,
 * factory/registry/authorizer owners and pending owners) and decides from that
 * snapshot alone. There is no cache: the staleness bound is zero blocks (only
 * the read→sign interval of one request remains). Therefore:
 *   - a rotated/revoked on-chain authority or attestor refuses the old signer
 *     on its very next request, and it is accepted again ONLY when the chain
 *     names that address again (explicit verified current authority, never a
 *     stale cached "verified" flag);
 *   - an RPC failure, or any required read failing, refuses the signature;
 *   - a server key found equal to a governance/treasury address trips a STICKY
 *     custody violation (every role disabled until a restart passes startup
 *     verification again);
 *   - concurrent requests each decide from their own fresh snapshot, and an
 *     older snapshot can never overwrite newer persisted role state.
 */
import { getAddress, zeroAddress, type Address } from "viem";
import { forgeBindingRegistryAbi, forgeLaunchAuthorizerAbi, forgeProtocolRevenueSplitterAbi, ponsV2LaunchFactoryAbi } from "@/shared/abis.generated";
import type { ForgeConfig } from "../config";
import type { Db } from "../db";
import type { ForgePublicClient } from "../chain/clients";
import { audit } from "../audit";
import { buildAllowlist, SIGNER_ROLES, type SignerRole } from "./allowlist";
import { enrollConfiguredKey } from "./controls";
import { GuardedSigner } from "./guard";
import { LocalTestDigestSigner } from "./local";
import type { Secp256k1KmsBackend } from "./kms/backend";
import { KmsDigestSigner } from "./kms/signer";
import type { DigestSigner } from "./types";

/** Injected by the process that enables KMS custody (no cloud SDK is bundled). */
export type KmsBackendFactory = (role: SignerRole, keyId: string) => Secp256k1KmsBackend;

export type OnchainCheck = "verified" | "not-applicable" | "unverified" | "mismatch";
export interface RoleStatus {
  role: SignerRole;
  address: Address;
  custody: DigestSigner["custody"];
  keyRef: string | null;
  keyVersion: number | null;
  enabled: boolean;
  /** Reason the role is disabled (sticky until restart/reverify); null when enabled. */
  reason: string | null;
  onchain: OnchainCheck;
}

function requireKey(name: string, v: string | undefined): `0x${string}` {
  if (!v) throw new Error(`${name} is required for FORGE_SIGNER_PROVIDER=local-test (sandbox only).`);
  return v as `0x${string}`;
}

/** Builds the custody-level DigestSigners for the configured provider. Throws on any construction refusal. */
export async function buildDigestSigners(cfg: ForgeConfig, kms?: KmsBackendFactory): Promise<Record<SignerRole, DigestSigner | null> & { keyRefs: Record<SignerRole, string | null> }> {
  if (cfg.signer.provider === "local-test") {
    const authority = new LocalTestDigestSigner("authority", requireKey("FORGE_AUTHORITY_PRIVATE_KEY", cfg.signer.authorityKey), cfg);
    const evidence = new LocalTestDigestSigner("evidence", requireKey("FORGE_EVIDENCE_PRIVATE_KEY", cfg.signer.evidenceKey), cfg);
    // Production signing stays disabled (REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED=false): the
    // local-test signer itself refuses every chain but 31337/1337.
    const revenue = cfg.signer.revenueAttestorKey ? new LocalTestDigestSigner("revenue", cfg.signer.revenueAttestorKey as `0x${string}`, cfg) : null;
    return { authority, evidence, revenue, keyRefs: { authority: "local-test", evidence: "local-test", revenue: revenue ? "local-test" : null } };
  }
  if (!kms) throw new Error("FORGE_SIGNER_PROVIDER=kms but no KMS backend is wired into this process (no cloud SDK is bundled; inject one via createAppContext opts.kms).");
  const ids = cfg.signer.kmsKeyIds;
  const make = async (role: SignerRole, keyId: string | undefined) => (keyId ? KmsDigestSigner.create(role, kms(role, keyId), cfg) : null);
  const authority = await make("authority", ids.authority);
  const evidence = await make("evidence", ids.evidence);
  if (!authority || !evidence) throw new Error("FORGE_SIGNER_PROVIDER=kms requires authority and evidence KMS key ids.");
  return { authority, evidence, revenue: await make("revenue", ids.revenue), keyRefs: { authority: ids.authority!, evidence: ids.evidence!, revenue: ids.revenue ?? null } };
}

/** Throws when any two server-held keys share an address (strict role separation). */
export function assertDistinctServerKeys(keys: Partial<Record<SignerRole | "relayer", Address | null | undefined>>) {
  const seen = new Map<string, string>();
  for (const [role, a] of Object.entries(keys)) {
    if (!a) continue;
    const k = getAddress(a);
    const prev = seen.get(k);
    if (prev) throw new Error(`Signer role separation violated: ${prev} and ${role} share key ${k}. Authority, evidence, revenue attestor and relayer keys must be distinct.`);
    seen.set(k, role);
  }
}

export interface RegistryDeps {
  cfg: ForgeConfig;
  db: Db;
  client: ForgePublicClient;
  signers: Record<SignerRole, DigestSigner | null>;
  keyRefs: Record<SignerRole, string | null>;
  relayerAddress: Address;
}

export class SignerRegistry {
  private readonly states = new Map<SignerRole, RoleStatus>();
  private readonly guards = new Map<SignerRole, GuardedSigner>();
  /** Sticky disables (custody / config / enrolment): cleared only by a restart. */
  private readonly sticky = new Map<SignerRole, string>();
  /** Chain-derived disables, recomputed from every fresh snapshot (never sticky). */
  private readonly chainReason = new Map<SignerRole, string>();
  private seq = 0;
  private appliedSeq = 0;

  private constructor(private readonly d: RegistryDeps) {}

  static async create(d: RegistryDeps): Promise<SignerRegistry> {
    const r = new SignerRegistry(d);
    assertDistinctServerKeys({ authority: d.signers.authority?.address, evidence: d.signers.evidence?.address, revenue: d.signers.revenue?.address, relayer: d.relayerAddress });
    const expectedRelayer = d.cfg.signer.expected.relayer;
    if (expectedRelayer && getAddress(expectedRelayer) !== getAddress(d.relayerAddress)) {
      throw new Error(`Relayer key ${d.relayerAddress} does not match FORGE_RELAYER_EXPECTED_ADDRESS ${expectedRelayer}.`);
    }
    for (const role of SIGNER_ROLES) {
      const s = d.signers[role];
      if (!s) continue;
      if (s.role !== role) throw new Error(`signer for ${role} reports role ${s.role}`);
      r.states.set(role, { role, address: getAddress(s.address), custody: s.custody, keyRef: d.keyRefs[role], keyVersion: null, enabled: true, reason: null, onchain: "unverified" });
      const expected = d.cfg.signer.expected[role];
      if (expected && getAddress(expected) !== getAddress(s.address)) {
        await r.disable(role, `custody address ${s.address} ≠ configured expected address ${getAddress(expected)}`);
        continue;
      }
      const enrolled = await enrollConfiguredKey(d.db, role, s.address, s.custody, d.keyRefs[role]);
      r.states.get(role)!.keyVersion = enrolled.version;
      if (!enrolled.ok) await r.disable(role, enrolled.reason);
    }
    await r.verifyOnChain();
    for (const role of SIGNER_ROLES) {
      const s = d.signers[role];
      if (!s) continue;
      r.guards.set(
        role,
        new GuardedSigner({
          role,
          inner: s,
          db: d.db,
          chainId: d.cfg.chainId,
          allowlist: buildAllowlist(role, d.cfg),
          envKillSwitch: d.cfg.signer.killSwitch,
          rateLimitPerHour: d.cfg.signer.roleRateLimitPerHour,
          verificationGate: () => r.gate(role),
        }),
      );
    }
    return r;
  }

  status(role: SignerRole): RoleStatus | null {
    const s = this.states.get(role);
    return s ? { ...s } : null;
  }

  statuses(): RoleStatus[] {
    return [...this.states.values()].map((s) => ({ ...s }));
  }

  guarded(role: SignerRole): GuardedSigner | null {
    return this.guards.get(role) ?? null;
  }

  /** Sticky disable (custody / configuration / enrolment). */
  private async disable(role: SignerRole, reason: string, onchain?: OnchainCheck) {
    const s = this.states.get(role)!;
    if (onchain) s.onchain = onchain;
    if (this.sticky.has(role)) return;
    this.sticky.set(role, reason);
    this.refresh(role);
    console.error(`[forge-signer] ${role} signing DISABLED: ${reason}`);
    await audit(this.d.db, "forge:signer-registry", "ALERT:signer_role_disabled", role, { address: s.address, reason });
  }

  private refresh(role: SignerRole) {
    const s = this.states.get(role)!;
    const reason = this.sticky.get(role) ?? this.chainReason.get(role) ?? null;
    s.enabled = reason === null;
    s.reason = reason;
  }

  /**
   * Called by the guard on EVERY signing request: null = may sign. Always reads a FRESH on-chain snapshot
   * (no TTL, no cached "verified"); the decision for this request is a pure function of that snapshot.
   */
  private async gate(role: SignerRole): Promise<string | null> {
    const s = this.states.get(role);
    if (!s) return "role not configured";
    const sticky = this.sticky.get(role);
    if (sticky) return sticky;
    const mySeq = ++this.seq;
    const snap = await this.readSnapshot();
    const ev = this.evaluate(snap);
    await this.persist(ev, mySeq);
    const sticky2 = this.sticky.get(role);
    if (sticky2) return sticky2;
    if (ev.custody) return `custody violation: ${ev.custody}`;
    if (!snap.complete) return `authoritative on-chain read failed (fail closed): ${snap.error ?? "incomplete snapshot"}`;
    return ev.roles.get(role)?.reason ?? null;
  }

  /**
   * Startup / operator verification: reads one snapshot and applies it. A custody violation (server key equal
   * to a governance/treasury address) disables every role stickily and throws.
   */
  async verifyOnChain(): Promise<void> {
    const mySeq = ++this.seq;
    const snap = await this.readSnapshot();
    const ev = this.evaluate(snap);
    await this.persist(ev, mySeq);
    if (ev.custody) throw new Error(`Signer custody violation: ${ev.custody}. Treasury and governance keys are external (Safe) and must never be held by the server.`);
  }

  /** ONE authoritative read of everything the signing policy depends on. Never throws. */
  private async readSnapshot(): Promise<ChainSnapshot> {
    const { client, cfg } = this.d;
    const a = cfg.addresses;
    const read = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v })).catch((e: Error) => ({ ok: false as const, e }));
    const sp = a.revenueSplitter;
    const [regAuth, authzAuth, regOwner, authzOwner, factoryOwner, splitter, p0, p1, p2, p3] = await Promise.all([
      read(client.readContract({ address: a.registry, abi: forgeBindingRegistryAbi, functionName: "eligibilityAuthority" })),
      read(client.readContract({ address: a.authorizer, abi: forgeLaunchAuthorizerAbi, functionName: "eligibilityAuthority" })),
      read(client.readContract({ address: a.registry, abi: forgeBindingRegistryAbi, functionName: "owner" })),
      read(client.readContract({ address: a.authorizer, abi: forgeLaunchAuthorizerAbi, functionName: "owner" })),
      read(client.readContract({ address: a.factory, abi: ponsV2LaunchFactoryAbi, functionName: "owner" })),
      sp
        ? read(
            Promise.all([
              client.readContract({ address: sp, abi: forgeProtocolRevenueSplitterAbi, functionName: "revenueAttestor" }),
              client.readContract({ address: sp, abi: forgeProtocolRevenueSplitterAbi, functionName: "owner" }),
              client.readContract({ address: sp, abi: forgeProtocolRevenueSplitterAbi, functionName: "treasuryRecipient" }),
              client.readContract({ address: sp, abi: forgeProtocolRevenueSplitterAbi, functionName: "pendingOwner" }),
            ]),
          )
        : Promise.resolve({ ok: true as const, v: null }),
      read(client.readContract({ address: a.registry, abi: forgeBindingRegistryAbi, functionName: "pendingOwner" })),
      read(client.readContract({ address: a.authorizer, abi: forgeLaunchAuthorizerAbi, functionName: "pendingOwner" })),
      read(client.readContract({ address: a.factory, abi: ponsV2LaunchFactoryAbi, functionName: "pendingOwner" })),
      Promise.resolve({ ok: true as const, v: zeroAddress }),
    ]);
    const all = [regAuth, authzAuth, regOwner, authzOwner, factoryOwner, splitter, p0, p1, p2, p3];
    const failed = all.find((x) => !x.ok);
    const external = new Map<string, string>();
    const add = (label: string, v: unknown) => {
      if (typeof v === "string" && v !== zeroAddress) external.set(getAddress(v), label);
    };
    if (regOwner.ok) add("registry owner", regOwner.v);
    if (authzOwner.ok) add("authorizer owner", authzOwner.v);
    if (factoryOwner.ok) add("factory owner", factoryOwner.v);
    if (splitter.ok && splitter.v) {
      add("splitter owner", splitter.v[1]);
      add("treasury recipient", splitter.v[2]);
      add("splitter pending owner", splitter.v[3]);
    }
    [p0, p1, p2].forEach((p, i) => p.ok && add(`pending owner #${i}`, p.v));
    return {
      complete: !failed,
      error: failed && !failed.ok ? failed.e.message.split("\n")[0] : undefined,
      external,
      regAuth: regAuth.ok ? getAddress(regAuth.v) : null,
      authzAuth: authzAuth.ok ? getAddress(authzAuth.v) : null,
      attestor: splitter.ok && splitter.v ? getAddress(splitter.v[0]) : null,
      hasSplitter: !!sp,
    };
  }

  /** Pure: derive per-role on-chain verdicts (and a custody conflict, if any) from one snapshot. */
  private evaluate(snap: ChainSnapshot): Evaluation {
    const roles = new Map<SignerRole, { reason: string | null; onchain: OnchainCheck }>();
    let custody: string | null = null;
    const held: [string, Address][] = [["relayer", getAddress(this.d.relayerAddress)], ...[...this.states.values()].map((s) => [s.role, s.address] as [string, Address])];
    for (const [role, addr] of held) {
      const label = snap.external.get(addr);
      if (label) {
        custody = `the server's ${role} key ${addr} is the on-chain ${label}`;
        break;
      }
    }
    for (const role of this.states.keys()) {
      const s = this.states.get(role)!;
      if (role === "evidence") roles.set(role, { reason: null, onchain: "not-applicable" });
      else if (role === "authority") {
        if (snap.regAuth === null || snap.authzAuth === null) roles.set(role, { reason: "eligibilityAuthority could not be read", onchain: "unverified" });
        else if (snap.regAuth !== s.address || snap.authzAuth !== s.address) roles.set(role, { reason: `on-chain eligibilityAuthority (registry ${snap.regAuth}, authorizer ${snap.authzAuth}) ≠ custody address ${s.address}`, onchain: "mismatch" });
        else roles.set(role, { reason: null, onchain: "verified" });
      } else if (role === "revenue") {
        if (!snap.hasSplitter) roles.set(role, { reason: null, onchain: "not-applicable" });
        else if (snap.attestor === null) roles.set(role, { reason: "splitter revenueAttestor could not be read", onchain: "unverified" });
        else if (snap.attestor !== s.address) roles.set(role, { reason: snap.attestor === zeroAddress ? "splitter revenueAttestor is revoked (address(0)) on chain" : `splitter revenueAttestor ${snap.attestor} ≠ custody address ${s.address}`, onchain: "mismatch" });
        else roles.set(role, { reason: null, onchain: "verified" });
      }
    }
    return { roles, custody, seq: 0 };
  }

  /** Apply an evaluation to persisted role state, but never let an older snapshot overwrite a newer one. */
  private async persist(ev: Evaluation, mySeq: number): Promise<void> {
    if (ev.custody) {
      for (const r of this.states.keys()) await this.disable(r, `custody violation: ${ev.custody}`, "mismatch");
    }
    if (mySeq < this.appliedSeq) return;
    this.appliedSeq = mySeq;
    for (const [role, v] of ev.roles) {
      const s = this.states.get(role)!;
      const before = this.chainReason.get(role) ?? null;
      s.onchain = v.onchain === "unverified" && s.onchain === "mismatch" ? "mismatch" : v.onchain;
      if (v.reason && v.onchain === "mismatch") this.chainReason.set(role, v.reason);
      else if (v.onchain !== "unverified") this.chainReason.delete(role);
      this.refresh(role);
      const after = this.chainReason.get(role) ?? null;
      if (!before && after) {
        console.error(`[forge-signer] ${role} signing DISABLED: ${after}`);
        await audit(this.d.db, "forge:signer-registry", "ALERT:signer_role_disabled", role, { address: s.address, reason: after });
      } else if (before && !after) {
        await audit(this.d.db, "forge:signer-registry", "signer_role_reenabled", role, { address: s.address, reason: "on-chain authority names this key again (fresh read)" });
      }
    }
  }
}

interface ChainSnapshot {
  complete: boolean;
  error?: string;
  external: Map<string, string>;
  regAuth: Address | null;
  authzAuth: Address | null;
  attestor: Address | null;
  hasSplitter: boolean;
}
interface Evaluation {
  roles: Map<SignerRole, { reason: string | null; onchain: OnchainCheck }>;
  custody: string | null;
  seq: number;
}
