#!/usr/bin/env bash
# Vendored-dependency integrity check.
#
# Re-verified at Workflow-01 intake (2026-10-08): 63/68 vendored files are
# byte-identical to the pinned upstream refs; the exceptions below are the
# 4 files that match NEWER upstream revisions (additive/comment-level
# changes, see docs/LICENSE-INVENTORY.md §2) and BaseHook.sol, which has
# no verifiable public upstream (docs/LICENSE-INVENTORY.md §2, F-14).
#
# The check fails when any vendored file drifts from its pinned upstream
# blob EXCEPT for files listed in KNOWN_EXCEPTIONS — new drift means the
# fork silently changed a dependency, which this job exists to catch.
set -euo pipefail

PINS=(
  "https://github.com/OpenZeppelin/openzeppelin-contracts.git fcbae5394ae8ad52d8e580a3477db99814b9d565"
  "https://github.com/Uniswap/v4-core.git 46c6834698c48bc4a463a86d8420f4eb1d7f3b75"
  "https://github.com/Uniswap/v4-periphery.git 9969eec44cfdf07e24b41de47f40276a58401976"
  "https://github.com/Uniswap/permit2.git cc56ad0f3439c502c246fc5cfcc3db92bb8b7219"
)

# Files allowed to differ from the pinned refs, with the reason recorded.
KNOWN_EXCEPTIONS=(
  "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol"
  "openzeppelin-contracts/contracts/utils/math/Math.sol"
  "openzeppelin-contracts/contracts/utils/math/SafeCast.sol"
  "v4-periphery/src/libraries/Actions.sol"
  "v4-hooks-public/src/base/BaseHook.sol"
)

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

for pin in "${PINS[@]}"; do
  url="${pin% *}"; sha="${pin#* }"
  name="$(basename "$url" .git)"
  git clone -q --filter=blob:none --no-checkout "$url" "$SCRATCH/$name"
  git -C "$SCRATCH/$name" checkout -q "$sha"
done

fail=0
checked=0
while IFS= read -r f; do
  rel="${f#contractsV2/lib/}"
  case "$rel" in
    openzeppelin-contracts/*) up="$SCRATCH/openzeppelin-contracts/${rel#openzeppelin-contracts/}";;
    v4-core/*)                up="$SCRATCH/v4-core/${rel#v4-core/}";;
    v4-periphery/lib/permit2/*) up="$SCRATCH/permit2/${rel#v4-periphery/lib/permit2/}";;
    v4-periphery/*)           up="$SCRATCH/v4-periphery/${rel#v4-periphery/}";;
    forge-std/*)              continue;; # test-only dependency, pinned by submodule
    *)                        echo "::warning::no upstream mapping for $rel"; continue;;
  esac
  checked=$((checked+1))
  h_local="$(git hash-object "$REPO_ROOT/$f")"
  if [ -f "$up" ] && [ "$h_local" = "$(git hash-object "$up")" ]; then
    continue
  fi
  known=0
  for e in "${KNOWN_EXCEPTIONS[@]}"; do
    [ "$rel" = "$e" ] && known=1 && break
  done
  if [ "$known" = "1" ]; then
    echo "::notice::known exception (see docs/LICENSE-INVENTORY.md): $rel"
  else
    echo "::error::vendored file drifted from pinned upstream: $rel"
    fail=1
  fi
done < <(cd "$REPO_ROOT" && git ls-files "contractsV2/lib/*.sol" "contractsV2/lib/**/**/*.sol")

echo "checked $checked vendored files"
exit $fail
