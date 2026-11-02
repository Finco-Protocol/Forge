#!/usr/bin/env bash
# W09 RC1 clean-build evidence collection for ONE fresh checkout.
# Usage: build-and-hash.sh <clone-dir> <out-json>
set -euo pipefail
CLONE="$1"; OUT="$2"
export PATH="$HOME/.foundry/bin:$PATH"
cd "$CLONE"
SHA=$(git rev-parse HEAD); TREE=$(git rev-parse HEAD^{tree})
NODE_V=$(node -v); PNPM_V=$(corepack pnpm --version); FORGE_V=$(forge --version | sed -n "s/^forge Version: //p")
echo "[build] $CLONE @ $SHA node=$NODE_V pnpm=$PNPM_V forge=$FORGE_V"

# Foundry profiles (deployed, forge, v1, testable) from a CLEAN state
rm -rf cache out out-testable out-v1 out-deployed out-forge 2>/dev/null || true
for P in deployed forge v1 testable; do
  forge build --profile "$P" > /tmp/rc1/forge-$P.log 2>&1 || { echo "forge $P FAILED"; tail -5 /tmp/rc1/forge-$P.log; exit 1; }
  echo "[build] forge profile $P ok"
done

# Web production build with frozen lockfile
cd apps/forge-web
corepack pnpm install --frozen-lockfile > /tmp/rc1/pnpm-install.log 2>&1
corepack pnpm exec tsx scripts/gen-abis.ts --check > /tmp/rc1/abi-check.log 2>&1 || { echo "ABI CHECK FAILED"; tail -5 /tmp/rc1/abi-check.log; exit 1; }
corepack pnpm build > /tmp/rc1/next-build.log 2>&1 || { echo "next build FAILED"; tail -8 /tmp/rc1/next-build.log; exit 1; }
echo "[build] web build ok"

# Hash artifacts (forge out dirs + .next excluding cache + lockfile + submodules)
cd "$CLONE"
HASHES=$( {
  find out out-testable out-v1 out-deployed out-forge -type f 2>/dev/null | sort | while read -r f; do printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"; done
  find apps/forge-web/.next -path apps/forge-web/.next/cache -prune -o -type f -print 2>/dev/null | sort | while read -r f; do printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"; done
  printf '%s  apps/forge-web/pnpm-lock.yaml\n' "$(sha256sum apps/forge-web/pnpm-lock.yaml | cut -d' ' -f1)"
} )
SUBMODULES=$(git submodule status | awk '{print $2"@"$1}')
{
  printf '{\n  "sha": "%s",\n  "tree": "%s",\n  "toolchain": {"node": "%s", "pnpm": "%s", "foundry": "%s", "os": "%s"},\n  "submodules": "%s",\n  "lockfileSha256": "%s",\n  "artifactCount": %s\n}\n' \
    "$SHA" "$TREE" "$NODE_V" "$PNPM_V" "$FORGE_V" "$(uname -s)" "$SUBMODULES" \
    "$(echo "$HASHES" | grep 'pnpm-lock' | cut -d' ' -f1)" \
    "$(echo "$HASHES" | wc -l)"
} > "$OUT"
printf '%s\n' "$HASHES" > "$OUT.hashes"
echo "[build] evidence written: $OUT ($(echo "$HASHES" | wc -l) hashed files)"
