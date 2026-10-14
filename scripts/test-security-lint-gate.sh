#!/usr/bin/env bash
# Regression tests for scripts/check-security-lint.pl (Correction B).
# Deterministic synthetic fixtures in real `forge lint --json` shape; no
# Forge invocation required.
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
PARSER="$DIR/check-security-lint.pl"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

expect() { # $1=case $2=expected-exit $3..=command
  local name="$1" want="$2"; shift 2
  "$@" >"$TMP/out.log" 2>&1
  local got=$?
  if [ "$got" -ne "$want" ]; then
    echo "::error::security-lint-gate test '$name': expected exit $want, got $got"
    cat "$TMP/out.log"
    fail=1
  else
    echo "ok: $name (exit $got)"
  fi
}
expect_out() { # $1=case $2=pattern
  grep -q -- "$2" "$TMP/out.log" || { echo "::error::$1: output lacks '$2'"; cat "$TMP/out.log"; fail=1; }
}

# diag LEVEL CODE FILE LINE TEXT -> one diagnostic line in forge lint shape
diag() {
  printf '{"$message_type":"diagnostic","message":"m","code":{"code":"%s","explanation":null},"level":"%s","spans":[{"file_name":"%s","byte_start":0,"byte_end":1,"line_start":%s,"line_end":%s,"column_start":1,"column_end":2,"is_primary":true,"text":[{"text":"%s","highlight_start":1,"highlight_end":2}],"label":null,"suggested_replacement":null,"suggestion_applicability":null,"expansion":null}],"children":[{"message":"help","code":null,"level":"help","spans":[],"children":[],"rendered":null}],"rendered":"x"}\n' \
    "$2" "$1" "$3" "$4" "$4" "$5"
}

F=src/Reg.sol
T1='        if (a < block.timestamp) revert X();'
T2='        emit Bound('
printf '# fixture baseline\n%s\t%s\t%s\t%s\t%s\n%s\t%s\t%s\t%s\t%s\n' \
  block-timestamp "$F" 1 'if (a < block.timestamp) revert X();' 'minutes-scale' \
  reentrancy-events "$F" 2 'emit Bound(' 'precompile only' > "$TMP/base.tsv"

{ diag warning block-timestamp "$F" 10 "$T1"; diag warning reentrancy-events "$F" 20 "$T2"; diag warning reentrancy-events "$F" 30 "$T2"; } > "$TMP/clean.json"

# S1: exactly the pinned advisory set passes and is reported.
expect "S1-pinned-set-passes" 0 perl "$PARSER" "$TMP/clean.json" "$TMP/base.tsv"
expect_out S1 "SECURITY_LINT_VERDICT=PASS"
expect_out S1 "APPROVED_ADVISORY \[reentrancy-events\] $F:20,30 x2"

# S2: an error-level finding fails even when code/file/anchor match a pin.
{ cat "$TMP/clean.json"; diag error block-timestamp "$F" 10 "$T1"; } > "$TMP/err.json"
expect "S2-error-never-pinnable" 1 perl "$PARSER" "$TMP/err.json" "$TMP/base.tsv"
expect_out S2 "errors=1"

# S3: an unexpected (unpinned) warning fails.
{ cat "$TMP/clean.json"; diag warning unsafe-typecast "$F" 40 '        x = uint64(y);'; } > "$TMP/unexp.json"
expect "S3-unexpected-warning-fails" 1 perl "$PARSER" "$TMP/unexp.json" "$TMP/base.tsv"
expect_out S3 "UNEXPECTED warning \[unsafe-typecast\]"

# S4: malformed JSON fails as MALFORMED (exit 2).
{ cat "$TMP/clean.json"; printf '{"level": "warning", broken\n'; } > "$TMP/bad.json"
expect "S4-malformed-json" 2 perl "$PARSER" "$TMP/bad.json" "$TMP/base.tsv"
expect_out S4 "SECURITY_LINT_VERDICT=MALFORMED"

# S5: truncated output (a diagnostic cut mid-line) fails.
{ cat "$TMP/clean.json"; diag warning block-timestamp "$F" 10 "$T1" | head -c 120; } > "$TMP/trunc.json"
expect "S5-truncated-output" 2 perl "$PARSER" "$TMP/trunc.json" "$TMP/base.tsv"

# S6: a non-diagnostic JSON value (array, other message type) fails.
printf '[]\n' > "$TMP/array.json"
expect "S6a-json-array" 2 perl "$PARSER" "$TMP/array.json" "$TMP/base.tsv"
printf '{"$message_type":"artifact","level":"warning"}\n' > "$TMP/other.json"
expect "S6b-non-diagnostic-object" 2 perl "$PARSER" "$TMP/other.json" "$TMP/base.tsv"

# S7: a diagnostic without a level fails.
printf '{"$message_type":"diagnostic","message":"x"}\n' > "$TMP/nolevel.json"
expect "S7-missing-level" 2 perl "$PARSER" "$TMP/nolevel.json" "$TMP/base.tsv"

# S8: an unknown level is fail-closed.
{ cat "$TMP/clean.json"; diag fatal block-timestamp "$F" 10 "$T1"; } > "$TMP/unknown.json"
expect "S8-unknown-level" 1 perl "$PARSER" "$TMP/unknown.json" "$TMP/base.tsv"

# S9: empty lint output with pins present -> stale pins fail (a lint run
# that silently produced nothing can never pass).
: > "$TMP/empty.json"
expect "S9-empty-output-stale-pins" 1 perl "$PARSER" "$TMP/empty.json" "$TMP/base.tsv"
expect_out S9 "STALE pin"

# S10: one more occurrence than pinned fails (count is exact).
{ cat "$TMP/clean.json"; diag warning reentrancy-events "$F" 50 "$T2"; } > "$TMP/extra.json"
expect "S10-count-exceeded" 1 perl "$PARSER" "$TMP/extra.json" "$TMP/base.tsv"
expect_out S10 "COUNT MISMATCH"

# S11: anchor drift — the flagged code changed — un-pins it.
{ diag warning block-timestamp "$F" 10 '        if (a <= block.timestamp) revert X();'; diag warning reentrancy-events "$F" 20 "$T2"; diag warning reentrancy-events "$F" 30 "$T2"; } > "$TMP/drift.json"
expect "S11-anchor-drift" 1 perl "$PARSER" "$TMP/drift.json" "$TMP/base.tsv"

# S12: the old regex prefilter's blind spots. A spaced `"level": "error"`
# (missed by /"level":"error"/) must fail; a warning whose MESSAGE contains
# '"level":"error"' must be classified by its real level field.
{ cat "$TMP/clean.json"; diag error block-timestamp "$F" 10 "$T1" | sed 's/"level":"error"/"level": "error"/'; } > "$TMP/spaced.json"
expect "S12a-spaced-error-level" 1 perl "$PARSER" "$TMP/spaced.json" "$TMP/base.tsv"
expect_out S12a "errors=1"
sed '1s/"message":"m"/"message":"\\"level\\":\\"error\\""/' "$TMP/clean.json" > "$TMP/msg.json"
expect "S12b-level-text-in-message" 0 perl "$PARSER" "$TMP/msg.json" "$TMP/base.tsv"

# S13: a warning without a primary span cannot be matched -> MALFORMED.
printf '{"$message_type":"diagnostic","message":"m","code":{"code":"block-timestamp","explanation":null},"level":"warning","spans":[],"children":[],"rendered":"x"}\n' > "$TMP/nospan.json"
expect "S13-warning-without-span" 2 perl "$PARSER" "$TMP/nospan.json" "$TMP/base.tsv"

# S14: malformed baselines fail (missing rationale, bad count, duplicate).
printf '%s\t%s\t1\t%s\t\n' block-timestamp "$F" 'x' > "$TMP/norat.tsv"
expect "S14a-baseline-missing-rationale" 2 perl "$PARSER" "$TMP/clean.json" "$TMP/norat.tsv"
printf '%s\t%s\t0\t%s\tr\n' block-timestamp "$F" 'x' > "$TMP/zero.tsv"
expect "S14b-baseline-zero-count" 2 perl "$PARSER" "$TMP/clean.json" "$TMP/zero.tsv"
cat "$TMP/base.tsv" <(tail -1 "$TMP/base.tsv") > "$TMP/dup.tsv"
expect "S14c-baseline-duplicate-pin" 2 perl "$PARSER" "$TMP/clean.json" "$TMP/dup.tsv"

# S15: missing inputs fail.
expect "S15a-missing-lint-file" 2 perl "$PARSER" "$TMP/nope.json" "$TMP/base.tsv"
expect "S15b-missing-baseline" 2 perl "$PARSER" "$TMP/clean.json" "$TMP/nope.tsv"

# S16: the committed baseline itself is well-formed (parses; an empty lint
# run against it must FAIL on stale pins, not on malformation).
expect "S16-committed-baseline-wellformed" 1 perl "$PARSER" "$TMP/empty.json" "$DIR/security-lint-baseline.tsv"
expect_out S16 "SECURITY_LINT_VERDICT=FAIL"

if [ "$fail" -eq 0 ]; then
  echo "SECURITY_LINT_GATE_TESTS_OK"
fi
exit $fail
