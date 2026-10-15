# security/

Dependency-free tooling behind `.github/workflows/security-toolchain.yml` (full description: `docs/SECURITY-TOOLCHAIN.md`).

| File | Purpose |
|---|---|
| `report.mjs` | Normalises Slither, Aderyn and Semgrep CE reports; classifies scope (inherited / modified / new Forge code); applies the baseline; exits 0 (pass), 1 (new critical/high in Forge-owned code) or 2 (scanner crash, missing or invalid report, invalid config). |
| `baseline.json` | One triage entry per finding fingerprint (classification, disposition, reason, required fix). No wildcard or rule-wide suppression is accepted. Proposed by the implementing agent until an independent reviewer approves it. |
| `triage-decisions.json` | Decision table from which `baseline.json` is generated. |
| `make-baseline.mjs` | Regenerates `baseline.json` from fresh scanner reports; aborts on any finding without an explicit decision. CI never runs it. |

Local run (after producing `slither.json`, `aderyn.json`, `semgrep.json`):

```
node security/report.mjs --root . --commit "$(git rev-parse HEAD)" --out-dir security-report \
  --baseline security/baseline.json --slither slither.json --aderyn aderyn.json --semgrep semgrep.json \
  --versions slither=0.11.6,aderyn=0.6.8,semgrep=1.181.0
```
