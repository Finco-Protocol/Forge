# W05 — GitHub App operations

**Status: EXTERNAL_CREDENTIALS_REQUIRED.** No production GitHub App is registered in this work and no live GitHub verification was performed. Tests use an in-process fake GitHub and are labelled `SANDBOX_NOT_EVIDENCE`; they are never evidence for B01.

## Exact configuration
- Repository permissions: Metadata read-only, Contents read-only. Account permissions: none.
- Subscribe to events: `installation`, `installation_repositories`, `repository`, `member`, `organization`, `team`, `membership`.
- Request user authorization during installation; expire user tokens.
- Callback `<origin>/api/auth/github/callback`; setup URL `<origin>/api/github/setup`; webhook `<origin>/api/github/webhook` (https, content type JSON, TLS verification on, secret ≥ 32 bytes in managed secrets).
- Private key in managed secrets; installation tokens are short-lived and rotated on 401 (`callAsInstallation`); primary rate limits fail closed with `GITHUB_RATE_LIMITED` after one bounded retry.

## Acceptance
`pnpm ops:github-app-check` (apps/forge-web) compares the live app (`GET /app`, installation permissions/events, webhook config) to the above. Exit 0 PASS, 1 FAIL, 3 `EXTERNAL_CREDENTIALS_REQUIRED` (no credentials), 4 sandbox source. Operator evidence for B01 = app id/slug, permissions export, webhook URL and the check output hash, signed by an allowlisted operator key.
