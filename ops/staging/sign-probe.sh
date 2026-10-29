#!/bin/sh
# W08 RPC-outage drill signing probe: load the SIMULATED-GitHub test credentials
# exactly like the staging entrypoint, then run scripts/sign-probe.ts, which
# creates the app context and attempts a REAL custody signing request through
# the production signing-policy guard. Test-only values; never real credentials.
set -eu
if [ ! -f /sandbox/github.env ]; then
  echo "MISSING /sandbox/github.env" >&2
  exit 3
fi
set -a
. /sandbox/github.env
set +a
GITHUB_API_URL="${STAGING_GITHUB_API_URL:-${GITHUB_API_URL:-}}"
GITHUB_WEB_URL="${STAGING_GITHUB_WEB_URL:-${GITHUB_WEB_URL:-}}"
export GITHUB_API_URL GITHUB_WEB_URL
exec pnpm exec tsx scripts/sign-probe.ts
