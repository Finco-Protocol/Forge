/**
 * W05 operator read endpoints. Disabled (404) unless FORGE_OPS_TOKEN is
 * configured; then a matching bearer token is required (constant-time
 * compare). Read-only: no endpoint can change an operator control.
 */
import { timingSafeEqual } from "node:crypto";
import type { AppContext } from "../context";
import { json } from "../http";
import { refuse } from "../errors";
import { ALERT_RULES, collectSignals, evaluateAlerts, toPrometheus } from "../ops/monitor";
import { readControl } from "../ops/controls";

function requireOpsToken(ctx: AppContext, req: Request) {
  const want = ctx.cfg.ops.token;
  if (!want) refuse("NOT_FOUND", "No such endpoint.", 404);
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got);
  const b = Buffer.from(want!);
  if (a.length !== b.length || !timingSafeEqual(a, b)) refuse("UNAUTHORIZED", "Operator token required.", 401);
}

export async function opsAlerts(ctx: AppContext, req: Request): Promise<Response> {
  requireOpsToken(ctx, req);
  const signals = await collectSignals(ctx, { finance: new URL(req.url).searchParams.get("finance") !== "0" });
  const firing = evaluateAlerts(signals);
  return json({ signals, firing, rules: ALERT_RULES, controls: { emergency_lockdown: await readControl(ctx.db, "emergency_lockdown") } });
}

export async function opsMetrics(ctx: AppContext, req: Request): Promise<Response> {
  requireOpsToken(ctx, req);
  const signals = await collectSignals(ctx, { finance: true });
  return new Response(toPrometheus(signals, evaluateAlerts(signals)), {
    headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" },
  });
}
