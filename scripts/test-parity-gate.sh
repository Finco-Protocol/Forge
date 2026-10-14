#!/usr/bin/env bash
# Negative fixtures for the source-parity gate (Correction A scenarios
# 11-13): missing, modified or added manifest material must FAIL. Runs the
# REAL gate against a temporary COPY of the repo's parity inputs — the
# committed manifest is never mutated.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATE="$ROOT/provenance/verify-parity.sh"
TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT
fail=0

# Build a sandbox copy of the parity-relevant repo slice.
make_sandbox() {
  mkdir -p "$TMP/repo/provenance" "$TMP/repo/contractsV2-deployed/src/v2/hooks"
  cp -r "$ROOT/provenance/." "$TMP/repo/provenance/"
  rm -rf "$TMP/repo/provenance/.solc-0.8.35"*
  cp -r "$ROOT/contractsV2-deployed/src" "$TMP/repo/contractsV2-deployed/"
  cp -r "$ROOT/contractsV2-deployed/lib" "$TMP/repo/contractsV2-deployed/"
  cp "$ROOT/foundry.toml" "$TMP/repo/foundry.toml" 2>/dev/null || true
}

run_gate() { # $1 = case name
  set +e
  bash "$GATE" "$TMP/repo" > "$TMP/$1.log" 2>&1
  local rc=$?
  set -e
  echo "$rc"
}

expect_fail() { # $1 = case, $2 = expected log fragment
  local rc
  rc="$(run_gate "$1")"
  if [ "$rc" -eq 0 ]; then
    echo "::error::parity fixture $1: expected FAIL, gate returned 0"
    tail -5 "$TMP/$1.log"
    fail=1
  elif ! grep -q "$2" "$TMP/$1.log"; then
    echo "::error::parity fixture $1: failed as expected but log missing '$2'"
    tail -5 "$TMP/$1.log"
    fail=1
  else
    echo "ok: $1 (exit $rc)"
  fi
}

# Baseline: the untouched copy must PASS (validates the sandbox itself).
make_sandbox
rc="$(run_gate "N0_baseline")"
if [ "$rc" -ne 0 ]; then
  echo "::error::parity fixture baseline: expected PASS, gate returned $rc"
  tail -8 "$TMP/N0_baseline.log"
  fail=1
else
  echo "ok: N0_baseline (exit 0)"
fi

# S11a: a manifest entry's onchain-runtime.hex deleted → FAIL.
make_sandbox
rm "$TMP/repo/provenance/PonsV2LaunchFactory/onchain-runtime.hex"
expect_fail "S11a_missing_runtime_hex" "MISSING from provenance manifest"

# S11b: an entire manifest directory deleted → FAIL.
make_sandbox
rm -rf "$TMP/repo/provenance/PonsV2FeeEscrow"
expect_fail "S11b_missing_evidence_dir" "MISSING from provenance manifest"

# S11c: a deployed source file deleted → FAIL.
make_sandbox
rm "$TMP/repo/contractsV2-deployed/src/v2/PonsV2BondingCurve.sol"
expect_fail "S11c_missing_source" "source MISSING from deploy-time tree"

# S12a: onchain runtime bytecode modified → FAIL (unexpected difference).
make_sandbox
perl -pi -e 's/^./f/' "$TMP/repo/provenance/PonsV2MemeHook/onchain-runtime.hex"
expect_fail "S12a_modified_onchain_hex" "byte verification FAILED"

# S12b: std-json source content modified → FAIL (recompiled code differs).
make_sandbox
perl -pi -e 's/MAX_CURVE_FEE_BPS = 1_000/MAX_CURVE_FEE_BPS = 1_001/g' "$TMP/repo/provenance/PonsV2LaunchFactory/std-json-input.json"
expect_fail "S12b_modified_stdjson" "byte verification FAILED"

# S12c: evidence classification mutated (EXACT where not provable) → FAIL.
make_sandbox
perl -pi -e 's/IMMUTABLE_PATCHED/EXACT/' "$TMP/repo/provenance/PonsV2MemeHook/evidence.json"
expect_fail "S12c_mutated_classification" "declared EXACT but observed"

# S12d: an unexpected EXTRA evidence directory (manifest drift) → FAIL.
make_sandbox
mkdir -p "$TMP/repo/provenance/FakeContract"
cp "$ROOT/provenance/PonsV2FeeEscrow/onchain-runtime.hex" "$TMP/repo/provenance/FakeContract/onchain-runtime.hex" 2>/dev/null || true
cp "$ROOT/provenance/PonsV2FeeEscrow/std-json-input.json" "$TMP/repo/provenance/FakeContract/std-json-input.json" 2>/dev/null || true
cp "$ROOT/provenance/PonsV2FeeEscrow/evidence.json" "$TMP/repo/provenance/FakeContract/evidence.json" 2>/dev/null || true
expect_fail "S12d_extra_evidence_dir" "manifest drift"

if [ "$fail" -eq 0 ]; then
  echo "PARITY_GATE_TESTS_OK"
fi
exit $fail
