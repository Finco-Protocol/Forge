#!/usr/bin/env bash
# Negative tests for scripts/check-vendored-deps.sh (Correction B2).
# Manifest-level cases use VENDOR_PINS_FILE overrides against a scratch
# copy; drift cases temporarily touch a vendored file and restore it via
# trap. The real manifest is never modified.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECKER="$ROOT/scripts/check-vendored-deps.sh"
TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT
fail=0

run_expect() { # $1=case-id $2=expected-exit $3=expected-grep $4=pins-file
  local id="$1" want="$2" grepx="$3" pins="${4:-}"
  set +e
  if [ -n "$pins" ]; then
    VENDOR_PINS_FILE="$pins" bash "$CHECKER" > "$TMP/$id.out" 2>&1
  else
    bash "$CHECKER" > "$TMP/$id.out" 2>&1
  fi
  local got=$?
  set -e
  if [ "$got" -ne "$want" ]; then
    echo "::error::vendor case $id: expected exit $want, got $got"; cat "$TMP/$id.out"; fail=1; return
  fi
  if [ -n "$grepx" ] && ! grep -q "$grepx" "$TMP/$id.out"; then
    echo "::error::vendor case $id: output missing '$grepx'"; cat "$TMP/$id.out"; fail=1; return
  fi
  echo "ok: $id (exit $got)"
}

# V1: the real manifest passes (happy path).
run_expect "V1-happy-path" 0 "DEPENDENCY_INTEGRITY_OK"

# V2: duplicate pin row must fail.
head -1 "$ROOT/scripts/vendor-pins.tsv" > "$TMP/dupe.tsv"
tail -n +2 "$ROOT/scripts/vendor-pins.tsv" >> "$TMP/dupe.tsv"
tail -n 1 "$ROOT/scripts/vendor-pins.tsv" >> "$TMP/dupe.tsv"
run_expect "V2-duplicate-row-fails" 1 "duplicate pin rows" "$TMP/dupe.tsv"

# V3: malformed row (4 fields) must fail.
head -n -1 "$ROOT/scripts/vendor-pins.tsv" > "$TMP/malformed.tsv"
tail -n 1 "$ROOT/scripts/vendor-pins.tsv" | cut -f1-4 >> "$TMP/malformed.tsv"
run_expect "V3-malformed-row-fails" 1 "malformed pin rows" "$TMP/malformed.tsv"

# V4: removed pin row must fail (the file becomes unpinned).
grep -v "TickMath.sol" "$ROOT/scripts/vendor-pins.tsv" > "$TMP/removed.tsv"
run_expect "V4-removed-pin-fails" 1 "unpinned vendored file" "$TMP/removed.tsv"

# V5: phantom pin row (non-existent file) must fail.
{ cat "$ROOT/scripts/vendor-pins.tsv"; printf 'contractsV2/lib/v4-core/src/libraries/DoesNotExist.sol\tBYTE_IDENTICAL\tv4-core@46c6834698c48bc4a463a86d8420f4eb1d7f3b75\tphantom\t0xdeadbeef\n'; } > "$TMP/phantom.tsv"
run_expect "V5-phantom-pin-fails" 1 "added/phantom record" "$TMP/phantom.tsv"

# V6: unknown class must fail.
sed 's/BYTE_IDENTICAL/SORT_OF_SAME/; t; s/WHITESPACE_ONLY/SORT_OF_SAME/; t; s/UNRESOLVED/SORT_OF_SAME/' "$ROOT/scripts/vendor-pins.tsv" > "$TMP/badclass.tsv"
run_expect "V6-unknown-class-fails" 1 "unknown pin classes" "$TMP/badclass.tsv"

# V7: an unverifiable reference breaks category agreement — the manifest
# declares 72 BYTE_IDENTICAL but only 71 validate, which must fail.
sed 's/OZ v5\.5\.0\tOZ v5\.5\.0/OZ v9.9.9\tOZ v9.9.9 (bogus)/' "$ROOT/scripts/vendor-pins.tsv" > "$TMP/badref.tsv"
run_expect "V7-count-mismatch-fails" 1 "count mismatch" "$TMP/badref.tsv"

# V8: real content drift in a BYTE_IDENTICAL file must fail (restored).
DRIFT_FILE="$ROOT/contractsV2/lib/v4-core/src/libraries/TickMath.sol"
cp "$DRIFT_FILE" "$TMP/TickMath.sol.bak"
printf '// drift probe\n' >> "$DRIFT_FILE"
set +e
bash "$CHECKER" > "$TMP/V8.out" 2>&1
got=$?
set -e
cp "$TMP/TickMath.sol.bak" "$DRIFT_FILE"
if [ "$got" -ne 1 ] || ! grep -q "dependency drift" "$TMP/V8.out"; then
  echo "::error::vendor case V8-byte-drift-fails: exit $got"; cat "$TMP/V8.out"; fail=1
else
  echo "ok: V8-byte-drift-fails (exit $got)"
fi

# V9: content drift in the UNRESOLVED file must fail (restored).
UNRES_FILE="$ROOT/contractsV2/lib/v4-hooks-public/src/base/BaseHook.sol"
cp "$UNRES_FILE" "$TMP/BaseHook.sol.bak"
printf '// drift probe\n' >> "$UNRES_FILE"
set +e
bash "$CHECKER" > "$TMP/V9.out" 2>&1
got=$?
set -e
cp "$TMP/BaseHook.sol.bak" "$UNRES_FILE"
if [ "$got" -ne 1 ] || ! grep -q "dependency drift" "$TMP/V9.out"; then
  echo "::error::vendor case V9-unresolved-drift-fails: exit $got"; cat "$TMP/V9.out"; fail=1
else
  echo "ok: V9-unresolved-drift-fails (exit $got)"
fi

# V10: after all restores, the checker is green again (no residue).
run_expect "V10-restored-green" 0 "DEPENDENCY_INTEGRITY_OK"

if [ "$fail" -eq 0 ]; then
  echo "VENDOR_CHECKER_TESTS_OK"
fi
exit $fail
