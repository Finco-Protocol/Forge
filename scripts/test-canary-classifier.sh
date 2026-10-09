#!/usr/bin/env bash
# Regression tests for scripts/canary-classifier.sh (Correction B1).
# Deterministic synthetic log fixtures — cases A through F of the
# Correction B specification. No Forge invocation, no PONS source change.
set -u

CLASSIFIER="$(cd "$(dirname "$0")" && pwd)/canary-classify.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

run_case() { # $1=case-id $2=exitcode $3=logfile $4=expected-exit $5=expected-verdict
  local id="$1" code="$2" log="$3" want_exit="$4" want_verdict="$5"
  set +e
  bash "$CLASSIFIER" "$code" "$log" > "$TMP/$id.out" 2>&1
  local got=$?
  set -e
  if [ "$got" -ne "$want_exit" ]; then
    echo "::error::canary case $id: expected exit $want_exit, got $got"; cat "$TMP/$id.out"; fail=1; return
  fi
  if ! grep -q "CANARY_VERDICT=$want_verdict" "$TMP/$id.out"; then
    echo "::error::canary case $id: expected verdict $want_verdict"; cat "$TMP/$id.out"; fail=1; return
  fi
  echo "ok: $id (exit $got, verdict $want_verdict)"
}

# ── Case A: the known PONS F-01 failure — the ONLY accepted outcome. ────
cat > "$TMP/f01.log" <<'EOF'
Compiling 86 files with Solc 0.8.30
Error: Compiler run failed:
Error (9582): Member "exemptFromSnipeTax" not found or not visible after argument-dependent lookup in contract PonsV2BondingCurve.
   --> contractsV2/src/v2/PonsV2LaunchFactory.sol:749:13:
    |
749 |             PonsV2BondingCurve(curve).exemptFromSnipeTax(snipeTaxExemptions[i]);
    |             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
EOF
run_case "A-known-F01-accepted" 1 "$TMP/f01.log" 0 "UPSTREAM_V2_FACTORY_BLOCKED"
# The accepted verdict must also carry the explicit non-pass label.
grep -q "NOT a successful build" "$TMP/A-known-F01-accepted.out" \
  || { echo "::error::case A: missing explicit not-a-pass label"; fail=1; }

# ── Case B: unexpected successful full build — must FAIL. ───────────────
printf 'Compiling 86 files with Solc 0.8.30\nSolc 0.8.30 finished in 1.00s\nCompiler run successful!\n' > "$TMP/ok.log"
run_case "B-unexpected-success-fails" 0 "$TMP/ok.log" 1 "UPSTREAM_V2_FACTORY_REPAIRED"

# ── Case C: a different Solidity compiler error — must FAIL. ────────────
cat > "$TMP/other.log" <<'EOF'
Error: Compiler run failed:
Error (5543): Value must be a compile-time constant.
   --> contractsV2/src/v2/SomeOther.sol:12:5:
EOF
run_case "C-different-compiler-error-fails" 1 "$TMP/other.log" 1 "NEW_COMPILER_FAILURE"

# ── Case D: expected F-01 error PLUS an unrelated compiler error. ───────
cat > "$TMP/mixed.log" <<'EOF'
Error: Compiler run failed:
Error (9582): Member "exemptFromSnipeTax" not found or not visible after argument-dependent lookup in contract PonsV2BondingCurve.
   --> contractsV2/src/v2/PonsV2LaunchFactory.sol:749:13:
Error (5543): Value must be a compile-time constant.
   --> contractsV2/src/v2/SomeOther.sol:12:5:
EOF
run_case "D-expected-plus-extra-fails" 1 "$TMP/mixed.log" 1 "NEW_COMPILER_FAILURE"

# ── Case E: missing / malformed build logs — must FAIL. ─────────────────
run_case "E1-missing-log-fails" 1 "$TMP/does-not-exist.log" 1 "UNCLASSIFIED"
printf 'Solc 0.8.30 finished in 1.00s\n' > "$TMP/noerror.log"
run_case "E2-fail-without-diagnostics-fails" 1 "$TMP/noerror.log" 1 "UNCLASSIFIED"
printf 'Error (9582): truncated log, no location line\n' > "$TMP/truncated.log"
run_case "E3-error-without-location-fails" 1 "$TMP/truncated.log" 1 "NEW_COMPILER_FAILURE"

# ── Case F: infrastructure/tool failure — must FAIL. ────────────────────
printf 'Error:\n   0: failed to download https://binaries.soliditylang.org/solc.json\n' > "$TMP/infra.log"
run_case "F1-download-failure-fails" 1 "$TMP/infra.log" 1 "INFRASTRUCTURE_ERROR"
printf 'forge: could not resolve host binaries.soliditylang.org\n' > "$TMP/infra2.log"
run_case "F2-network-failure-fails" 1 "$TMP/infra2.log" 1 "INFRASTRUCTURE_ERROR"

# ── Ambiguity: exit code 0 without a success marker. ────────────────────
printf 'some partial output\n' > "$TMP/weird.log"
run_case "G-exit0-without-success-marker-fails" 0 "$TMP/weird.log" 1 "UNCLASSIFIED"

if [ "$fail" -eq 0 ]; then
  echo "CANARY_CLASSIFIER_TESTS_OK"
fi
exit $fail
