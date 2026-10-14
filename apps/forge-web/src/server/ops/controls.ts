/**
 * W05 operator controls. These are IMMEDIATE, off-chain containment
 * switches; they complement — never replace — the on-chain controls, which
 * under a timelocked owner take effect only after the governance delay.
 *
 *   emergency_lockdown  refuses new launch drafts, launch authorizations,
 *                       creator-signature submission and NEW registry
 *                       bindings. Revocations, claims, indexing and
 *                       reconciliation keep running (they only narrow risk).
 *
 * Set from the environment (FORGE_EMERGENCY_LOCKDOWN=true, survives a DB
 * outage) or the database (scripts/w05/ops-control.ts; audited). There is
 * deliberately no HTTP endpoint that can change a control.
 */
import type { Queryable } from "../db";
import { audit } from "../audit";
import { refuse } from "../errors";

export type ControlKey = "emergency_lockdown";

export interface ControlState {
  active: boolean;
  source: "env" | "db" | "none";
  reason: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export async function readControl(db: Queryable, key: ControlKey, env: Record<string, string | undefined> = process.env): Promise<ControlState> {
  if (key === "emergency_lockdown" && /^(1|true)$/i.test(env.FORGE_EMERGENCY_LOCKDOWN ?? "")) {
    return { active: true, source: "env", reason: env.FORGE_EMERGENCY_LOCKDOWN_REASON ?? "FORGE_EMERGENCY_LOCKDOWN set", updatedBy: "environment", updatedAt: null };
  }
  const { rows } = await db.query<{ active: boolean; reason: string | null; updated_by: string | null; updated_at: Date }>(
    "SELECT active, reason, updated_by, updated_at FROM ops_controls WHERE key = $1",
    [key],
  );
  const r = rows[0];
  if (!r) return { active: false, source: "none", reason: null, updatedBy: null, updatedAt: null };
  return { active: r.active, source: "db", reason: r.reason, updatedBy: r.updated_by, updatedAt: r.updated_at.toISOString() };
}

export async function setControl(db: Queryable, key: ControlKey, active: boolean, reason: string, operator: string) {
  if (!reason.trim()) throw new Error("a reason is required");
  if (!operator.trim()) throw new Error("an operator identity is required");
  await db.query(
    `INSERT INTO ops_controls(key, active, reason, updated_by, updated_at) VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (key) DO UPDATE SET active = EXCLUDED.active, reason = EXCLUDED.reason, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, active, reason, operator],
  );
  await audit(db, `operator:${operator}`, active ? `ALERT:control_engaged:${key}` : `control_released:${key}`, key, { reason });
}

/** Throws EMERGENCY_LOCKDOWN (503) when the lockdown is engaged. */
export async function requireNotLockedDown(db: Queryable, what: string) {
  const s = await readControl(db, "emergency_lockdown");
  if (s.active) {
    await audit(db, "forge:ops", "lockdown_refusal", what, { reason: s.reason, source: s.source });
    refuse("EMERGENCY_LOCKDOWN", `Forge is in emergency lockdown: ${what} is temporarily disabled. Existing tokens, claims and revocations are unaffected.`, 503, {
      reason: s.reason,
    });
  }
}
