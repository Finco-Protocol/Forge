# W08 — Integrated beta acceptance and operator validation

Status: **ENGINEERING ACCEPTED** (`W08_ENGINEERING_PASS`) at engineering source HEAD `0f171ac4fb5264a6b45eb26a2dd638b71a7b89ab` — all W08 streams closed on that exact SHA. **NOT production-ready**: this is not an audit and no operator acceptance is claimed. All freeze flags unchanged (`PRODUCTION_BLOCKED=true`, `FINCO_BURN_ENABLED=false`, `FORGE_FEE_POLICY_AUTHORITY_UNPROVEN=true`, `PRODUCTION_SIGNING_ENABLED=false`, `REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED=false`, `DEPLOY_WRITE_ENABLED=false`).

Base: post-W07 `main` at `0dae2c6c5f2399bf3303b4be1d6853ad6f84fc34` (merge of PR #7; both parents verified; post-merge CI 34/34 success).

## 1. Inherited backlog (from docs/W07-TO-W08-HANDOVER.md) — disposition

| ID | Item | W08 disposition |
|---|---|---|
| E1 | Compose-level backup/restore + ledger-digest agreement | **Closed in W07 Correction C** (smoke run 40278679711 on `38aaa5d`: `pg_dump` of the running stack → restore into `forge_staging_restore` → reference and materialized digests identical `1bd5df2c…`, financial table counts identical, applied migrations identical) |
| E2 | Genuine V4 graduation in the browser | **CLOSED (W08-1)**: the dedicated `W08_E2E_GENUINE_V4=true` production-build Playwright job (genuine PoolManager/PositionManager/Permit2 on local Anvil, runtime provenance, positive liquidity, minted PositionManager position, browser graduation, J14–J17) PASSED on the engineering HEAD `0f171ac4` in the exact-head CI (66 successful check-runs; `w08: genuine V4 browser graduation (local Anvil)` = success). Lower-level `test/v4` remains complementary |
| — | Fault-injection recovery (W08 §2.3) | **Implemented this pass**: web-crash, RPC-outage and migration-drift-refusal drills added to the compose smoke (§2) |
| — | Real GitHub App / real KMS / real Safe | **External**: unchanged B01–B03 (§3) |
| — | Playwright claim intermittency | NOT_REPRODUCED in W07 (7/7 full runs); monitoring continues |

## 2. W08-A — Staging infrastructure and recovery (implemented this pass)

The compose smoke (`.github/workflows/w06-compose-smoke.yml`, manual) now exercises, in order: confinement (parsed config, before startup) → build/start → readiness → **worker** host-SIGKILL crash + restart-policy recovery (W07) → PostgreSQL restart with data-equality persistence (W07) → backup/restore + ledger-digest agreement (W07) → **NEW (W08)**:

1. **Web crash drill** — host-level SIGKILL of the web process; restart policy recreates the container (new StartedAt, increased RestartCount) and `/api/ready` returns 200.
2. **RPC outage drill** — the anvil container is paused (the node is unreachable): `/api/health` must expose `"rpc":{"ok":false}`; after unpause readiness recovers. This proves FAIL-CLOSED behavior under an unreachable chain, not chain confinement. (Correction A, review finding 2: confinement is a separate claim with separate evidence — the resolved-compose-config check in the confinement step; the outage drill additionally includes a signing refusal probe so the fail-closed claim itself is execution-backed, not documentation-only.)
3. **Migration-drift refusal** — a database whose `schema_migrations` names a tampered checksum must be REFUSED by the migrate role (nonzero exit); nothing is half-applied and the stack never serves from it.

**FINAL evidence:** run 40914723992 @ `0f171ac4fb5264a6b45eb26a2dd638b71a7b89ab` (the engineering HEAD) — ALL steps green, including the Correction D financial recovery drill. Earlier: run 40592825745 @ `f4461cc` and run 40290038031 @ `cce1d4a` were green on older revisions and do not validate the final head. Extracted proof lines: web/worker restart-policy recovery (new StartedAt, RestartCount 0→1, heartbeat healthy); RPC outage `failing:["rpc"]` with ZERO custody signatures during the outage; migration drift refused with the specific `MIGRATION_DRIFT` diagnostic (control run green, tampered row verified, nothing applied, original untouched); postgres persistence (counts unchanged, checkpoint 47→53); backup→restore digests identical (`7b310001…` reference = materialized, both databases). Earlier runs on this PR each surfaced one real defect now fixed: unbounded health RPC probe during outages (health hung ~60 s on viem's default timeout — now bounded to 5 s), wrong outage assertion field, missing migrate/digest command credentials, digest payload pollution, and the sign probe's own 96-bit nonce rejected by BindingOp validation before the guard (now uint64-safe, derived from the id's last 15 hex chars).

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
| D: genuine V4 browser graduation | **CLOSED (W08-1)** — exact-head PASS on `0f171ac4` (full J01–J19 execution, minted liquidity/position evidence verified by the job's assertions) |
| E: financial end-to-end | **CLOSED (W08-2)** — the independent oracle passes in exact-head CI on `0f171ac4`, and Compose-level fault execution is now proven by the Correction D financial recovery drill (run 40911719094 @ `893da5d`, re-executed green within compose run 40914723992 @ `0f171ac4`; docs/W08-STAGING-RECOVERY.md) |
| F: Robinhood 4663 | Read-only probes unchanged; A07e NOT_VERIFIED; no writes |
| G: browser/API beta E2E | **CLOSED (W08-3)** — both the standard production-build browser E2E and the dedicated genuine-V4 J01–J19 job (J14–J17 included) PASS on the engineering HEAD `0f171ac4` |
| H: security/failure-path | W07's adversarial set (webhook races, malformed payloads, authority refusals, reorg evidence) preserved and green; new failure-path drills in §2 |

## 5. Exact-head evidence bookkeeping

- **Engineering source HEAD:** `0f171ac4fb5264a6b45eb26a2dd638b71a7b89ab` — exact-head CI: 66 successful check-runs, 1 conditional skip (CodeRabbit), 0 failures; genuine-V4 browser graduation PASS; standard production-build browser E2E PASS; independent financial oracle PASS.
- **Final engineering Compose PASS:** run `40914723992` on that same SHA (`conclusion: success`), including the Correction D financial recovery drill (reorg rollback to snapshot baselines, post-reorg fresh attestation, interrupted-claim exactly-once ingestion, duplicate refusal, zero deficit/surplus, `W08_FINANCIAL_DRILL_OK`, `fail: null`; drill-specific evidence JSON from run 40911719094 @ `893da5d`).
- `40290038031`, `40278679711`, `40592825745` and `f4461cc` are **historical passes on older revisions**, retained as the defect-discovery trail only.
- Any commit AFTER the engineering HEAD that touches only the four W08 documentation files is a **documentation-only delta** accepted under an explicit owner-approved exception: the engineering evidence above is carried forward and NO CI/Compose re-execution is claimed for such commits. CI/Compose execution is never falsely attributed to a commit where it did not run.

## 6. Verdict

**`W08_ENGINEERING_PASS`** — engineering acceptance is proven at `0f171ac4fb5264a6b45eb26a2dd638b71a7b89ab`: exact-head CI green, the compose smoke (with the W08 fault-injection and Correction D financial recovery drills) green on the same HEAD, and streams W08-1…W08-4 closed with recorded evidence. **This is NOT production readiness**: operator acceptance remains separately blocked — B01–B09 (real GitHub App, KMS/HSM custody, production Safe+timelock, production RPC, deployment/treasury approval, alert routing, production backup/restore, real CREATE2 hook salt, Robinhood production-write acceptance) and C01–C06 (independent audit, F-03/F-04 owner-power governance review, BUSL/legal, launch terms, FINCO tokenomics) are ALL still open; Robinhood A07e remains `NOT_VERIFIED`; the security baseline remains `PROPOSED_BY_AGENT_PENDING_INDEPENDENT_REVIEW`; the production freeze flags are unchanged.
