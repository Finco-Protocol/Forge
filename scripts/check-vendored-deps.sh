#!/usr/bin/env bash
# Vendored-dependency integrity check (Correction A / A5).
#
# Every tracked vendored Solidity file MUST have a row in
# scripts/vendor-pins.tsv. Categories are mutually exclusive:
#
#   BYTE_IDENTICAL  byte-for-byte equal to the pinned upstream reference
#   WHITESPACE_ONLY whitespace-only difference from the pinned upstream
#                   reference (semantically identical; verified with
#                   `diff -w`)
#   UNRESOLVED      no public upstream could be located (BaseHook.sol).
#                   Allowed but reported loudly; the current content hash
#                   is pinned, so any edit to the file is still detected.
#
# The check fails when:
#   - a tracked vendor .sol file has no pin row (new/unpinned file),
#   - a pin row references a file that no longer exists,
#   - a BYTE_IDENTICAL file no longer matches its pinned reference,
#   - a WHITESPACE_ONLY file acquires any non-whitespace difference,
#   - an UNRESOLVED file's content hash drifts from its pinned hash,
#   - the forge-std submodule SHA drifts from the pinned SHA,
#   - the total pinned count changes.
# A new upstream sync therefore requires regenerating the pin table and
# review — silent drift is impossible.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PINS="$REPO_ROOT/scripts/vendor-pins.tsv"
FORGE_STD_PIN="f3dae6e6ee381f25eb6a246f7da9b85c91a68219" # forge-std v1.17.0
EXPECTED_TOTAL=89
CACHE="${VENDOR_REF_CACHE:-$(mktemp -d)}"
trap 'rm -rf "$CACHE"' EXIT

fetch_ref() { # $1=url $2=ref(tag or full sha) $3=dest
  local url="$1" ref="$2" dest="$CACHE/$3"
  [ -d "$dest/.git" ] && return 0
  if git clone -q --depth 1 --branch "$ref" --filter=blob:none "$url" "$dest" 2>/dev/null; then
    return 0
  fi
  # ref is a commit SHA (or a tag the --branch flag rejected): fetch by sha
  git clone -q --filter=blob:none --no-checkout "$url" "$dest"
  git -C "$dest" fetch -q --depth 1 origin "$ref"
  git -C "$dest" checkout -q FETCH_HEAD
}

# Pinned upstream references (see scripts/vendor-pins.tsv evidence column).
fetch_ref https://github.com/OpenZeppelin/openzeppelin-contracts.git v5.0.2 oz-v5.0.2
fetch_ref https://github.com/OpenZeppelin/openzeppelin-contracts.git v5.1.0 oz-v5.1.0
fetch_ref https://github.com/OpenZeppelin/openzeppelin-contracts.git v5.5.0 oz-v5.5.0
fetch_ref https://github.com/OpenZeppelin/openzeppelin-contracts.git v5.6.0 oz-v5.6.0
fetch_ref https://github.com/OpenZeppelin/openzeppelin-contracts.git dab8611521b481c8801ef7811eec5f9661869ce1 oz-dab86115
fetch_ref https://github.com/Uniswap/v4-core.git 46c6834698c48bc4a463a86d8420f4eb1d7f3b75 v4-core
fetch_ref https://github.com/Uniswap/v4-periphery.git 9969eec44cfdf07e24b41de47f40276a58401976 v4-periphery
fetch_ref https://github.com/Uniswap/v4-periphery.git 363226d9e1e2180b67bf6857023dbaad751010c5 v4-periphery-363226d
fetch_ref https://github.com/Uniswap/permit2.git cc56ad0f3439c502c246fc5cfcc3db92bb8b7219 permit2

refdir() {
  case "$1" in
    "OZ v5.0.2") echo "$CACHE/oz-v5.0.2";;
    "OZ v5.1.0") echo "$CACHE/oz-v5.1.0";;
    "OZ v5.5.0") echo "$CACHE/oz-v5.5.0";;
    "OZ v5.6.0") echo "$CACHE/oz-v5.6.0";;
    "OZ master@dab86115") echo "$CACHE/oz-dab86115";;
    "v4-core@46c6834698c48bc4a463a86d8420f4eb1d7f3b75") echo "$CACHE/v4-core";;
    "periphery@9969eec44cfdf07e24b41de47f40276a58401976") echo "$CACHE/v4-periphery";;
    "periphery@363226d9e1e2180b67bf6857023dbaad751010c5") echo "$CACHE/v4-periphery-363226d";;
    "permit2@cc56ad0f3439c502c246fc5cfcc3db92bb8b7219") echo "$CACHE/permit2";;
    *) echo "";;
  esac
}

upstream_rel() { # repo-relative vendored path -> path inside the upstream tree
  case "$1" in
    contractsV1/lib/openzeppelin-contracts/*) echo "${1#contractsV1/lib/openzeppelin-contracts/}";;
    contractsV2/lib/openzeppelin-contracts/*) echo "${1#contractsV2/lib/openzeppelin-contracts/}";;
    contractsV2/lib/v4-core/*) echo "${1#contractsV2/lib/v4-core/}";;
    contractsV2/lib/v4-periphery/lib/permit2/*) echo "${1#contractsV2/lib/v4-periphery/lib/permit2/}";;
    contractsV2/lib/v4-periphery/*) echo "${1#contractsV2/lib/v4-periphery/}";;
    contractsV2/lib/v4-hooks-public/*) echo "${1#contractsV2/lib/v4-hooks-public/}";;
    *) echo "";;
  esac
}

fail=0

# 1. Every tracked vendor .sol must be pinned.
while IFS= read -r f; do
  if ! grep -q "^$f	" "$PINS"; then
    echo "::error::unpinned vendored file (add a pin row after review): $f"
    fail=1
  fi
done < <(cd "$REPO_ROOT" && git ls-files "contractsV1/lib" "contractsV2/lib" | grep "\.sol$")

# 2. Verify every pin row against repository content (single pass; verdicts
# collected in a file because the read loop runs in the main shell).
verdicts="$(mktemp)"
tail -n +2 "$PINS" | while IFS=$'\t' read -r path class ref evidence localblob; do
  abs="$REPO_ROOT/$path"
  if [ ! -f "$abs" ]; then echo "deleted:$path" >> "$verdicts"; continue; fi
  rd="$(refdir "$ref")"
  uprel="$(upstream_rel "$path")"
  case "$class" in
    BYTE_IDENTICAL)
      if [ -z "$rd" ] || [ -z "$uprel" ] || [ ! -f "$rd/$uprel" ]; then
        echo "unresolvable:$path" >> "$verdicts"
      elif [ "$(git hash-object "$abs")" = "$(git hash-object "$rd/$uprel")" ]; then
        echo "ok-byte:$path" >> "$verdicts"
      else
        echo "drift:$path" >> "$verdicts"
      fi;;
    WHITESPACE_ONLY)
      if [ -z "$rd" ] || [ -z "$uprel" ] || [ ! -f "$rd/$uprel" ]; then
        echo "unresolvable:$path" >> "$verdicts"
      elif diff -w "$rd/$uprel" "$abs" | grep -q "^[<>]"; then
        echo "drift:$path" >> "$verdicts"
      else
        echo "ok-ws:$path" >> "$verdicts"
      fi;;
    UNRESOLVED)
      if [ "$(git hash-object "$abs")" = "$localblob" ]; then
        echo "ok:$path" >> "$verdicts"
        echo "::notice::UNRESOLVED provenance (allowed, pinned to current content $localblob): $path" >&2
      else
        echo "drift:$path" >> "$verdicts"
      fi;;
    *)
      echo "badclass:$path" >> "$verdicts";;
  esac
done

byte=$(grep -c "^ok-byte:" "$verdicts" || true)
wsok=$(grep -c "^ok-ws:" "$verdicts" || true)
unresok=$(grep -c "^ok-unresolved:" "$verdicts" || true)
drifted=$(grep '^drift:' "$verdicts" || true)
deleted=$(grep '^deleted:' "$verdicts" || true)
unresolvable=$(grep '^unresolvable:' "$verdicts" || true)
badclass=$(grep '^badclass:' "$verdicts" || true)
ws=$(tail -n +2 "$PINS" | awk -F'\t' '$2=="WHITESPACE_ONLY"' | wc -l)
unresolved=$(tail -n +2 "$PINS" | awk -F'\t' '$2=="UNRESOLVED"' | wc -l)

[ -n "$drifted" ] && { echo "::error::vendored dependency drift (requires review and re-pinning):"; echo "$drifted"; fail=1; }
[ -n "$deleted" ] && { echo "::error::pin rows reference deleted files:"; echo "$deleted"; fail=1; }
[ -n "$unresolvable" ] && { echo "::error::pinned references not resolvable:"; echo "$unresolvable"; fail=1; }
[ -n "$badclass" ] && { echo "::error::unknown pin classes:"; echo "$badclass"; fail=1; }

# 3. forge-std submodule pin (test-only dependency).
sub="$(git -C "$REPO_ROOT" ls-files -s contractsV2/lib/forge-std | awk '{print $2}')"
if [ "$sub" != "$FORGE_STD_PIN" ]; then
  echo "::error::forge-std submodule SHA $sub != pinned $FORGE_STD_PIN"; fail=1
fi

total=$((byte + ws + unresolved))
echo "vendored .sol files: $total verified (byte-identical: $byte, whitespace-only: $ws, unresolved provenance: $unresolved)"
echo "forge-std submodule: $sub (pinned, test-only)"
if [ "$total" -ne "$EXPECTED_TOTAL" ]; then
  echo "::error::expected $EXPECTED_TOTAL pinned vendored files, found $total — inventory changed, review required"; fail=1
fi
[ "$fail" -eq 0 ] && echo "DEPENDENCY_INTEGRITY_OK"
exit "$fail"
