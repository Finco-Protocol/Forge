/**
 * W05 structured logging: one JSON object per line on stdout/stderr with a
 * correlation id. Never logs secrets, tokens, cookies, signatures or keys —
 * callers pass only identifiers and outcomes.
 */
import { randomUUID } from "node:crypto";

const ID = /^[A-Za-z0-9_.:-]{8,80}$/;

export function correlationIdFor(req: Request): string {
  const supplied = req.headers.get("x-correlation-id");
  return supplied && ID.test(supplied) ? supplied : randomUUID();
}

const REDACT = /(token|secret|password|signature|private|cookie|authorization|key)/i;

export function logEvent(level: "debug" | "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}) {
  const safe = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, REDACT.test(k) ? "[redacted]" : typeof v === "bigint" ? v.toString() : v]));
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...safe });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}
