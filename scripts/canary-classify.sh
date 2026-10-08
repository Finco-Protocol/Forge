#!/usr/bin/env bash
# Controlled classifier for the full V2 `forge build` canary.
#
# Usage: canary-classify.sh <build_exit_code> <build_log_file>
#
# Verdicts (printed as CANARY_VERDICT=...):
#   UPSTREAM_V2_FACTORY_BLOCKED  the build failed in exactly the documented
#                                way: solc error 9582 (member
#                                `exemptFromSnipeTax` not found on
#                                `PonsV2BondingCurve`), raised from
#                                PonsV2LaunchFactory.sol, with no other
#                                compiler failures. This is the ONLY
#                                outcome this job may accept, and a green
#                                canary means ONLY that the documented
#                                upstream F-01 defect is unchanged. It is
#                                NOT evidence that the PONS V2 protocol
#                                builds. The full product remains
#                                PRODUCTION_BLOCKED (F-01/F-02).
#   UPSTREAM_V2_FACTORY_REPAIRED unexpected successful build: upstream
#                                appears to have fixed F-01. Hard failure:
#                                convert the canary into a hard gate.
#   NEW_COMPILER_FAILURE         a different or additional solc error.
#                                Hard failure: investigate.
#   INFRASTRUCTURE_ERROR         tool/download/environment failure, not a
#                                compiler result. Hard failure: re-run or
#                                fix the environment.
#   UNCLASSIFIED                 anything else. Hard failure: never guess.
set -euo pipefail

code="$1"
log="$2"

fail() { # $1 = verdict, $2 = human message
  echo "CANARY_VERDICT=$1"
  echo "::error::canary: $2"
  exit 1
}

[ -f "$log" ] || fail UNCLASSIFIED "build log missing — cannot classify"

# 1. Infrastructure / tool-invocation errors are never compiler results.
if grep -qiE "failed to download|could not resolve|connection refused|compilation skipped|not found or not installed|permission denied" "$log"; then
  fail INFRASTRUCTURE_ERROR "tool or environment failure detected in build log (see job log)"
fi

# 2. An unexpected successful build means upstream repaired F-01.
if [ "$code" -eq 0 ]; then
  if grep -q "Compiler run successful" "$log"; then
    fail UPSTREAM_V2_FACTORY_REPAIRED "full V2 build now SUCCEEDS — F-01 appears fixed upstream; convert this canary into a hard gate and extend tests to the factory"
  fi
  fail UNCLASSIFIED "exit code 0 without a success marker — ambiguous result"
fi

# 3. A failing build must carry solc diagnostics.
if ! grep -q "^Error (" "$log"; then
  fail UNCLASSIFIED "build failed without any solc error diagnostic — ambiguous result"
fi

# 4. Every solc error must be the single documented F-01 error.
EXPECTED_ID="Error (9582)"
total=$(grep -c "^Error (" "$log")
expected=$(grep -c "^${EXPECTED_ID}:" "$log")
if [ "$total" -ne "$expected" ]; then
  echo "::error::canary: unexpected additional compiler errors (total $total, expected-class $expected):"
  grep "^Error (" "$log" | grep -v "^${EXPECTED_ID}:" || true
  fail NEW_COMPILER_FAILURE "compiler errors other than the documented F-01 error (9582) are present"
fi

# 5. The error must be exactly the known member/contract/caller triple.
grep -q 'Member "exemptFromSnipeTax" not found' "$log" \
  || fail NEW_COMPILER_FAILURE "error 9582 present but no longer the exemptFromSnipeTax member error"
grep -q "contract PonsV2BondingCurve" "$log" \
  || fail NEW_COMPILER_FAILURE "error does not reference contract PonsV2BondingCurve"
loc=$(grep -oE -- "--> contractsV2/src/v2/PonsV2LaunchFactory\.sol:[0-9]+:[0-9]+" "$log" | head -1)
[ -n "$loc" ] || fail NEW_COMPILER_FAILURE "error is not raised from PonsV2LaunchFactory.sol"

echo "CANARY_VERDICT=UPSTREAM_V2_FACTORY_BLOCKED"
echo "UPSTREAM_V2_FACTORY_BLOCKED: full V2 build fails exactly as documented (solc $EXPECTED_ID, 'exemptFromSnipeTax' on PonsV2BondingCurve, at ${loc#--* })."
echo "This green canary is NOT a successful build of the PONS V2 protocol."
echo "It records only that upstream finding F-01 (docs/SECURITY-REVIEW.md) is unchanged; the full product remains PRODUCTION_BLOCKED until F-01/F-02 close."
