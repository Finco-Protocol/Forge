/**
 * Durable custody controls (migration 004_signer_audit.sql): key versions per
 * role (rotation/revocation) and the incident kill switch. Every change is
 * also written to the append-only audit_events table. These are operator
 * functions: no HTTP endpoint reaches them.
 */
import { getAddress, type Address } from "viem";
import { audit } from "../audit";
import { isUniqueViolation, type Db, type Queryable } from "../db";
import type { SignerRole } from "./allowlist";

export type KeyStatus = "active" | "retired" | "revoked";
export interface KeyVersion {
  role: SignerRole;
  version: number;
  address: Address;
  custody: string;
  key_ref: string | null;
  status: KeyStatus;
  status_reason: string | null;
}

const ACTOR = (who: string) => `forge:signer-ops:${who}`;

export async function keyByAddress(db: Queryable, address: Address): Promise<KeyVersion | null> {
  const { rows } = await db.query<KeyVersion>("SELECT role, version, address, custody, key_ref, status, status_reason FROM signer_keys WHERE address = $1", [getAddress(address)]);
  return rows[0] ?? null;
}

export async function activeKey(db: Queryable, role: SignerRole): Promise<KeyVersion | null> {
  const { rows } = await db.query<KeyVersion>("SELECT role, version, address, custody, key_ref, status, status_reason FROM signer_keys WHERE role = $1 AND status = 'active'", [role]);
  return rows[0] ?? null;
}

async function insertVersion(q: Queryable, role: SignerRole, address: Address, custody: string, keyRef: string | null, status: KeyStatus, by: string): Promise<number> {
  const { rows } = await q.query<{ version: number }>(
    `INSERT INTO signer_keys(role, version, address, custody, key_ref, status, changed_by)
     VALUES ($1, COALESCE((SELECT max(version) FROM signer_keys WHERE role = $1), 0) + 1, $2, $3, $4, $5, $6)
     RETURNING version`,
    [role, getAddress(address), custody, keyRef, status, by],
  );
  return rows[0]!.version;
}

export type EnrollOutcome =
  | { ok: true; version: number; enrolled: boolean }
  | { ok: false; reason: string; version: number | null };

/**
 * Startup enrollment of the configured key for `role`:
 *  - already the active version → ok;
 *  - retired/revoked → refused (never signs again);
 *  - enrolled for ANOTHER role → refused (strict role separation, durable);
 *  - unknown and the role has no active version → enrolled as the next active version;
 *  - unknown while another version is active → refused: rotation is explicit (rotateSignerKey).
 */
export async function enrollConfiguredKey(db: Db, role: SignerRole, address: Address, custody: string, keyRef: string | null): Promise<EnrollOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await keyByAddress(db, address);
    if (existing) {
      if (existing.role !== role) return { ok: false, reason: `key ${address} is enrolled for role ${existing.role}, not ${role}`, version: null };
      if (existing.status !== "active") return { ok: false, reason: `key version ${existing.version} is ${existing.status}${existing.status_reason ? ` (${existing.status_reason})` : ""}`, version: existing.version };
      return { ok: true, version: existing.version, enrolled: false };
    }
    const active = await activeKey(db, role);
    if (active) {
      return { ok: false, reason: `configured key ${address} is not the active ${role} version (active: v${active.version} ${active.address}); rotate explicitly`, version: null };
    }
    try {
      const version = await db.tx((q) => insertVersion(q, role, address, custody, keyRef, "active", "forge:signer-registry:startup"));
      await audit(db, "forge:signer-registry", "signer_key_enrolled", role, { address, version, custody, keyRef });
      return { ok: true, version, enrolled: true };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e; // a concurrent instance enrolled first: re-read
    }
  }
  return { ok: false, reason: "concurrent enrollment did not settle", version: null };
}

/** Rotation: the current active version becomes `retired` and `next` becomes the only `active` one, atomically. */
export async function rotateSignerKey(db: Db, role: SignerRole, next: { address: Address; custody: string; keyRef: string | null }, by: string, reason: string): Promise<number> {
  const version = await db.tx(async (q) => {
    await q.query("UPDATE signer_keys SET status = 'retired', status_reason = $2, changed_by = $3, status_changed_at = now() WHERE role = $1 AND status = 'active'", [role, `rotated: ${reason}`, ACTOR(by)]);
    const { rows } = await q.query<KeyVersion>("SELECT role, version, status FROM signer_keys WHERE address = $1", [getAddress(next.address)]);
    const row = rows[0];
    if (row) throw new Error(`key ${next.address} is already enrolled (role ${row.role} v${row.version}, ${row.status}); a key version is never reused`);
    return insertVersion(q, role, next.address, next.custody, next.keyRef, "active", ACTOR(by));
  });
  await audit(db, ACTOR(by), "signer_key_rotated", role, { address: getAddress(next.address), version, reason });
  return version;
}

/** Revocation is immediate and terminal: the next sign by that key is refused (checked on every request). */
export async function revokeSignerKey(db: Db, role: SignerRole, address: Address, by: string, reason: string): Promise<void> {
  const { rows } = await db.query<{ version: number }>(
    "UPDATE signer_keys SET status = 'revoked', status_reason = $3, changed_by = $4, status_changed_at = now() WHERE role = $1 AND address = $2 RETURNING version",
    [role, getAddress(address), reason, ACTOR(by)],
  );
  if (!rows[0]) {
    // Never seen: record it as revoked so it can never be enrolled later.
    await db.tx((q) => insertVersion(q, role, address, "unknown", null, "revoked", ACTOR(by)));
  }
  await audit(db, ACTOR(by), "ALERT:signer_key_revoked", role, { address: getAddress(address), reason });
}

export type KillScope = SignerRole | "all";

export async function engageKillSwitch(db: Queryable, scope: KillScope, by: string, reason: string): Promise<void> {
  await db.query(
    `INSERT INTO signer_kill_switch(role, engaged, reason, updated_by) VALUES ($1, true, $2, $3)
     ON CONFLICT (role) DO UPDATE SET engaged = true, reason = $2, updated_by = $3, updated_at = now()`,
    [scope, reason, ACTOR(by)],
  );
  await audit(db, ACTOR(by), "ALERT:signer_kill_switch_engaged", scope, { reason });
}

export async function releaseKillSwitch(db: Queryable, scope: KillScope, by: string, reason: string): Promise<void> {
  await db.query("UPDATE signer_kill_switch SET engaged = false, reason = $2, updated_by = $3, updated_at = now() WHERE role = $1", [scope, reason, ACTOR(by)]);
  await audit(db, ACTOR(by), "signer_kill_switch_released", scope, { reason });
}

/** One round trip, evaluated on every sign: key status for (role, address) and whether a kill switch covers the role. */
export async function liveSignerState(db: Queryable, role: SignerRole, address: Address): Promise<{ status: KeyStatus | null; version: number | null; killed: boolean; killReason: string | null }> {
  const { rows } = await db.query<{ status: KeyStatus | null; version: number | null; kill_reason: string | null; killed: boolean }>(
    `SELECT (SELECT status FROM signer_keys WHERE role = $1 AND address = $2) AS status,
            (SELECT version FROM signer_keys WHERE role = $1 AND address = $2) AS version,
            EXISTS (SELECT 1 FROM signer_kill_switch WHERE role IN ($1, 'all') AND engaged) AS killed,
            (SELECT reason FROM signer_kill_switch WHERE role IN ($1, 'all') AND engaged ORDER BY updated_at DESC LIMIT 1) AS kill_reason`,
    [role, getAddress(address)],
  );
  const r = rows[0]!;
  return { status: r.status, version: r.version, killed: r.killed, killReason: r.kill_reason };
}
