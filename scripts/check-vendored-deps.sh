#!/usr/bin/env bash
# Vendored-dependency integrity check (Correction B2 accounting).
#
# Every tracked vendored Solidity file MUST have exactly one row in
# scripts/vendor-pins.tsv. Pin categories are mutually exclusive:
#
#   BYTE_IDENTICAL  byte-for-byte equal to the pinned upstream reference
#   WHITESPACE_ONLY whitespace-only difference from the pinned upstream
#                   reference (semantically identical; verified with
#                   `diff -w`)
#   UNRESOLVED      no public upstream could be located (BaseHook.sol).
#                   Allowed but reported loudly; the current content hash
#                   is pinned, so any edit to the file is still detected.
#
# The check FAILS when any of the following holds (all detected
# explicitly, never inferred from a partial pass):
#   - a tracked vendor .sol file has no pin row (unpinned/missing record),
#   - a pin row references a file that does not exist or is not tracked
#     (added/phantom record),
#   - a pin row is malformed (field count) or duplicates another row,
#   - a pin row uses an unknown class,
#   - a BYTE_IDENTICAL file no longer matches its pinned reference,
#   - a WHITESPACE_ONLY file acquires any non-whitespace difference,
#   - an UNRESOLVED file's content hash drifts from its pinned hash,
#   - validated per-category counts disagree with the manifest counts,
#   - the forge-std submodule SHA drifts from the pinned SHA,
#   - the total pinned count changes.
# A new upstream sync therefore requires regenerating the pin table and
# review — silent drift is impossible.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PINS="${VENDOR_PINS_FILE:-$REPO_ROOT/scripts/vendor-pins.tsv}"
FORGE_STD_PIN="f3dae6e6ee381f25eb6a246f7da9b85c91a68219" # forge-std v1.17.0
EXPECTED_TOTAL=89
CACHE="${VENDOR_REF_CACHE:-$(mktemp -d)}"
trap 'rm -rf "$CACHE"' EXIT

fail=0
note() { echo "::error::$*"; fail=1; }

# ── 0. Manifest hygiene ──────────────────────────────────────────────────
if [ ! -f "$PINS" ]; then
  echo "::error::pin manifest not found: $PINS"; exit 1
fi

# 0a. Malformed rows (must be exactly 5 tab-separated fields; header aside).
malformed=$(tail -n +2 "$PINS" | awk -F'\t' 'NF != 5 { print NR + 1 ": " $0 }' || true)
[ -n "$malformed" ] && { note "malformed pin rows (need 5 tab-separated fields):"; echo "$malformed"; }

# 0b. Duplicate paths.
dupes=$(tail -n +2 "$PINS" | cut -f1 | sort | uniq -d || true)
[ -n "$dupes" ] && { note "duplicate pin rows for:"; echo "$dupes"; }

# 0c. Unknown classes.
badclass=$(tail -n +2 "$PINS" | awk -F'\t' '$2 != "BYTE_IDENTICAL" && $2 != "WHITESPACE_ONLY" && $2 != "UNRESOLVED" { print $1 ": " $2 }' || true)
[ -n "$badclass" ] && { note "unknown pin classes:"; echo "$badclass"; }

# 0d. Manifest category counts (declarations).
manifest_byte=$(tail -n +2 "$PINS" | awk -F'\t' '$2=="BYTE_IDENTICAL"' | wc -l)
manifest_ws=$(tail -n +2 "$PINS" | awk -F'\t' '$2=="WHITESPACE_ONLY"' | wc -l)
manifest_unres=$(tail -n +2 "$PINS" | awk -F'\t' '$2=="UNRESOLVED"' | wc -l)
manifest_total=$(tail -n +2 "$PINS" | wc -l)

# ── 1. Fetch pinned upstream references ─────────────────────────────────
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

# ── 2. Coverage: tracked files vs pin rows ──────────────────────────────
tracked="$(cd "$REPO_ROOT" && git ls-files "contractsV1/lib" "contractsV2/lib" | grep "\.sol$")"
tracked_count=$(printf '%s\n' "$tracked" | grep -c . || true)

# 2a. Every tracked vendor .sol must be pinned (missing records).
while IFS= read -r f; do
  [ -z "$f" ] && continue
  grep -q "^$f	" "$PINS" || note "unpinned vendored file (add a pin row after review): $f"
done <<< "$tracked"

# 2b. Every pin row must point at a tracked file (added/phantom records).
while IFS=$'\t' read -r path class ref evidence localblob; do
  [ "$path" = "path" ] && continue
  if ! printf '%s\n' "$tracked" | grep -qxF "$path"; then
    note "pin row references a non-existent or untracked file (added/phantom record): $path"
  fi
done < "$PINS"

# ── 3. Verify every pin row; success markers are class-specific ─────────
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
        echo "ok-unres:$path" >> "$verdicts"
        echo "::notice::UNRESOLVED provenance (allowed, pinned to current content $localblob): $path" >&2
      else
        echo "drift:$path" >> "$verdicts"
      fi;;
  esac
done

ok_byte=$(grep -c "^ok-byte:" "$verdicts" || true)
ok_ws=$(grep -c "^ok-ws:" "$verdicts" || true)
ok_unres=$(grep -c "^ok-unres:" "$verdicts" || true)
ok_total=$((ok_byte + ok_ws + ok_unres))
drifted=$(grep '^drift:' "$verdicts" || true)
deleted=$(grep '^deleted:' "$verdicts" || true)
unresolvable=$(grep '^unresolvable:' "$verdicts" || true)

[ -n "$drifted" ] && { note "vendored dependency drift (requires review and re-pinning):"; echo "$drifted"; }
[ -n "$deleted" ] && { note "pin rows reference missing files:"; echo "$deleted"; }
[ -n "$unresolvable" ] && { note "pinned references not resolvable:"; echo "$unresolvable"; }

# ── 4. Exact agreement between manifest declarations and validations ────
[ "$manifest_byte" -eq "$ok_byte" ] || note "BYTE_IDENTICAL count mismatch: manifest $manifest_byte vs validated $ok_byte"
[ "$manifest_ws" -eq "$ok_ws" ] || note "WHITESPACE_ONLY count mismatch: manifest $manifest_ws vs validated $ok_ws"
[ "$manifest_unres" -eq "$ok_unres" ] || note "UNRESOLVED count mismatch: manifest $manifest_unres vs validated $ok_unres"
[ "$manifest_total" -eq "$tracked_count" ] || note "pin row count $manifest_total != tracked vendored files $tracked_count"
[ "$ok_total" -eq "$manifest_total" ] || note "validated rows $ok_total != manifest rows $manifest_total"
[ "$manifest_total" -eq "$EXPECTED_TOTAL" ] || note "expected $EXPECTED_TOTAL pinned vendored files, manifest has $manifest_total — inventory changed, review required"

# ── 5. forge-std submodule pin (test-only dependency) ────────────────────
sub="$(git -C "$REPO_ROOT" ls-files -s contractsV2/lib/forge-std | awk '{print $2}')"
[ "$sub" = "$FORGE_STD_PIN" ] || note "forge-std submodule SHA $sub != pinned $FORGE_STD_PIN"

echo "vendored .sol files: $ok_total verified (byte-identical: $ok_byte, whitespace-only: $ok_ws, unresolved provenance: $ok_unres)"
echo "forge-std submodule: $sub (pinned, test-only)"
[ "$fail" -eq 0 ] && echo "DEPENDENCY_INTEGRITY_OK"
exit "$fail"
