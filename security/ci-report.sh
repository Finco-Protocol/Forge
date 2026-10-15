#!/usr/bin/env bash
# The exact command the CI "unified report + policy" step runs (also executed by
# apps/forge-web/test/unit/security-ci-command.test.ts against a tree where security-report/ does not exist).
# Exit codes are those of report.mjs: 0 pass, 1 new critical/high in Forge-owned code, 2 scanner/report/config error.
# `pipefail` makes the node exit status survive the `| tee`; the output dir is created BEFORE the pipeline.
set -euo pipefail
: "${REPORT_COMMIT:?}" "${REPORT_REQUIRED:?}"
ROOT="${REPORT_ROOT:-.}"
OUT="${REPORT_OUT_DIR:-security-report}"
IN="${REPORT_SCAN_IN:-scan-in}"
mkdir -p "$OUT"
node "${REPORT_SCRIPT:-security/report.mjs}" --root "$ROOT" --commit "$REPORT_COMMIT" \
  --out-dir "$OUT" --baseline "${REPORT_BASELINE:-security/baseline.json}" \
  --require "$REPORT_REQUIRED" \
  --slither "$IN/slither.json" --aderyn "$IN/aderyn.json" --semgrep "$IN/semgrep.json" \
  --versions "slither=${SLITHER_VERSION:-},aderyn=${ADERYN_VERSION:-},semgrep=${SEMGREP_VERSION:-}" \
  --not-connected "${REPORT_NOT_CONNECTED:-}" \
  | tee "$OUT/policy.log"
