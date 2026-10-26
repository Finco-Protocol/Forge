#!/bin/sh
# W07 compose backup/restore verification: load the SIMULATED-GitHub test
# credentials exactly like the staging entrypoint (set -a / . / set +a), pass
# the staging guard, then print the canonical ledger digests, row counts and
# applied migrations of DATABASE_URL as one JSON payload. Test-only values;
# never real GitHub App credentials.
set -eu
if [ ! -f /sandbox/github.env ]; then
  echo "MISSING /sandbox/github.env (the fake-github service did not write the test credentials)" >&2
  exit 3
fi
set -a
. /sandbox/github.env
set +a
GITHUB_API_URL="${STAGING_GITHUB_API_URL:-${GITHUB_API_URL:-}}"
GITHUB_WEB_URL="${STAGING_GITHUB_WEB_URL:-${GITHUB_WEB_URL:-}}"
export GITHUB_API_URL GITHUB_WEB_URL
pnpm --silent staging:check
exec pnpm --silent exec tsx scripts/w06/staging-ops.ts digest
