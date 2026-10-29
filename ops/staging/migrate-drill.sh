#!/bin/sh
# W08 migration-drift drill: load the SIMULATED-GitHub test credentials exactly
# like the staging entrypoint (set -a / . / set +a), then run the real migrate
# implementation against DATABASE_URL. The drill passes a drifted clone and
# requires the specific MIGRATION_DRIFT diagnostic; the control run passes the
# untampered clone. Test-only values; never real credentials.
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
exec pnpm exec tsx scripts/migrate.ts
