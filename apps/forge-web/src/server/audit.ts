import type { Queryable } from "./db";

export async function audit(db: Queryable, actor: string, action: string, subject: string | null, detail: Record<string, unknown> = {}) {
  await db.query("INSERT INTO audit_events(actor, action, subject, detail) VALUES ($1,$2,$3,$4)", [
    actor,
    action,
    subject,
    JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  ]);
}
