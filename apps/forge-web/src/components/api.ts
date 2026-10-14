"use client";

export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number, public readonly detail: unknown) {
    super(message);
  }
}

function csrf(): string {
  const m = /(?:^|;\s*)forge_csrf=([^;]+)/.exec(typeof document === "undefined" ? "" : document.cookie);
  return m ? decodeURIComponent(m[1]!) : "";
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-forge-csrf": csrf() },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (json as { error?: { code: string; message: string; detail: unknown } }).error;
    throw new ApiError(e?.code ?? "HTTP_" + res.status, e?.message ?? `Request failed (${res.status})`, res.status, e?.detail);
  }
  return json as T;
}

export const short = (v?: string | null, n = 6) => (v ? `${v.slice(0, n)}…${v.slice(-4)}` : "—");

export function formatUnits18(v?: string | null, digits = 4): string {
  if (v === null || v === undefined || v === "") return "—";
  const b = BigInt(v);
  const whole = b / 10n ** 18n;
  const frac = (b % 10n ** 18n).toString().padStart(18, "0").slice(0, digits).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export const bps = (v: number | string) => `${(Number(v) / 100).toFixed(2)}%`;

/** Formats base units with the asset's OWN decimals. Never converts between assets. */
export function formatUnits(v?: string | null, decimals = 18, digits = 6): string {
  if (v === null || v === undefined || v === "") return "—";
  const b = BigInt(v);
  const neg = b < 0n;
  const abs = neg ? -b : b;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  const frac = (abs % unit).toString().padStart(decimals, "0").slice(0, digits).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

export interface AssetInfo {
  asset: string;
  symbol: string;
  decimals: number;
  native: boolean;
}

export const amt = (v: string | null | undefined, a?: AssetInfo | null) => `${formatUnits(v, a?.decimals ?? 18)} ${a?.symbol ?? ""}`.trim();

export function ago(ts?: string | number | null): string {
  if (!ts) return "—";
  const t = typeof ts === "number" || /^\d+$/.test(String(ts)) ? Number(ts) * 1000 : Date.parse(String(ts));
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
