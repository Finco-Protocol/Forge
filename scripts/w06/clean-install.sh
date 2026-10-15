#!/bin/sh
# W06: clean-install proof. Exports the COMMITTED tree (git archive HEAD) into an empty directory, installs with the
# frozen lockfile, type-checks, lints, runs the unit suite and builds the production bundle. Nothing from the working
# tree (node_modules, .next, out/) is reused. Usage: sh scripts/w06/clean-install.sh [workdir]
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${1:-$(mktemp -d)}"
mkdir -p "$WORK"
if [ -n "$(ls -A "$WORK")" ]; then
  echo "[clean-install] workdir $WORK is not empty (a clean install must start from nothing)" >&2
  exit 1
fi
echo "[clean-install] exporting HEAD $(git -C "$ROOT" rev-parse HEAD) to $WORK"
git -C "$ROOT" archive HEAD | tar -x -C "$WORK"
cd "$WORK/apps/forge-web"
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
echo "[clean-install] OK"
