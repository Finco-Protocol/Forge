/**
 * W05 GitHub App operational readiness (pure evaluation).
 *
 * The App installation is NOT proof of repository administration (see
 * src/server/github/verify.ts: admin is concluded only from the signed-in
 * user's own token AND the installation's view of the same user id). The App
 * therefore needs the LEAST privilege: read-only repository metadata/contents
 * and read-only webhooks. Any write/admin permission is a failure.
 */
export const REQUIRED_PERMISSIONS: Record<string, "read"> = {
  metadata: "read",
  contents: "read",
};

/** Read-only extras tolerated (needed by org-level webhook events); anything writable is refused. */
export const OPTIONAL_READ_PERMISSIONS = new Set(["members", "organization_members"]);

export const REQUIRED_EVENTS = ["installation", "installation_repositories", "repository", "member", "organization", "team", "membership"] as const;

export interface AppConfigEvidence {
  source: "LIVE_GITHUB" | "SANDBOX";
  app: { id: number; slug: string; permissions: Record<string, string>; events: string[] };
  webhook: { url?: string | null; content_type?: string; insecure_ssl?: string | number } | null;
  expectedOrigin: string;
  expectedSlug: string;
}

export interface ReadinessCheck {
  id: string;
  status: "PASS" | "FAIL";
  detail: string;
}

export interface AppReadiness {
  /** PASS only for a fully compliant LIVE_GITHUB configuration. Sandbox results are never evidence. */
  status: "PASS" | "FAIL" | "SANDBOX_NOT_EVIDENCE" | "EXTERNAL_CREDENTIALS_REQUIRED";
  checks: ReadinessCheck[];
}

export function evaluateAppConfig(e: AppConfigEvidence): AppReadiness {
  const checks: ReadinessCheck[] = [];
  const add = (id: string, ok: boolean, detail: string) => checks.push({ id, status: ok ? "PASS" : "FAIL", detail });

  for (const [perm, level] of Object.entries(REQUIRED_PERMISSIONS)) {
    add(`permission:${perm}`, e.app.permissions[perm] === level, `${perm} must be ${level}, found ${e.app.permissions[perm] ?? "none"}`);
  }
  const excess = Object.entries(e.app.permissions).filter(([k, v]) => !(k in REQUIRED_PERMISSIONS) && !(v === "read" && OPTIONAL_READ_PERMISSIONS.has(k)));
  add("least-privilege", excess.length === 0, excess.length ? `unexpected permissions: ${excess.map(([k, v]) => `${k}:${v}`).join(", ")}` : "no permissions beyond the required read-only set");
  const writable = Object.entries(e.app.permissions).filter(([, v]) => v !== "read");
  add("no-write-access", writable.length === 0, writable.length ? `write/admin permissions: ${writable.map(([k, v]) => `${k}:${v}`).join(", ")}` : "App is read-only");

  const missing = REQUIRED_EVENTS.filter((x) => !e.app.events.includes(x));
  add("webhook-events", missing.length === 0, missing.length ? `missing events: ${missing.join(", ")}` : "all revocation-relevant events subscribed");

  const wh = e.webhook;
  const expectedUrl = `${e.expectedOrigin.replace(/\/$/, "")}/api/github/webhook`;
  add("webhook-url", wh?.url === expectedUrl, `expected ${expectedUrl}, found ${wh?.url ?? "none"}`);
  add("webhook-https", (wh?.url ?? "").startsWith("https://"), "webhook must be https");
  add("webhook-content-type", wh?.content_type === "json", `content_type must be json, found ${wh?.content_type ?? "none"}`);
  add("webhook-ssl-verification", String(wh?.insecure_ssl ?? "") === "0", "TLS verification must be enabled (insecure_ssl=0)");
  add("app-slug", e.app.slug === e.expectedSlug, `configured slug ${e.expectedSlug}, GitHub reports ${e.app.slug}`);

  const allPass = checks.every((c) => c.status === "PASS");
  if (e.source === "SANDBOX") return { status: "SANDBOX_NOT_EVIDENCE", checks };
  return { status: allPass ? "PASS" : "FAIL", checks };
}

/** Exact scopes + steps shown to operators (also written to docs/W05-GITHUB-APP-OPERATIONS.md). */
export const OPERATOR_SETUP = {
  repositoryPermissions: { Metadata: "Read-only", Contents: "Read-only" },
  accountPermissions: "none",
  requestUserAuthorizationDuringInstallation: true,
  expireUserAuthorizationTokens: true,
  callbackUrl: "<origin>/api/auth/github/callback",
  setupUrl: "<origin>/api/github/setup",
  webhookUrl: "<origin>/api/github/webhook",
  webhookEvents: [...REQUIRED_EVENTS],
};
