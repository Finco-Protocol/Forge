#!/bin/sh
# W06 staging entrypoint. Loads the simulated-GitHub credentials the fake-github service wrote to the shared
# volume, validates the environment with the staging guard (exit 1 = refused, nothing started), then runs a role.
set -eu
if [ -f /sandbox/github.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /sandbox/github.env
  set +a
fi
# Service-side API calls go over the internal network; the browser-facing authorize URL is the published loopback port.
GITHUB_API_URL="${STAGING_GITHUB_API_URL:-${GITHUB_API_URL:-}}"
GITHUB_WEB_URL="${STAGING_GITHUB_WEB_URL:-${GITHUB_WEB_URL:-}}"
export GITHUB_API_URL GITHUB_WEB_URL
role="${1:-web}"
case "$role" in
  fake-github) ;;                                  # the simulated GitHub itself has no staging env to validate
  *) pnpm --silent staging:check ;;
esac
case "$role" in
  web)         exec pnpm exec next start -p "${PORT:-3000}" -H 0.0.0.0 ;;
  worker)      exec pnpm exec tsx scripts/worker.ts ;;
  migrate)     exec pnpm exec tsx scripts/migrate.ts ;;
  deploy)      exec pnpm exec tsx scripts/deploy-sandbox.ts ;;
  fake-github) exec pnpm exec tsx scripts/fake-github.ts ;;
  *)           echo "unknown role: $role" >&2; exit 2 ;;
esac
