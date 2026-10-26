# W08 — Integrated beta acceptance and operator validation

Status: **engineering development in progress (one Draft PR)**. Not an audit, not production readiness. All freeze flags unchanged (`PRODUCTION_BLOCKED=true`, `FINCO_BURN_ENABLED=false`, `FORGE_FEE_POLICY_AUTHORITY_UNPROVEN=true`, `PRODUCTION_SIGNING_ENABLED=false`, `REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED=false`, `DEPLOY_WRITE_ENABLED=false`).

Base: post-W07 `main` at `0dae2c6c5f2399bf3303b4be1d6853ad6f84fc34` (merge of PR #7; both parents verified; post-merge CI 34/34 success).

## 1. Inherited backlog (from docs/W07-TO-W08-HANDOVER.md) — disposition

| ID | Item | W08 disposition |
|---|---|---|
| E1 | Compose-level backup/restore + ledger-digest agreement | **Closed in W07 Correction C** (smoke run 40278679711 on `38aaa5d`: `pg_dump` of the running stack → restore into `forge_staging_restore` → reference and materialized digests identical `1bd5df2c…`, financial table counts identical, applied migrations identical) |
| E2 | Genuine V4 graduation in the browser | **Open (engineering, large)**: the browser journey still graduates on the sandbox pool; genuine V4 acceptance remains `test/v4` (A06). Not closed in this pass — see §4 |
| — | Fault-injection recovery (W08 §2.3) | **Implemented this pass**: web-crash, RPC-outage and migration-drift-refusal drills added to the compose smoke (§2) |
| — | Real GitHub App / real KMS / real Safe | **External**: unchanged B01–B03 (§3) |
| — | Playwright claim intermittency | NOT_REPRODUCED in W07 (7/7 full runs); monitoring continues |

## 2. W08-A — Staging infrastructure and recovery (implemented this pass)

The compose smoke (`.github/workflows/w06-compose-smoke.yml`, manual) now exercises, in order: confinement (parsed config, before startup) → build/start → readiness → **worker** host-SIGKILL crash + restart-policy recovery (W07) → PostgreSQL restart with data-equality persistence (W07) → backup/restore + ledger-digest agreement (W07) → **NEW (W08)**:

1. **Web crash drill** — host-level SIGKILL of the web process; restart policy recreates the container (new StartedAt, increased RestartCount) and `/api/ready` returns 200.
2. **RPC outage drill** — the anvil container is paused (the node is unreachable): `/api/health` must expose `"rpc":{"ok":false}`; after unpause readiness recovers. Signing fails closed while the chain is unreachable, so confinement holds under the fault.
3. **Migration-drift refusal** — a database whose `schema_migrations` names a tampered checksum must be REFUSED by the migrate role (nonzero exit); nothing is half-applied and the stack never serves from it.

Evidence protocol: run the workflow from the Actions tab on the exact W08 HEAD; record run id + SHA here and in the PR.

## 3. W08-B/C — Real GitHub App, KMS/HSM, Safe/timelock (external, unchanged)

No live GitHub App, KMS/HSM or production Safe exists in this environment; no credentials were invented. The engineering-layer acceptance remains the FakeGithub / fake-KMS / Safe-1.5.0-on-Anvil suites from W05–W07 (all green in CI). Real-operator acceptance stays:

- `B01_EXTERNAL_GITHUB_APP_CONFIGURATION_REQUIRED`
- `B02_SIGNER_CUSTODY` — operator KMS/HSM required
- `B03_GOVERNANCE_SAFE_TIMELOCK` — production Safe + timelock required
- F-03/F-04 owner powers: `EXTERNAL_FINANCIAL_GOVERNANCE_REVIEW_REQUIRED` (C03) — unchanged, unchanged powers
- A07e: `NOT_VERIFIED` (no source-proven ArbSys fork engine); B09 production-write acceptance not performed

## 4. W08-D/E/F/G/H — remaining streams (status)

| Stream | Status |
|---|---|
| D: genuine V4 browser graduation | OPEN — needs the sandbox deployment to graduate through the genuine V4 pool manager in the e2e stack; scoped as the next W08 engineering pass (no new privileged contract behavior permitted) |
| E: financial end-to-end | Existing invariants all green (W06 acceptance suite 4/4, splitter/fuzz suites, ledger reconciliation in the staging acceptance); independent reconciliation additions deferred to the next W08 pass |
| F: Robinhood 4663 | Read-only probes unchanged; A07e NOT_VERIFIED; no writes |
| G: browser/API beta E2E | Full production-build journey 18/18 (W07 evidence, 7× repeats); W08 repeats on the beta stack after the staging drills stabilize |
| H: security/failure-path | W07's adversarial set (webhook races, malformed payloads, authority refusals, reorg evidence) preserved and green; new failure-path drills in §2 |

## 5. Verdict semantics

This document does not claim `W08_ENGINEERING_PASS`. Engineering acceptance requires: exact-head CI green on the W08 HEAD, the compose smoke (with the new drills) green on the same HEAD, and the remaining streams above closed or explicitly blocked. Operator acceptance remains separately blocked (B01–B09 as applicable).
