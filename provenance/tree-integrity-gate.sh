#!/usr/bin/env bash
# Union tree-integrity sub-gate: gathers all committed std-json inputs
# (excluding the locker's pre-rename alias, documented in its evidence.json)
# and runs tree-integrity.pl over the deploy-time tree.
set -euo pipefail
ROOT="${1:?usage: tree-integrity-gate.sh <repo-root>}"
PROV="$ROOT/provenance"

inputs=()
for d in "$PROV"/*/; do
  name="$(basename "$d")"
  [ "$name" = "PonsV2LaunchLocker" ] && continue # pre-rename alias; excluded
  if [ -f "$d/std-json-input.json" ]; then
    inputs+=("$d/std-json-input.json")
  fi
done
[ "${#inputs[@]}" -ge 2 ] || { echo "::error::tree integrity: too few compile sets committed (${#inputs[@]})"; exit 1; }
perl "$PROV/tree-integrity.pl" "$ROOT/contractsV2-deployed" "$PROV/forge-additions.txt" "${inputs[@]}"
