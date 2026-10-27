# W08 — Integrated beta acceptance and operator validation

Status: **engineering development in progress (one Draft PR)**. Not an audit, not production readiness. All freeze flags unchanged (`PRODUCTION_BLOCKED=true`, `FINCO_BURN_ENABLED=false`, `FORGE_FEE_POLICY_AUTHORITY_UNPROVEN=true`, `PRODUCTION_SIGNING_ENABLED=false`, `REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED=false`, `DEPLOY_WRITE_ENABLED=false`).

Base: post-W07 `main` at `0dae2c6c5f2399bf3303b4be1d6853ad6f84fc34` (merge of PR #7; both parents verified; post-merge CI 34/34 success).

## 1. Inherited backlog (from docs/W07-TO-W08-HANDOVER.md) — disposition

| ID | Item | W08 disposition |
|---|---|---|
| E1 | Compose-level backup/restore + ledger-digest agreement | **Closed in W07 Correction C** (smoke run 40278679711 on `38aaa5d`: `pg_dump` of the running stack → restore into `forge_staging_restore` → reference and materialized digests identical `1bd5df2c…`, financial table counts identical, applied migrations identical) |
| E2 | Genuine V4 graduation in the browser | **ENGINEERING IMPLEMENTED, ACCEPTANCE PENDING**: dedicated `W08_E2E_GENUINE_V4=true` production-build Playwright job exercises genuine PoolManager/PositionManager/Permit2 on local Anvil, with runtime provenance, positive liquidity, minted PositionManager position, browser graduation and J14–J17. **Only exact-head passing CI closes this requirement**; lower-level `test/v4` remains complementary |
| — | Fault-injection recovery (W08 §2.3) | **Implemented this pass**: web-crash, RPC-outage and migration-drift-refusal drills added to the compose smoke (§2) |
| — | Real GitHub App / real KMS / real Safe | **External**: unchanged B01–B03 (§3) |
| — | Playwright claim intermittency | NOT_REPRODUCED in W07 (7/7 full runs); monitoring continues |

## 2. W08-A — Staging infrastructure and recovery (implemented this pass)

The compose smoke (`.github/workflows/w06-compose-smoke.yml`, manual) now exercises, in order: confinement (parsed config, before startup) → build/start → readiness → **worker** host-SIGKILL crash + restart-policy recovery (W07) → PostgreSQL restart with data-equality persistence (W07) → backup/restore + ledger-digest agreement (W07) → **NEW (W08)**:

1. **Web crash drill** — host-level SIGKILL of the web process; restart policy recreates the container (new StartedAt, increased RestartCount) and `/api/ready` returns 200.
2. **RPC outage drill** — the anvil container is paused (the node is unreachable): `/api/health` must expose `"rpc":{"ok":false}`; after unpause readiness recovers. This proves FAIL-CLOSED behavior under an unreachable chain, not chain confinement. (Correction A, review finding 2: confinement is a separate claim with separate evidence — the resolved-compose-config check in the confinement step; the outage drill additionally includes a signing refusal probe so the fail-closed claim itself is execution-backed, not documentation-only.)
3. **Migration-drift refusal** — a database whose `schema_migrations` names a tampered checksum must be REFUSED by the migrate role (nonzero exit); nothing is half-applied and the stack never serves from it.

**FINAL evidence:** run 40592825745 @ `f4461cc` (the current PR HEAD's probe fix) — ALL steps green. Earlier: run 40290038031 @ `cce1d4a` was green on an *older* revision and does not validate the current head. Extracted proof lines: web/worker restart-policy recovery (new StartedAt, RestartCount 0→1, heartbeat healthy); RPC outage `failing:["rpc"]` with ZERO custody signatures during the outage; migration drift refused with the specific `MIGRATION_DRIFT` diagnostic (control run green, tampered row verified, nothing applied, original untouched); postgres persistence (counts unchanged, checkpoint 47→53); backup→restore digests identical (`7b310001…` reference = materialized, both databases). Earlier runs on this PR each surfaced one real defect now fixed: unbounded health RPC probe during outages (health hung ~60 s on viem's default timeout — now bounded to 5 s), wrong outage assertion field, missing migrate/digest command credentials, digest payload pollution, and the sign probe's own 96-bit nonce rejected by BindingOp validation before the guard (now uint64-safe, derived from the id's last 15 hex chars).

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
| D: genuine V4 browser graduation | IMPLEMENTED / NOT YET ACCEPTED — `.github/workflows/w03.yml` adds unconditional `w08: genuine V4 browser graduation (local Anvil)` and e2e runtime/provenance checks; require exact-head PASS and inspect full J01–J19 execution |
| E: financial end-to-end | EXTENDED / CI PENDING — independently calculated three-launch/two-creator expected amounts, per-launch rounding and cumulative allocation, excluded third-party/ineligible revenue, partial claim interruption and recovery; W06 fuzz and existing invariants retained. These unit assertions do not constitute Compose-level fault execution |
| F: Robinhood 4663 | Read-only probes unchanged; A07e NOT_VERIFIED; no writes |
| G: browser/API beta E2E | The standard 18/18 baseline is verified on the **previous** exact head `24ffe9f9`; both standard browser CI and the dedicated genuine-V4 J01–J19 job must pass again on the final W08 SHA. J14–J17 must be included, not skipped |
| H: security/failure-path | W07's adversarial set (webhook races, malformed payloads, authority refusals, reorg evidence) preserved and green; new failure-path drills in §2 |

## 5. Exact-head evidence bookkeeping

The last *verified green standard* SHA before the genuine-V4 browser changes was `24ffe9f9c0fbedde4c8a247d8da8b0604e0f0a8b` (61 successful / 1 conditional skipped). The subsequent W08 browser/financial/documentation commits require fresh exact-head CI. `40290038031` and `40278679711` are **historical Compose passes**, not final-head W08 Compose evidence. A new manual `W06 Staging Compose Smoke` workflow-dispatch run must record its **actual** run ID, head SHA and result. Do not write PASS until it succeeds on the same final HEAD. If no dispatch permission is available, mark `MANUAL_COMPOSE_PENDING_OPERATOR_DISPATCH`.

## 6. Verdict semantics

This document does not claim `W08_ENGINEERING_PASS`. Engineering acceptance requires: exact-head CI green on the W08 HEAD, the compose smoke (with the new drills) green on the same HEAD, and the remaining streams above closed or explicitly blocked. Operator acceptance remains separately blocked (B01–B09 as applicable).
