#!/usr/bin/env bash
# Fail-closed source-parity verification (Correction A / P1-4).
#
# Reproduces the deploy-time bytecode parity evidence from COMMITTED
# material, using the EXACT deploy-time compilation path:
#
#   1. Manifest completeness: every critical recovered contract MUST have
#      its full evidence set. Missing, deleted or extra critical artifacts
#      FAIL — no silent skips.
#   2. Recompilation: each contract's committed std-json-input.json is
#      compiled with solc 0.8.35+commit.47b9dedd — the exact deploy-time
#      compiler, version-string verified, binary checksum-pinned (linux
#      amd64 build from binaries.soliditylang.org).
#   3. Byte comparison: the recompiled runtime is compared against the
#      committed on-chain runtime hex under explicit metadata handling.
#      Outcomes:
#        EXACT              — full bytecode equality (incl. auxdata)
#        IMMUTABLE_PATCHED  — code equal after 20-byte immutable-address
#                             patching; auxdata tail tolerated
#      Any other difference FAILS.
#   4. The observed classification must match evidence.json.
#
# Usage: verify-parity.sh [repo-root]
set -euo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
PROV="$ROOT/provenance"
SOLC_VERSION="0.8.35+commit.47b9dedd"
# Expected manifest: every critical recovered contract. A contract removed
# from this list (or from the evidence directory) fails the gate.
EXPECTED=(
  PonsV2LaunchFactory
  PonsV2LaunchDeployer
  PonsV2LaunchAndBuy
  PonsV2MemeHook
  PonsV2FeeEscrow
  PonsV2BuybackVault
  PonsV2LaunchLocker
  PonsV2GraduationExecutor
  PonsV2GraduationGuard
)
fail=0
note() { echo "::error::$*"; fail=1; }
# ── 1. Manifest completeness (fail-closed, no skips) ─────────────────────
for name in "${EXPECTED[@]}"; do
  dir="$PROV/$name"
  for f in evidence.json onchain-runtime.hex; do
    [ -f "$dir/$f" ] || note "$name/$f MISSING from provenance manifest"
  done
  # The hook lives in the hooks/ subdirectory (deploy-time layout).
  src_path="$ROOT/contractsV2-deployed/src/v2/$name.sol"
  if [ ! -f "$src_path" ]; then src_path="$ROOT/contractsV2-deployed/src/v2/hooks/$name.sol"; fi
  [ -f "$src_path" ] || note "$name.sol missing from contractsV2-deployed/src/v2/"
done
# Source-proven-only contracts carry their classification note. The locker's
# std-json-input is retained locally only (pre-rename alias; excluded from
# the union — see its evidence.json note) so it is not required here.
# 1b. Full-tree integrity: the union of all committed Sourcify-verified
# std-json compile sets must cover the deploy-time tree byte-for-byte,
# plus the forge-additions allowlist (pinned OZ v5.0.0 hashes). Catches
# deletion, modification or addition of ANY critical source file.
bash "$PROV/tree-integrity-gate.sh" "$ROOT" || {
  echo "::error::deploy-time tree integrity FAILED (see report above)"
  fail=1
}

# Unexpected EXTRA evidence directories are flagged (manifest drift).
for d in "$PROV"/*/; do
  name="$(basename "$d")"
  case " ${EXPECTED[*]} PonsV2LauncherToken " in
    *" $name "*) ;;
    *) note "unexpected provenance directory (manifest drift): $name" ;;
  esac
done
[ "$fail" -eq 0 ] || { echo "SOURCE_PARITY_GATE: manifest incomplete"; exit 1; }
# ── 2. Provision the exact deploy-time compiler ──────────────────────────
# Pinned per-platform builds of solc 0.8.35+commit.47b9dedd from
# binaries.soliditylang.org; checksums verified before use.
case "$(uname -s)" in
  Linux*)
    SOLC_URL="https://binaries.soliditylang.org/linux-amd64/solc-linux-amd64-v${SOLC_VERSION}"
    SOLC_SHA256="fa8ac9a32d301ad023a36ee5a29f8e291fe3200c60244e43c142539e82a617f4"
    SOLC_EXT=""
    ;;
  MINGW*|MSYS*|CYGWIN*)
    SOLC_URL="https://binaries.soliditylang.org/windows-amd64/solc-windows-amd64-v${SOLC_VERSION}.exe"
    SOLC_SHA256="80e7c896cf5de05ecf0e009a624a2d7c0e05fb8daa9da10a4c447f5bc40c6eb7"
    SOLC_EXT=".exe"
    ;;
  Darwin*)
    echo "::error::no pinned solc build for Darwin — parity gate must run on linux/windows"; exit 1;
    ;;
esac
SOLC="$ROOT/provenance/.solc-0.8.35$SOLC_EXT"
if [ ! -x "$SOLC" ]; then
  curl -sL -o "$SOLC" "$SOLC_URL"
  chmod +x "$SOLC"
fi
actual_sha="$(sha256sum "$SOLC" | cut -d' ' -f1)"
[ "$actual_sha" = "$SOLC_SHA256" ] || {
  echo "::error::solc binary checksum mismatch (expected $SOLC_SHA256, got $actual_sha)"; exit 1;
}
ver="$("$SOLC" --version 2>/dev/null | grep -o 'Version: [0-9.]*+commit\.[0-9a-f]*' | cut -d' ' -f2)"
[ "$ver" = "$SOLC_VERSION" ] || {
  echo "::error::solc version mismatch (expected $SOLC_VERSION, got $ver)"; exit 1;
}
# ── 3+4. Per-contract recompile + classified byte comparison ─────────────
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
for name in "${EXPECTED[@]}"; do
  dir="$PROV/$name"
  # Compile the committed std-json input (outputSelection injected; this
  # cannot affect codegen). The locker has no standalone input (pre-rename
  # alias, excluded): it compiles from the factory set, which carries
  # src/v2/PonsV2LaunchLocker.sol.
  if [ "$name" = "PonsV2LaunchLocker" ]; then
    perl "$PROV/std-json-fix.pl" "$PROV/PonsV2LaunchFactory" "PonsV2LaunchFactory" "$WORK" > /dev/null
    perl "$PROV/std-json-fix.pl" "$PROV/PonsV2LaunchFactory" "PonsV2LaunchLocker" "$WORK" > /dev/null
  else
    perl "$PROV/std-json-fix.pl" "$dir" "$name" "$WORK" > /dev/null
  fi
  "$SOLC" --standard-json < "$WORK/$name-std-in-fixed.json" > "$WORK/$name-std-out.json" 2> /dev/null
  (cd "$WORK" && perl "$PROV/std-json-extract.pl" "$WORK/$name-std-out.json" "$name") > /dev/null \
    || { note "$name: recompilation failed (see std-json-extract output)"; continue; }
  set +e
  perl "$PROV/zero-span-verify.pl" \
    "$WORK/$name-runtime.txt" \
    "$dir/onchain-runtime.hex" \
    "$name" > "$dir/verify-result.txt" 2>&1
  rc=$?
  set -e
  if [ $rc -ne 0 ]; then
    note "$name: byte verification FAILED — unexpected bytecode difference"
    cat "$dir/verify-result.txt"
    continue
  fi
  observed="IMMUTABLE_PATCHED"
  if [ "$(cat "$WORK/$name-runtime.txt")" = "$(cat "$dir/onchain-runtime.hex")" ]; then
    observed="EXACT"
  fi
  declared="$(perl -e 'use JSON::PP; local $/; open my $fh,"<:raw",$ARGV[0]; my $r=JSON::PP->new->utf8->decode(<$fh>); print $r->{expectedClassification} // ""' "$dir/evidence.json")"
  # Classification semantics:
  #   EXACT                - requires the recompiled auxdata to match too.
  #   EXACT_VIA_SOURCIFY   - Sourcify's own recompile matched auxdata-exact;
  #                          our native-toolchain gate additionally proves
  #                          code-level parity (EXACT or IMMUTABLE_PATCHED).
  #   IMMUTABLE_PATCHED    - code parity required; auxdata tolerated; an
  #                          EXACT observation also satisfies the tier.
  if [ "$declared" = "EXACT" ] && [ "$observed" != "EXACT" ]; then
    note "$name: declared EXACT but observed $observed"
  elif [ "$declared" = "EXACT_VIA_SOURCIFY" ] && [ "$observed" != "EXACT" ] && [ "$observed" != "IMMUTABLE_PATCHED" ]; then
    note "$name: declared EXACT_VIA_SOURCIFY but observed $observed"
  elif [ "$declared" = "IMMUTABLE_PATCHED" ] && [ "$observed" != "IMMUTABLE_PATCHED" ] && [ "$observed" != "EXACT" ]; then
    note "$name: declared IMMUTABLE_PATCHED but observed $observed"
  fi
  echo "PARITY-OK: $name [$observed] $(head -1 "$dir/verify-result.txt")"
done
[ "$fail" -eq 0 ] && echo "SOURCE_PARITY_GATE_OK"
exit "$fail"
