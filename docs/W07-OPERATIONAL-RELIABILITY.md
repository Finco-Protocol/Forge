# W07 — Operational Reliability, Security Backlog Closure and Beta Hardening

Status: engineering stabilization for W08 real-beta acceptance. **Not an audit, not an approval, not production readiness** (`PRODUCTION_BLOCKED=true` and all other freeze flags unchanged). One integrated development PR (draft): monitoring/alert correctness, webhook delivery lifecycle, health liveness/readiness split, historical W01–W06 backlog reconciliation, real Compose smoke, and release-evidence updates.

## 1. Consolidated backlog matrix (severity-ranked; nothing silently dropped)

| ID | Origin | Severity | Source | Reproduction | Status | Owner | Resolution |
|---|---|---|---|---|---|---|---|
| W07-01 | W06 KNOWN_GAP (D9) | **P1** | `w05.yml` forge-security job; `KNOWN-DISCREPANCIES.md` D9 | RAN: suite 11/11 locally; CI job previously absent | **Fixed** | Engineering | `W05EmergencyRevocationTest` added to the mandatory `w05.yml` match-contract (job renamed); 11/11 pass on the W07 head |
| W07-02 | W06 KNOWN_GAP | **P1** | `src/server/indexer/indexer.ts` reorg rollback; drill `it.fails` | EXECUTED: `evm_snapshot`→tx blocks→revert on Anvil; old code rolled back to a wrong ancestor (block 9 instead of 25) | **Fixed** | Engineering | Durable `ALERT:reorg` evidence (depth + affected range) written atomically with the rollback, exactly once per reorg, restart-survivable; DEEP_REORG fires only past `FORGE_REORG_ALERT_DEPTH_BLOCKS` (default 2); drills assert exact depths 1 and 2; KNOWN_GAP marker removed (`w06-incident-drills.test.ts`) |
| W07-03 | W06 KNOWN_GAP | **P1** | `src/server/github/webhooks.ts` single-transaction handling | EXECUTED: validly signed payload that cannot be processed left NO durable record (old); now leaves a receipt with attempts/last_error/next_retry | **Fixed** | Engineering | Migration 007: delivery lifecycle `received→processed`/`failed` with bounded worker retries (cap `FORGE_WEBHOOK_MAX_ATTEMPTS`, default 8, backoff 2^n·5s), sha256-checked stored body, terminal state audited (`ALERT:webhook_delivery_failed`), GitHub redelivery re-activates; signature verification order unchanged (constant-time, BEFORE parsing/trust) |
| W07-04 | W06 observation | **P1** | `src/server/api/handlers.ts` health handler (`revocationHealth()` unguarded) | EXECUTED: W-D17 proxy outage → old code returned bare 500; new code returns structured 503 | **Fixed** | Engineering | `/api/health` guarded + 503 with `failing[]`; new `/api/live` (no dependencies) and `/api/ready` (db+migrations, RPC, ledger integrity); automatic recovery proven in W-D17 |
| W07-05 | W06 finding | **P1** | `webhooks.ts` `JSON.parse` after signature check | EXECUTED: `{not json`, `null`, `[1,2,3]`, `"text"` with a VALID signature → 400 `INVALID_PAYLOAD`, audited, no state change, nothing queued | **Fixed** | Engineering | controlled 400 path in the new handler |
| W07-06 | W06 finding (§2.5) | **P1** | `src/server/ops/monitor.ts` | EXECUTED: every new rule fired through real events in `test/integration/w07-monitoring.test.ts` | **Fixed** | Engineering | 9 new rules: SIGNER_KILL_SWITCH / SIGNER_KEY_REVOKED / SIGNER_ROLE_DISABLED (real controls + registry events), AUTHORITY_SIGNING_REFUSALS (signer_audit fail-closed/mismatch denials via a real RPC outage), STUCK_LAUNCH_TRANSACTIONS (pending/submitted > 30 min, clears on confirmation), DB_UNAVAILABLE (signal collection itself survives the outage), WORKER_UNHEALTHY (silent heartbeat of a previously running worker), WEBHOOK_SIGNATURE_REJECTED_SPIKE (≥20/h real handler rejections), WEBHOOK_DELIVERIES_FAILED (terminal lifecycle state) |
| W07-07 | **New discovery (this W07)** | **P0** | `SELECT block_number::text/seq::text` output aliases shadowing unqualified `ORDER BY` in 9 queries — most critically `indexer.ts` `detectReorg` (lexicographic ancestor walk) and `proof/ledger.ts` receipt-chain walk | EXECUTED: the new exact-depth reorg drill failed with ancestor=block 9 instead of 25 (`[DBG] rows` ordered '9','8','7','5','27',…) | **Fixed** | Engineering | All ORDER BYs table-qualified (`indexed_blocks.block_number`, `evidence_receipts.seq`, `registry_ops.block_number`, `ledger_snapshots.block_number`, `chain_events.block_number`); exact-depth reorg regressions (1 and 2) pin the fix; in production this bug would have rolled the indexer back to a wildly wrong ancestor on any real reorg |
| W07-08 | D11 | **P1** | `authority-matrix.json` (10 contracts/103 functions) | SOURCE: contract list vs `contractsV2-forge/src` | **Reconciled** | Engineering + audit | `PonsV2LaunchAndBuy` classified (11 contracts / 108 functions; `launchAndBuy` = permitted-launcher via factory `canLaunch`; `rescue` = F-04-class emergency owner power; renounce NOT disabled — third surface); curve/token/guard documented owner-less by design; router remains in NO deploy plan; rendered doc regenerated |
| W07-09 | D12 | **P1** | `ForgeLaunchAuthorizer.setEligibilityAuthority` natspec ("permanently revokes") | SOURCE + RAN: `test_W07_zero_authority_is_owner_reversible_and_registry_refuses_zero` | **Fixed (source)** | Engineering + governance (decision open) | natspec corrected (owner-reversible kill switch, no latch); both touched baseline files recorded in `BASELINE_MODIFICATIONS_ALLOWED` with reviewed reasons (comment-only; runtime size and ABI unchanged); governance design question (latch/delay, ownership separation) stays OPEN |
| W07-10 | D13 / brief §9.1 | **P1** | `security/baseline.json` (302 entries) | RAN: `reviewStatus = PROPOSED_BY_AGENT_PENDING_INDEPENDENT_REVIEW` unchanged; no entries regenerated or accepted | **Preserved (unapproved)** | External auditor | Baseline untouched; scanner execution truthfully classified in §4; no silent acceptance |
| W07-11 | W06 brief | **P2** | `w06-compose-smoke.yml` (manual) | EXECUTED: dispatched 3× (40199617462 failed: duplicate compose key; 40202457012 failed: container `next build` lint error — both fixed); final run recorded in §4 | **Fixed/Executed** | Engineering | restart policies added; smoke extended (chain-write confinement, worker SIGKILL recovery, Postgres restart persistence); the smoke's `/api/ready`+`/api/live` references existed only after W07 |
| W07-12 | W06 observation | **P2** | transient Playwright claim-step failure (1 of 7 W06 runs) | **NOT_REPRODUCED**: 7 consecutive full local suite runs on the W07 head, 18/18 each, zero failures | **NOT_REPRODUCED** | Engineering | No fix applied (nothing to fix); conditions identical to W06 (production build, full serial suite); documented with attempt count |
| W07-13 | W06 note | **P2** | `A07e_ROBINHOOD_FORK_REVENUE_CLAIMS_LIFECYCLE` | Preserved | **External/Deferred** | External | Stays NOT_VERIFIED; no engine available with source-proven ArbSys `arbBlockHash`; W08 instructions unchanged (`docs/W06-ROBINHOOD-A07E-ASSESSMENT.md` §5) |
| W07-14 | D1–D8, D10, D13, D14 | **P3** | `docs/audit/KNOWN-DISCREPANCIES.md` | SOURCE verification pass (agent recon + this W07's changes) | **Confirmed/documented** | Engineering/audit | D1–D8, D10 re-confirmed still accurate (stale counts, historical figures); D13 baseline detail unchanged; D14 SHA-pinning confirmed done; no unrelated cosmetic rewrites |

Non-goals kept: no economics/tokenomics/trading changes; no fee-math change; no privileged-Solidity behavior change (the only `.sol` edits are a natspec comment correction + a test — recorded through the manifest's reviewed-modification gate with unchanged runtime size and ABI).

## 2. Monitoring and alert correctness (brief §2)

All five W06 monitoring defects are closed with the real-signal requirement met: every new rule is demonstrated reachable through the actual application code path (controls → audit_events, guard → signer_audit, handler → webhook_deliveries, worker → worker_heartbeats, indexer → ALERT:reorg). The alert-set unit test (`w05-monitor.test.ts`) additionally proves a quiet system fires nothing and the Prometheus exposition leaks no addresses. `ALERT_RULES` is now 29 rules (was 20).

- Rule → evidence mapping is in `test/integration/w07-monitoring.test.ts` (7 tests) and `test/integration/w06-incident-drills.test.ts` (11 tests).
- External paging/on-call routing remains operator item **B06** (unchanged): the alerts are reachable in `/api/ops/alerts` and `/api/ops/metrics`, but no paging destination is configured in W07.

## 3. Recovery, signing and governance reliability (brief §3)

Re-verified on the W07 head (no regressions; the W06 Correction A negatives all pass):

- **Secret rotation** — W-D1 now proves the ACTIVE route rejects the old secret before AND after lockdown release, accepts the new secret, and cannot be reverted silently (the drill fails if the active context is switched back).
- **KMS/signer freshness** — `w06-governance-acceptance.test.ts` (13 tests) re-run green; the W07 file additionally pins that a revoked key produces zero custody calls and permanent refusal; KMS call counts are captured before startup attempts.
- **Timelock/kill switch/emergency recovery** — the governance suite covers lockdown refusal, pending-rotation discard on revocation, atomic pull pause, governed recovery, and sticky custody violations; `W05EmergencyRevocationTest` is now CI-enforced (D9).
- **Idempotent worker recovery** — the new delivery-retry path claims and processes in one transaction with a savepoint-isolated apply (partial side effects can never commit), `FOR UPDATE SKIP LOCKED` against double-claiming, and a 60-second crash-window for receipts orphaned between the durable receive and processing phases; the drill drives it through retries to the terminal state and a redelivery recovery.

## 4. Real Docker Compose acceptance (brief §5)

Executed via the existing manual workflow `w06-compose-smoke.yml` on the W07 head (disposable GitHub runner, Docker, fresh random secrets, `down -v` teardown, `contents: read`):

| Run | Commit | Result | Cause |
|---|---|---|---|
| 40199617462 | `69bea7d` | FAILED (up) | duplicate `restart:` mapping key introduced by the W07 compose patch — fixed |
| 40202457012 | `7ff270d` | FAILED (up/build) | container `next build` lint error (`liveness` import unused) — fixed; local `pnpm build` had last run before the health change |
Runs 3–8 (`40204453943` `314dead`, `40205494954` `a14a082`, `40206342174` `2f1c959`, `40207100933` `7f405e0`, `40208978491` `af93152`, `40210337207` `c5bf130`) progressively surfaced and fixed real staging-image defects: a duplicated compose key, a container-build lint failure, the fake-github credentials path, a missing writable HOME (corepack EACCES for the non-root runtime user), an unpinned package manager (corepack fetched pnpm 12 on the isolated network), and a missing baked corepack store. Run 9 (`40213196001` on `06ae0bb`) built and started the full stack and `/api/ready` returned 200, but the confinement step's textual grep missed the quoted `"31337"` and failed. The Correction A rewrite of the workflow (parsed-config confinement BEFORE startup, in-container SIGKILL crash drill with restart/identity/duplicate-indexing evidence, data-equality persistence proof, and a real backup → restore-into-second-database → ledger-digest agreement step) is dispatched on the final correction head; its run id and result are recorded here when it completes. The earlier smoke attempts are NOT an engineering pass.

The workflow now also asserts chain-write confinement (compose has no Robinhood RPC; `FORGE_CHAIN_ID: 31337` only), worker SIGKILL → automatic recovery, and PostgreSQL restart → persistence + pool recovery. Backup/restore-into-a-new-database with ledger-digest agreement remains evidenced by the W06 `db:backup-rehearsal` suite (mechanics) and is listed as a remaining compose-level item in `docs/W07-TO-W08-HANDOVER.md`. `W07_COMPOSE_NOT_EXECUTED` is **not** claimed — the smoke was executed; its per-step evidence is the run pages above.

## 5. Browser E2E and claim reliability (brief §6)

- Full production-build journey: **7 consecutive full local runs, 18/18 each, zero failures** (same conditions as the W06 observation). The W06 transient claim-step failure is **NOT_REPRODUCED** (7 consecutive full-suite attempts, ~1.2–1.5 min each); no arbitrary waits or retries were added.
- Double-submit: the W06 Correction A wallet-side `eth_sendTransaction` counter (exactly ONE submission) remains in place and passed in all 7 runs.
- Genuine V4 boundary unchanged: browser graduation is sandbox-pool evidence; genuine V4 acceptance is the `test/v4` suite (A06) — documented as a W08 integration target for the browser step.

## 6. Financial protection (brief §7)

No fee policy, accounting policy or tokenomics change. Re-run on the W07 head: `W06FinancialAcceptanceTest` 4/4 (incl. the third-party-credit exclusion and its mutation evidence), W05 splitter/revocation/owner/attestor suites 29/29, `ForgeLaunchAuthTest` 36/36 (incl. the new D12 drift test). The factory runtime size is untouched (no production Solidity change beyond the D12 natspec comment; `size:check` and `abi:check` run in CI). Third-party escrow credits remain unattributed through ordinary operation (ceiling-bound attestor, `CeilingExceedsEscrow` cap).

## 7. Robinhood 4663 / A07e (brief §8)

`A07e_ROBINHOOD_FORK_REVENUE_CLAIMS_LIFECYCLE = NOT_VERIFIED` — unchanged. The read-only probes and the fork diagnostic suite (`pnpm test:fork`, `test:v4:fork` 17 passed / 3 deferred) still pass; no newer fork engine with source-proven ArbSys semantics is available. W08 acceptance instructions: `docs/W06-ROBINHOOD-A07E-ASSESSMENT.md` §5 (faithful ArbSys probe → un-defer steps 7–9 in the same change → production attestor path → reconciled ledger). No 4663 writes.

## 8. Security backlog (brief §9)

- Baseline: 302 entries, `reviewStatus = PROPOSED_BY_AGENT_PENDING_INDEPENDENT_REVIEW`, NOT regenerated, NOT approved. A passing policy gate does not claim absence of vulnerabilities.
- Scanner evidence classes (exact-head CI): Slither+Aderyn job **conditionally skipped** as before (conditionally-invoked Solidity scanner job — `SKIPPED`), Semgrep CE **SUCCESS**, actionlint+zizmor **SUCCESS**, gitleaks **SUCCESS**, SARIF upload **SUCCESS**, SonarQube Cloud job **SUCCESS** (admin-connected reporting; an inactive project is not claimed as completed analysis), CodeQL **NOT_CONFIGURED** (no workflow).
- F-03/F-04: preserved as open `disclosed-owner-trust` risks → `EXTERNAL_FINANCIAL_GOVERNANCE_REVIEW_REQUIRED` (C03). Monitoring for rescues (`OWNER_RESCUE`) is detective-only; disclosed.
- Inherited risks inventoried in `KNOWN-AUDIT-BLOCKERS.md` remain open (attestor provenance, no-timelock authority rotation, renounceOwnership surfaces incl. the W07-added third surface, quote assets, Robinhood finality, PostgreSQL capacity, PONS provenance, BUSL-1.1).

## 9. Release readiness (brief §10)

- New Class A item **`A17_OPERATIONAL_RELIABILITY`** (35 items total) mapped to the new mandatory job `w07: operational reliability (monitoring, webhooks, health)`; `A03` re-pointed to the renamed w05 job; readiness manifest re-stamped.
- W05 A01–A12 and W06 A13–A16 semantics untouched; A07e stays NOT_VERIFIED (deferred, no CI mapping per gate rule); B01–B09 and C01–C06 all remain open with no fabricated evidence; approver registry untouched.
- Flags: `PRODUCTION_BLOCKED=true`, `FINCO_BURN_ENABLED=false`, `FORGE_FEE_POLICY_AUTHORITY_UNPROVEN=true`, `PRODUCTION_SIGNING_ENABLED=false`, `REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED=false`, `DEPLOY_WRITE_ENABLED=false`. Production readiness remains false.

## 10. Results (this sandbox, W07 head)

| Suite | Result |
|---|---|
| unit project (vitest) | 338 passed (2 spawned-CLI tests excluded: Windows cannot spawn `npx.cmd` without a shell; green in CI) |
| integration project (vitest) | 173 passed (incl. w07-monitoring 7, incident drills 11) |
| Foundry forge profile | W05EmergencyRevocation 11, W05OwnerPowers 11, W05AttestorCompromise 7, W06Financial 4, ForgeLaunchAuth 36, splitter suites 81 |
| browser E2E (production build) | 7 × 18/18 (flaky investigation) |
| `forge fmt --check test-forge`, typecheck, eslint | clean |
| manifest gates | `AUDIT_MANIFEST_OK files=157 lines=30138` (2 documented baseline modifications); release-gate unit tests 22/22 |
