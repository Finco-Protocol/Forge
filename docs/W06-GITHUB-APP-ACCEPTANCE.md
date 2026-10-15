# W06 — GitHub App acceptance matrix

**Status: `EXTERNAL_GITHUB_APP_CONFIGURATION_REQUIRED`.** No GitHub App is registered by this work, no real GitHub endpoint was written to, and nothing below is evidence for operator item B01. Every test in this document runs against an in-process fake GitHub (`apps/forge-web/test/helpers/fake-github.ts`) or against no GitHub at all. That evidence class is **`SANDBOX_NOT_EVIDENCE`**: it proves what the Forge code does when GitHub behaves in the stated way, not that GitHub, a registered App, its permissions or its webhook delivery behave that way. `pnpm ops:github-app-check` can only return `PASS` for a configuration read from `https://api.github.com`; against any other API URL it returns `SANDBOX_NOT_EVIDENCE` (exit 4) and with no credentials `EXTERNAL_CREDENTIALS_REQUIRED` (exit 3) — both asserted by a test below.

Scope: `apps/forge-web/src/server/github/{client,verify,webhooks,reconcile,app-readiness}.ts`, `POST /api/github/webhook`, `scripts/w05/github-app-check.ts`.

## 1. Acceptance matrix

Legend: **EXISTING** = already covered before W06 (file → test); **W06** = added by W06 (`unit/w06-github-acceptance.test.ts` = U, `integration/w06-github-recovery.test.ts` = R, `integration/w06-incident-drills.test.ts` = D). All EXISTING/W06 rows are `SANDBOX_NOT_EVIDENCE`.

| # | Control | What must hold | EXISTING coverage | W06 coverage | Residual (not provable here) |
|---|---|---|---|---|---|
| 1 | Least-privilege permissions | App has exactly Metadata:read + Contents:read; no account permissions; no write/admin anywhere; only the documented read-only `members` / `organization_members` extras are tolerated | `unit/w05-github-app.test.ts` "least-privilege live configuration passes", "any write/admin permission … fails" | U "least-privilege configuration matrix" (11 widening permissions × read/write, per-event necessity, webhook transport, extras never writable, sandbox never PASS); U "operator setup constant agrees with the policy and the docs" | That the **registered** App really has them (needs the live check, §3 step 9) |
| 2 | Installation token alone never proves admin | Admin is concluded only from the user's own token **and** the installation's view of the same user id | `integration/negative-identity.test.ts` "an installation token alone never proves admin"; "non-admin user is refused" | — | — |
| 3 | Webhook signature | HMAC-SHA256 over the raw body, constant-time, verified **before** parsing; audited; no state change on failure | `negative-identity` "bad signatures are rejected…"; `w05-incident-drills` §D1 | U "webhook signature": missing / empty / wrong secret / truncated / extra byte / `sha1=` / no prefix / upper-case hex / signature of a different body → 401 `BAD_SIGNATURE`, no delivery row, audit row per rejection; bad signature on unparseable body is 401 not a parser error | The secret's entropy/storage in the secret manager |
| 4 | Replay protection | A delivery GUID is processed at most once, forever; a replay never gives a second effect — even with a **different body** | `negative-identity` "duplicate deliveries processed exactly once"; `revocation` #6 | U "replayed GUID is a no-op even with a different body" (first body recorded, no revocation from the replayed `deleted`) | GitHub's retry/redelivery policy |
| 5 | Atomic processing / redelivery | A delivery that fails mid-processing is rolled back with its record, so GitHub's redelivery of the same GUID is processed exactly once | — | U "a delivery whose processing fails is rolled back entirely…" (error → no row → redelivery processed once → third time `duplicate`) | — |
| 6 | Header / size validation | Malformed `x-github-delivery` / `x-github-event` → 400; > 5 MiB → 413 | — | U "malformed delivery/event headers and oversize payloads" | — |
| 7 | Revocation (permission loss) | `member` removed/edited, `organization.member_removed`, `team`, `membership` revoke that user's proofs and queue `repo_revalidate`; reconcile catches a missed webhook | `revocation` #3, #4; `negative-identity` "reconciliation catches a missed webhook" | U "permission-affecting events … revoke … `added` does not" | — |
| 8 | Repository transfer | Proofs revoked immediately, repo marked ineligible, new owner recorded, on-chain binding revoked by the worker, old admin refused | `revocation` #1 (with measured latency); `negative-identity` "transferred repository" | U "repository transferred: proofs revoked, repo marked ineligible, one registry_revoke job"; U "transfer also records the NEW owner" | — |
| 9 | Installation removal / suspension | Every repository under the installation is invalidated, cached installation token dropped; repository removed from installation invalidated | `revocation` #2 (App uninstall → every covered repo revoked on chain); `negative-identity` "removed repository" | U table rows: `installation.deleted`, `installation.suspend`, `installation_repositories.removed`; U asserts `forgetInstallation(id)` is called | — |
| 10 | Archived / deleted / privatized | Narrow eligibility; privatized honours the private-repo policy flag | `negative-identity` "private and fork repositories follow the explicit eligibility policy" | U table rows `archived`, `deleted`, `privatized` (+ policy-allowed case does not narrow) | — |
| 11 | Events may only narrow | `installation.created`, `unsuspend`, `publicized`, `unarchived`, `renamed` never restore a revoked proof or enqueue work; only a fresh full verification clears `ineligible_reason` | `negative-identity` "rename preserves canonical identity" | U "events that could WIDEN eligibility never restore …"; D W-D1 (attacker with the leaked secret: widening events change nothing, then a fresh verification restores service) | — |
| 12 | Stale-proof invalidation | An expired or revoked verification is never a live proof; stale evidence is never reused for signing | `negative-identity` "stale GitHub evidence is never reused for authority signing" | U "an EXPIRED proof is not a live proof" and every narrowing row asserts zero live proofs remain | — |
| 13 | Rate limiting (GitHub API) | One bounded retry for secondary/primary limits; longer waits fail closed `GITHUB_RATE_LIMITED`; ordinary 403 is not a rate limit | `unit/w05-github-app.test.ts` "rate limits" (4 tests) | U "rate limiting: secondary and primary …; 429 without headers fails closed" | GitHub's actual limits for the App |
| 14 | Rate limiting (Forge API) | Trusted-proxy-aware limiter; spoofed `X-Forwarded-For` cannot multiply budgets | `revocation` "trusted-proxy policy and rate limiting" (3 tests) | — | Edge/WAF limits are operator work |
| 15 | Network-failure recovery | An outage / 5xx / 429 is **never** read as "absent" or "revoked", never lets a new verification through, and reconciliation converges once GitHub is back — including a genuine admin loss that happened during the outage | — | U "connection failures/timeouts on every call kind → `GITHUB_UNAVAILABLE`", "5xx is an error, not 'absent'", "recovery: next call succeeds, token not poisoned"; R (3 tests, real chain): reconcile under `down` / `http500` / `collab500` / `rate429` leaves the binding **active**, queues no revocation; new verification fails closed with no row; admin loss during outage is revoked on chain after recovery | Behaviour of the real GitHub edge |
| 16 | Installation-token rotation | A 401 mints exactly one fresh token; a second 401 propagates | `w05-github-app.test.ts` "installation-token rotation" | — | — |
| 17 | App compromise | Leaked webhook secret can only narrow; secret rotation kills the forged channel; lockdown is the immediate control | `w05-incident-drills` §D1 (forged webhook rejected + audited) | D W-D1 (full sequence on a real chain) | Rotating the real secret/key (operator, §3 steps 11–12) |
| 18 | Operator tool exit codes | no credentials → 3 `EXTERNAL_CREDENTIALS_REQUIRED`; non-github.com API → 4 `SANDBOX_NOT_EVIDENCE`; live → 0 / 1 | — | U "`ops:github-app-check` operator tool exit codes" (spawns the real CLI against no env and against a local fake API) | Exit 0/1 against live GitHub is by definition untested here |

### Observation (not fixed; product code untouched)
A correctly **signed** webhook whose body is not valid JSON makes `handleWebhook` throw a `SyntaxError` after signature verification, i.e. an HTTP 5xx rather than 400. No state is written (asserted in U). Impact: noise only (a legitimate GitHub never sends it); severity low.

## 2. Evidence classification

| Item | Class |
|---|---|
| Everything in §1 | `SANDBOX_NOT_EVIDENCE` (fake GitHub or none) |
| App registered, permissions/events exported, webhook live | `EXTERNAL_GITHUB_APP_CONFIGURATION_REQUIRED` (operator item B01) |
| Real redelivery / rate-limit behaviour of github.com | `UNVERIFIED` |

## 3. Operator setup (exact steps; nothing here is performed by W06)

Do this on a **staging** GitHub organization you control first. Never reuse the staging App for production. Every value comes from `OPERATOR_SETUP` in `src/server/github/app-readiness.ts` and `docs/W05-GITHUB-APP-OPERATIONS.md`.

1. Generate the webhook secret (≥ 32 random bytes) directly into your secret manager, never a terminal history: `openssl rand -hex 32`.
2. GitHub → *Settings → Developer settings → GitHub Apps → New GitHub App* (org-owned). Name = the value you will set as `GITHUB_APP_SLUG`.
3. Homepage URL = `<origin>`. **Callback URL** = `<origin>/api/auth/github/callback`. Check *Request user authorization (OAuth) during installation* and *Expire user authorization tokens*. **Setup URL** = `<origin>/api/github/setup`.
4. **Webhook**: Active; URL `<origin>/api/github/webhook` (https only); content type `application/json`; secret = step 1; **SSL verification: Enable**.
5. **Repository permissions**: *Metadata* → Read-only; *Contents* → Read-only. Everything else **No access**. **Account permissions**: none. (Optional read-only `Members` / `Organization members` is tolerated by the checker; leave off unless you need org webhooks.)
6. **Subscribe to events**: `installation`, `installation_repositories`, `repository`, `member`, `organization`, `team`, `membership`. Nothing else is required.
7. *Where can this GitHub App be installed?* → *Only on this account* (staging).
8. Create the App, then *Generate a private key* (PEM) straight into the secret manager. Note App ID, slug, client ID, client secret. Install it on the staging org, selecting **only selected repositories**.
9. Run the read-only acceptance check from `apps/forge-web` with the real values (it only calls `GET /app` and `GET /app/hook/config`):
   ```
   GITHUB_APP_ID=… GITHUB_APP_SLUG=… GITHUB_APP_PRIVATE_KEY="$(cat app.pem)" \
   FORGE_PUBLIC_ORIGIN=https://<staging-origin> pnpm ops:github-app-check --out github-app-check.json
   ```
   Expected: exit **0** and `"status": "PASS"` with all of `permission:metadata`, `permission:contents`, `least-privilege`, `no-write-access`, `webhook-events`, `webhook-url`, `webhook-https`, `webhook-content-type`, `webhook-ssl-verification`, `app-slug` = `PASS`. Exit 1 lists the failing check ids; exit 3 means credentials are missing; exit 4 means `GITHUB_API_URL` is not `https://api.github.com` (never evidence).
10. Delivery test: in the App's *Advanced → Recent Deliveries* redeliver a `ping`/`repository` event and confirm HTTP 200 from Forge; then redeliver the **same** delivery and confirm the body is `{"duplicate":true}`; send one request with a wrong secret (e.g. with `curl`) and confirm 401 and a `webhook_signature_rejected` row in `audit_events`.
11. Compromise drill (staging): rotate the webhook secret in GitHub and in the Forge environment, restart, redeliver an old delivery → 401. Regenerate the private key, revoke the old one in GitHub, restart, run step 9 again.
12. Record the B01 evidence: App id/slug, a permissions export (screenshot or `GET /app` JSON), the webhook URL, the `github-app-check.json` output and its SHA-256, signed by an allowlisted operator key (W05 release process). Until then B01 stays open.

## 4. Commands

```
cd apps/forge-web
npx vitest run --project unit test/unit/w06-github-acceptance.test.ts          # 32 tests
PATH=/tmp/fdry:$PATH npx vitest run --project integration test/integration/w06-github-recovery.test.ts   # 3 tests
```
