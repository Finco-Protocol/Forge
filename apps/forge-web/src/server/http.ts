import { ForgeError } from "./errors";

export function json(body: unknown, init: ResponseInit = {}, cookies: string[] = []): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), { ...init, headers });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ForgeError) {
    return json({ error: { code: err.code, message: err.message, detail: err.detail ?? null } }, { status: err.status });
  }
  // Unknown failures never leak internals (keys, tokens, stack traces).
  console.error("[forge] unhandled", err);
  return json({ error: { code: "INTERNAL", message: "Internal error." } }, { status: 500 });
}

export function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function serializeCookie(name: string, value: string, opts: { httpOnly: boolean; secure: boolean; maxAge: number }): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${opts.maxAge}`,
    "SameSite=Lax",
    opts.httpOnly ? "HttpOnly" : "",
    opts.secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export async function readJson<T = Record<string, unknown>>(req: Request, maxBytes = 64 * 1024): Promise<T> {
  const text = await req.text();
  if (text.length > maxBytes) throw new ForgeError("PAYLOAD_TOO_LARGE", "Request body too large.", 413);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ForgeError("BAD_JSON", "Request body must be JSON.");
  }
}
