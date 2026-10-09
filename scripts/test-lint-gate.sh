#!/usr/bin/env bash
# Regression tests for scripts/check-test-lint.pl (Correction B3).
# Deterministic synthetic fixtures; no Forge invocation required.
set -u

PARSER="$(cd "$(dirname "$0")" && pwd)/check-test-lint.pl"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

expect() { # $1=case $2=expected-exit $3..=command
  local name="$1" want="$2"; shift 2
  set +e
  "$@" >"$TMP/out.log" 2>&1
  local got=$?
  set -e
  if [ "$got" -ne "$want" ]; then
    echo "::error::lint-gate test '$name': expected exit $want, got $got"
    cat "$TMP/out.log"
    fail=1
  else
    echo "ok: $name (exit $got)"
  fi
}

# L1: clean output (zero diagnostics) passes.
: > "$TMP/clean.json"
expect "L1-clean-passes" 0 perl "$PARSER" "$TMP/clean.json"
grep -q "LINT_GATE_VERDICT=PASS" "$TMP/out.log" || { echo "::error::L1 verdict not PASS"; fail=1; }

# L2: a real-shape warning diagnostic fails the gate.
cat > "$TMP/warn.json" <<'EOF'
{"$message_type":"diagnostic","message":"`block.timestamp` may be reused across `vm.warp`","code":{"code":"environment-read-across-mutation","explanation":null},"level":"warning","spans":[{"file_name":"test/X.t.sol","byte_start":0,"byte_end":1,"line_start":10,"line_end":10,"column_start":1,"column_end":5,"is_primary":true,"text":[]}],"children":[],"rendered":"warning[environment-read-across-mutation]: x"}
EOF
expect "L2-warning-fails" 1 perl "$PARSER" "$TMP/warn.json"
grep -q "LINT_GATE_VERDICT=FAIL" "$TMP/out.log" || { echo "::error::L2 verdict not FAIL"; fail=1; }

# L3: an error-level diagnostic fails the gate.
cat > "$TMP/err.json" <<'EOF'
{"$message_type":"diagnostic","message":"suspicious code","code":{"code":"suspicious-comment","explanation":null},"level":"error","spans":[{"file_name":"test/X.t.sol","byte_start":0,"byte_end":1,"line_start":3,"line_end":3,"column_start":1,"column_end":5,"is_primary":true,"text":[]}],"children":[],"rendered":"error[suspicious-comment]: x"}
EOF
expect "L3-error-fails" 1 perl "$PARSER" "$TMP/err.json"

# L4: malformed JSON fails the gate (exit 2), never passes.
printf '{"level": "warning", broken\n' > "$TMP/bad.json"
expect "L4-malformed-fails" 2 perl "$PARSER" "$TMP/bad.json"
grep -q "LINT_GATE_VERDICT=MALFORMED" "$TMP/out.log" || { echo "::error::L4 verdict not MALFORMED"; fail=1; }

# L5: a diagnostic without a 'level' field fails the gate.
printf '{"$message_type":"diagnostic","message":"x"}\n' > "$TMP/nolevel.json"
expect "L5-missing-level-fails" 2 perl "$PARSER" "$TMP/nolevel.json"

# L6: an unknown level is fail-closed (treated as actionable).
cat > "$TMP/unknown.json" <<'EOF'
{"$message_type":"diagnostic","message":"x","code":{"code":"y","explanation":null},"level":"fatal","spans":[],"children":[],"rendered":"fatal[y]: x"}
EOF
expect "L6-unknown-level-fails-closed" 1 perl "$PARSER" "$TMP/unknown.json"

# L7: whitespace/blank lines do not break parsing.
printf '\n{"$message_type":"diagnostic","message":"x","code":{"code":"y","explanation":null},"level":"warning","spans":[],"children":[],"rendered":""}\n\n' > "$TMP/blank.json"
expect "L7-blank-lines-handled" 1 perl "$PARSER" "$TMP/blank.json"

# L8: multiple diagnostics aggregate into one failure.
cat "$TMP/warn.json" "$TMP/err.json" > "$TMP/multi.json"
expect "L8-multiple-aggregate" 1 perl "$PARSER" "$TMP/multi.json"
grep -q "actionable=2" "$TMP/out.log" || { echo "::error::L8 actionable count wrong"; cat "$TMP/out.log"; fail=1; }

# L9: missing input file fails.
expect "L9-missing-file-fails" 2 perl "$PARSER" "$TMP/does-not-exist.json"

if [ "$fail" -eq 0 ]; then
  echo "LINT_GATE_TESTS_OK"
fi
exit $fail
