/**
 * GuardedSigner — the signing-policy enforcement layer between every caller
 * and custody (local-test or KMS/HSM DigestSigner). Callers hand it the
 * STRUCTURED payload, never a digest: the guard checks it against the role's
 * allowlist (EIP-712 domain name/version/chainId/verifyingContract, primary
 * type, canonical struct definitions), recomputes the digest itself, and only
 * then asks custody to sign. Per request, in order:
 *
 *   1. allowlist + PRODUCTION_SIGNING_ENABLED gate (4663 / non-dev chains refused)
 *   2. kill switch (env FORGE_SIGNER_KILL_SWITCH + DB signer_kill_switch)
 *   3. key version status (only `active` signs; retired/revoked never)
 *   4. startup verification state (expected address, on-chain role holder)
 *   5. per-role rate limit (Postgres fixed window)
 *   6. replay/concurrency claim: one signature per (role, digest), ever
 *   7. custody sign + recover-to-address self-check
 *
 * Every outcome — allowed, denied, failed — is appended to signer_audit with
 * a correlation id. The domain-specific policy (AuthoritySigner, the revenue
 * attestor, the evidence ledger) still runs ABOVE this layer.
 */
import { randomUUID } from "node:crypto";
import { getAddress, hashMessage, hashTypedData, recoverAddress, validateTypedData, type Address, type Hex, type TypedDataDomain } from "viem";
import { PRODUCTION_SIGNING_ENABLED, ROBINHOOD_CHAIN_ID } from "../config";
import type { Db } from "../db";
import { ForgeError } from "../errors";
import { rateLimit } from "../ratelimit";
import { LOCAL_DEV_CHAIN_IDS } from "./local";
import { sameTypes, type AllowRule, type Eip712Rule, type SignerRole, type TypedFields } from "./allowlist";
import { liveSignerState } from "./controls";
import type { DigestSigner } from "./types";

export interface SignMeta {
  requestedBy: string;
  correlationId?: string;
  /** Optional caller idempotency key: reusing it for a different payload is refused. */
  idempotencyKey?: string;
}

export interface TypedDataRequest {
  domain: TypedDataDomain;
  types: Readonly<Record<string, TypedFields>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface SignResult {
  digest: Hex;
  signature: Hex;
  correlationId: string;
  keyVersion: number | null;
  /** true when an identical earlier request's stored signature was returned. */
  replayed: boolean;
}

export interface GuardOptions {
  role: SignerRole;
  inner: DigestSigner;
  db: Db;
  /** The deployment chain (gates EIP-191 payloads, which carry no chain id). */
  chainId: number;
  allowlist: AllowRule[];
  /** Env kill switch (process-level, set at boot). */
  envKillSwitch: ReadonlySet<string>;
  rateLimitPerHour: number;
  /** Registry verification gate: null = verified, otherwise the reason the role is disabled. */
  verificationGate: () => Promise<string | null>;
  /** How long an in-flight claim blocks an identical request before it is considered abandoned. */
  pendingStaleMs?: number;
}

interface AuditFields {
  payloadKind: "eip712" | "eip191";
  chainId?: number | null;
  verifyingContract?: string | null;
  domainName?: string | null;
  domainVersion?: string | null;
  primaryType?: string | null;
  digest?: Hex | null;
}

export class GuardedSigner {
  readonly role: SignerRole;
  readonly address: Address;
  readonly custody: DigestSigner["custody"];
  private readonly pendingStaleMs: number;

  constructor(private readonly o: GuardOptions) {
    if (o.inner.role !== o.role) throw new Error(`GuardedSigner: inner signer role ${o.inner.role} ≠ ${o.role}`);
    this.role = o.role;
    this.address = getAddress(o.inner.address);
    this.custody = o.inner.custody;
    this.pendingStaleMs = o.pendingStaleMs ?? 60_000;
  }

  private async audit(decision: "allowed" | "denied" | "failed", correlationId: string, meta: SignMeta, f: AuditFields, reason: string | null, keyVersion: number | null, replayed = false) {
    await this.o.db.query(
      `INSERT INTO signer_audit(correlation_id, role, decision, reason, replayed, signer_address, key_version, custody, payload_kind, chain_id,
                                verifying_contract, domain_name, domain_version, primary_type, digest, idempotency_key, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        correlationId,
        this.role,
        decision,
        reason,
        replayed,
        this.address,
        keyVersion,
        this.custody,
        f.payloadKind,
        f.chainId ?? null,
        f.verifyingContract ?? null,
        f.domainName ?? null,
        f.domainVersion ?? null,
        f.primaryType ?? null,
        f.digest ?? null,
        meta.idempotencyKey ?? null,
        meta.requestedBy,
      ],
    );
  }

  private async deny(correlationId: string, meta: SignMeta, f: AuditFields, reason: string, keyVersion: number | null = null, code = "SIGNER_DENIED", status = 403): Promise<never> {
    await this.audit("denied", correlationId, meta, f, reason, keyVersion);
    throw new ForgeError(code, `Custody signing refused (${this.role}): ${reason}`, status, { role: this.role, reason, correlationId });
  }

  private matchEip712(req: TypedDataRequest): { rule: Eip712Rule } | { reason: string } {
    const d = req.domain as Record<string, unknown>;
    const keys = Object.keys(d).filter((k) => d[k] !== undefined).sort();
    if (keys.join(",") !== "chainId,name,verifyingContract,version") return { reason: `domain fields must be exactly name, version, chainId, verifyingContract (got ${keys.join(",")})` };
    const chainId = typeof d.chainId === "bigint" ? Number(d.chainId) : d.chainId;
    if (typeof chainId !== "number" || !Number.isSafeInteger(chainId)) return { reason: "domain chainId is not an integer" };
    if (!PRODUCTION_SIGNING_ENABLED && (chainId === ROBINHOOD_CHAIN_ID || !LOCAL_DEV_CHAIN_IDS.has(chainId))) {
      return { reason: `PRODUCTION_SIGNING_ENABLED=false: chain ${chainId} is not a local dev chain` };
    }
    if (typeof d.verifyingContract !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(d.verifyingContract)) return { reason: "domain verifyingContract is not an address" };
    const rules = this.o.allowlist.filter((r): r is Eip712Rule => r.kind === "eip712" && r.primaryType === req.primaryType);
    if (rules.length === 0) return { reason: `primary type ${JSON.stringify(req.primaryType)} is not allowed for role ${this.role}` };
    const rule = rules.find(
      (r) => r.domain.name === d.name && r.domain.version === d.version && r.domain.chainId === chainId && r.domain.verifyingContract === getAddress(d.verifyingContract as string),
    );
    if (!rule) {
      const r0 = rules[0]!;
      if (chainId !== r0.domain.chainId) return { reason: `wrong chain ${chainId} (deployment chain ${r0.domain.chainId})` };
      if (getAddress(d.verifyingContract as string) !== r0.domain.verifyingContract) return { reason: `wrong verifying contract ${d.verifyingContract as string}` };
      return { reason: `domain name/version not allowed for ${req.primaryType}` };
    }
    if (!sameTypes(req.types, rule.types)) return { reason: `struct definitions for ${req.primaryType} differ from the canonical types` };
    const fields = new Set(rule.types[req.primaryType]!.map((f) => f.name));
    const extra = Object.keys(req.message).filter((k) => !fields.has(k));
    if (extra.length) return { reason: `message has fields outside ${req.primaryType}: ${extra.join(",")}` };
    return { rule };
  }

  /** Sign an allowlisted EIP-712 payload. The digest is recomputed here from canonical types. */
  async signTypedData(req: TypedDataRequest, meta: SignMeta): Promise<SignResult> {
    const correlationId = meta.correlationId ?? randomUUID();
    const d = (req.domain ?? {}) as Record<string, unknown>;
    const f: AuditFields = {
      payloadKind: "eip712",
      chainId: typeof d.chainId === "number" || typeof d.chainId === "bigint" ? Number(d.chainId) : null,
      verifyingContract: typeof d.verifyingContract === "string" ? d.verifyingContract : null,
      domainName: typeof d.name === "string" ? d.name : null,
      domainVersion: typeof d.version === "string" ? d.version : null,
      primaryType: typeof req.primaryType === "string" ? req.primaryType : null,
    };
    const m = this.matchEip712(req);
    if ("reason" in m) return this.deny(correlationId, meta, f, m.reason);
    const typed = { domain: { ...m.rule.domain }, types: m.rule.types, primaryType: m.rule.primaryType, message: req.message } as Parameters<typeof hashTypedData>[0];
    let digest: Hex;
    try {
      validateTypedData(typed as Parameters<typeof validateTypedData>[0]);
      digest = hashTypedData(typed);
    } catch (e) {
      return this.deny(correlationId, meta, f, `malformed ${m.rule.primaryType} message: ${(e as Error).message.split("\n")[0]}`);
    }
    return this.signChecked(digest, correlationId, meta, { ...f, digest });
  }

  /** Sign an EIP-191 personal message whose payload is exactly one 32-byte hash (evidence role only). */
  async signEip191Hash32(hash: Hex, meta: SignMeta): Promise<SignResult> {
    const correlationId = meta.correlationId ?? randomUUID();
    const f: AuditFields = { payloadKind: "eip191", chainId: this.o.chainId, primaryType: "EIP191(bytes32)" };
    if (!this.o.allowlist.some((r) => r.kind === "eip191-hash32")) return this.deny(correlationId, meta, f, "EIP-191 payloads are not allowed for this role");
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return this.deny(correlationId, meta, f, "EIP-191 payload must be exactly 32 bytes");
    if (!PRODUCTION_SIGNING_ENABLED && (this.o.chainId === ROBINHOOD_CHAIN_ID || !LOCAL_DEV_CHAIN_IDS.has(this.o.chainId))) {
      return this.deny(correlationId, meta, f, `PRODUCTION_SIGNING_ENABLED=false: chain ${this.o.chainId} is not a local dev chain`);
    }
    const digest = hashMessage({ raw: hash });
    return this.signChecked(digest, correlationId, meta, { ...f, digest });
  }

  private async signChecked(digest: Hex, correlationId: string, meta: SignMeta, f: AuditFields): Promise<SignResult> {
    const { db, role } = this.o;
    // 2. kill switch (env, then DB) and 3. key status — one query, every request.
    if (this.o.envKillSwitch.has(role) || this.o.envKillSwitch.has("all")) return this.deny(correlationId, meta, f, "kill switch engaged (FORGE_SIGNER_KILL_SWITCH)");
    const live = await liveSignerState(db, role, this.address);
    if (live.killed) return this.deny(correlationId, meta, f, `kill switch engaged${live.killReason ? `: ${live.killReason}` : ""}`, live.version);
    if (live.status !== "active") return this.deny(correlationId, meta, f, live.status ? `key version ${live.version} is ${live.status}` : "key is not enrolled for this role", live.version);
    // 4. startup verification (expected address, on-chain role holder, role separation).
    const gate = await this.o.verificationGate();
    if (gate) return this.deny(correlationId, meta, f, `role disabled: ${gate}`, live.version);
    // 5. rate limit.
    try {
      await rateLimit(db, `signer:${role}`, this.o.rateLimitPerHour, 3600);
    } catch (e) {
      if (e instanceof ForgeError && e.code === "RATE_LIMITED") return this.deny(correlationId, meta, f, "per-role signing rate limit exceeded", live.version, "RATE_LIMITED", 429);
      throw e;
    }
    // 6. replay / concurrency claim.
    const claim = await this.claim(digest, correlationId, meta, live.version);
    if (claim.kind === "deny") return this.deny(correlationId, meta, f, claim.reason, live.version, claim.code ?? "SIGNER_DENIED", 409);
    if (claim.kind === "stored") {
      await this.audit("allowed", correlationId, meta, f, "identical request: stored signature returned", live.version, true);
      return { digest, signature: claim.signature, correlationId, keyVersion: live.version, replayed: true };
    }
    // 7. custody.
    let signature: Hex;
    try {
      signature = await this.o.inner.signDigest(digest);
      const recovered = await recoverAddress({ hash: digest, signature });
      if (recovered !== this.address) throw new Error(`custody signature recovers to ${recovered}, not ${this.address}`);
    } catch (e) {
      await db.query("DELETE FROM signer_signatures WHERE role = $1 AND digest = $2 AND correlation_id = $3 AND state = 'pending'", [role, digest, correlationId]);
      await this.audit("failed", correlationId, meta, f, (e as Error).message.split("\n")[0]!, live.version);
      throw e;
    }
    await db.query("UPDATE signer_signatures SET state = 'signed', signature = $4, signed_at = now() WHERE role = $1 AND digest = $2 AND correlation_id = $3", [
      role,
      digest,
      correlationId,
      signature,
    ]);
    await this.audit("allowed", correlationId, meta, f, null, live.version);
    return { digest, signature, correlationId, keyVersion: live.version, replayed: false };
  }

  private async claim(
    digest: Hex,
    correlationId: string,
    meta: SignMeta,
    keyVersion: number | null,
  ): Promise<{ kind: "claimed" } | { kind: "stored"; signature: Hex } | { kind: "deny"; reason: string; code?: string }> {
    const { db, role } = this.o;
    const deadline = Date.now() + 10_000;
    for (;;) {
      const ins = await db.query<{ digest: string }>(
        `INSERT INTO signer_signatures(role, digest, idempotency_key, state, signer_address, key_version, correlation_id)
         VALUES ($1,$2,$3,'pending',$4,$5,$6) ON CONFLICT DO NOTHING RETURNING digest`,
        [role, digest, meta.idempotencyKey ?? null, this.address, keyVersion, correlationId],
      );
      if (ins.rows[0]) return { kind: "claimed" };
      const { rows } = await db.query<{ state: string; signature: Hex | null; signer_address: string; stale: boolean; idempotency_key: string | null }>(
        `SELECT state, signature, signer_address, idempotency_key, claimed_at < now() - ($3 || ' milliseconds')::interval AS stale
           FROM signer_signatures WHERE role = $1 AND digest = $2`,
        [role, digest, String(this.pendingStaleMs)],
      );
      const row = rows[0];
      if (!row) {
        // The conflict was the idempotency key, bound to a different payload.
        const other = await db.query("SELECT 1 FROM signer_signatures WHERE role = $1 AND idempotency_key = $2", [role, meta.idempotencyKey ?? null]);
        if (other.rows.length) return { kind: "deny", reason: "idempotency key already used for a different payload", code: "IDEMPOTENCY_KEY_REUSED" };
        continue; // the pending claim was released (custody failure) — retry the insert
      }
      if (getAddress(row.signer_address) !== this.address) return { kind: "deny", reason: `digest already signed by another key version (${row.signer_address})`, code: "REPLAY_REFUSED" };
      if (row.state === "signed" && row.signature) return { kind: "stored", signature: row.signature };
      if (row.stale) {
        // Abandoned claim (crashed instance): take it over atomically.
        const take = await db.query("UPDATE signer_signatures SET correlation_id = $3, claimed_at = now() WHERE role = $1 AND digest = $2 AND state = 'pending' AND claimed_at < now() - ($4 || ' milliseconds')::interval RETURNING digest", [
          role,
          digest,
          correlationId,
          String(this.pendingStaleMs),
        ]);
        if (take.rows[0]) return { kind: "claimed" };
        continue;
      }
      if (Date.now() > deadline) return { kind: "deny", reason: "an identical request is still being signed", code: "SIGNING_IN_PROGRESS" };
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
