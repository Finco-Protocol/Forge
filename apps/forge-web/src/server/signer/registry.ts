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
  private externalChecked = false;

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

  private async disable(role: SignerRole, reason: string, onchain?: OnchainCheck) {
    const s = this.states.get(role)!;
    if (onchain) s.onchain = onchain;
    if (!s.enabled) return;
    s.enabled = false;
    s.reason = reason;
    console.error(`[forge-signer] ${role} signing DISABLED: ${reason}`);
    await audit(this.d.db, "forge:signer-registry", "ALERT:signer_role_disabled", role, { address: s.address, reason });
  }

  /** Called by the guard on every request: null = may sign. Re-tries on-chain verification that could not run at startup. */
  private async gate(role: SignerRole): Promise<string | null> {
    let s = this.states.get(role);
    if (!s) return "role not configured";
    if (s.enabled && (s.onchain === "unverified" || !this.externalChecked)) {
      await this.verifyOnChain().catch(() => undefined);
      s = this.states.get(role)!;
    }
    if (!s.enabled) return s.reason;
    if (s.onchain === "unverified" || !this.externalChecked) return "on-chain role verification has not succeeded yet";
    return null;
  }

  /**
   * Reads the on-chain role holders and the external (treasury/governance)
   * addresses. A server key equal to an external address is a custody
   * violation: every role is disabled and an Error is thrown. RPC failure
   * leaves roles `unverified` (they cannot sign until a later check passes).
   */
  async verifyOnChain(): Promise<void> {
    const { client, cfg } = this.d;
    const a = cfg.addresses;
    const read = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v })).catch((e: Error) => ({ ok: false as const, e }));
    const [regAuth, authzAuth, regOwner, authzOwner, factoryOwner, splitter] = await Promise.all([
      read(client.readContract({ address: a.registry, abi: forgeBindingRegistryAbi, functionName: "eligibilityAuthority" })),
      read(client.readContract({ address: a.authorizer, abi: forgeLaunchAuthorizerAbi, functionName: "eligibilityAuthority" })),
      read(client.readContract({ address: a.registry, abi: forgeBindingRegistryAbi, functionName: "owner" })),
      read(client.readContract({ address: a.authorizer, abi: forgeLaunchAuthorizerAbi, functionName: "owner" })),
      read(client.readContract({ address: a.factory, abi: ponsV2LaunchFactoryAbi, functionName: "owner" })),
      a.revenueSplitter
        ? read(
            Promise.all([
              client.readContract({ address: a.revenueSplitter, abi: forgeProtocolRevenueSplitterAbi, functionName: "revenueAttestor" }),
              client.readContract({ address: a.revenueSplitter, abi: forgeProtocolRevenueSplitterAbi, functionName: "owner" }),
              client.readContract({ address: a.revenueSplitter, abi: forgeProtocolRevenueSplitterAbi, functionName: "treasuryRecipient" }),
            ]),
          )
        : Promise.resolve({ ok: true as const, v: null }),
    ]);
    const pendingOwners = await Promise.all([
      read(client.readContract({ address: a.registry, abi: forgeBindingRegistryAbi, functionName: "pendingOwner" })),
      read(client.readContract({ address: a.authorizer, abi: forgeLaunchAuthorizerAbi, functionName: "pendingOwner" })),
      read(client.readContract({ address: a.factory, abi: ponsV2LaunchFactoryAbi, functionName: "pendingOwner" })),
      a.revenueSplitter ? read(client.readContract({ address: a.revenueSplitter, abi: forgeProtocolRevenueSplitterAbi, functionName: "pendingOwner" })) : Promise.resolve({ ok: true as const, v: zeroAddress }),
    ]);

    // External roles: governance (owners, pending owners) and the treasury recipient.
    const externalReads = [regOwner, authzOwner, factoryOwner, splitter, ...pendingOwners];
    if (externalReads.every((x) => x.ok)) {
      const external = new Map<string, string>();
      const add = (label: string, v: unknown) => {
        if (typeof v === "string" && v !== zeroAddress) external.set(getAddress(v), label);
      };
      add("registry owner", regOwner.ok && regOwner.v);
      add("authorizer owner", authzOwner.ok && authzOwner.v);
      add("factory owner", factoryOwner.ok && factoryOwner.v);
      if (splitter.ok && splitter.v) {
        add("splitter owner", splitter.v[1]);
        add("treasury recipient", splitter.v[2]);
      }
      pendingOwners.forEach((p, i) => add(`pending owner #${i}`, p.ok && p.v));
      const held: [string, Address][] = [["relayer", getAddress(this.d.relayerAddress)], ...[...this.states.values()].map((s) => [s.role, s.address] as [string, Address])];
      for (const [role, addr] of held) {
        const label = external.get(addr);
        if (label) {
          for (const r of this.states.keys()) await this.disable(r, `custody violation: server ${role} key equals the ${label} (external role)`, "mismatch");
          throw new Error(`Signer custody violation: the server's ${role} key ${addr} is the on-chain ${label}. Treasury and governance keys are external (Safe) and must never be held by the server.`);
        }
      }
      this.externalChecked = true;
    }

    const authority = this.states.get("authority");
    if (authority && authority.onchain !== "mismatch") {
      if (regAuth.ok && authzAuth.ok) {
        if (getAddress(regAuth.v) !== authority.address || getAddress(authzAuth.v) !== authority.address) {
          await this.disable("authority", `on-chain eligibilityAuthority (registry ${regAuth.v}, authorizer ${authzAuth.v}) ≠ custody address ${authority.address}`, "mismatch");
        } else authority.onchain = "verified";
      }
    }
    const evidence = this.states.get("evidence");
    if (evidence) evidence.onchain = "not-applicable";
    const revenue = this.states.get("revenue");
    if (revenue && revenue.onchain !== "mismatch") {
      if (!a.revenueSplitter) revenue.onchain = "not-applicable";
      else if (splitter.ok && splitter.v) {
        const onchain = getAddress(splitter.v[0]);
        if (onchain !== revenue.address) {
          await this.disable("revenue", onchain === zeroAddress ? "splitter revenueAttestor is revoked (address(0)) on chain" : `splitter revenueAttestor ${onchain} ≠ custody address ${revenue.address}`, "mismatch");
        } else revenue.onchain = "verified";
      }
    }
  }
}
