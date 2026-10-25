# W06 — Controlled-beta infrastructure, end-to-end staging and independent-audit readiness

Base: `origin/main` `f4fa5e8a02f77958a0552ccaa411f3f1b39b5c1f` (PR #5 normal merge; parents `96d5bea5…`, `b1389264…`; post-merge CI 6/6 workflows success; no overlapping PR). Gap matrix: `docs/W06-GAP-MATRIX.md`.

**This is evidence for an engineering review. It is not an audit, not an approval and not production readiness.** `PRODUCTION_BLOCKED=true`, `FINCO_BURN_ENABLED=false`, `FORGE_FEE_POLICY_AUTHORITY_UNPROVEN=true`, `PRODUCTION_SIGNING_ENABLED=false`, `REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED=false`, `DEPLOY_WRITE_ENABLED=false` are unchanged. No contract, fee policy or economic maths changed. Nothing was deployed; no cloud resource, real token, real asset or Robinhood write was used. The security baseline is still `UNREVIEWED`.

## Implemented vs reused
| Area | Implemented in W06 | Reused (W01–W05) |
|---|---|---|
| Staging | compose/Dockerfile/entrypoint, staging guard, `/api/live` + `/api/ready`, versioned build manifest, snapshot/restore/rollback planning, process-based stack + acceptance (`docs/W06-STAGING.md`) | PostgreSQL mode, migrator with checksums/locks, worker, health/ops endpoints, backup rehearsal, ledger digests |
| Browser | 10-test journey spec (steps 1–20 + negatives), FakeGithub control endpoints, wallet variants, screenshots (`docs/W06-E2E-JOURNEY.md`) | launch/dashboard/treasury UI, existing 3 specs |
| Finance | Foundry sequence fuzz + directed invariants (`test-forge/W06FinancialAcceptance.t.sol`), 26 ledger property tests, invariant → test mapping (`docs/W06-FINANCIAL-ACCEPTANCE.md`) | ledger, attestor, splitter, W05 Foundry suites |
| GitHub App | acceptance matrix + recovery tests; operator setup (`docs/W06-GITHUB-APP-ACCEPTANCE.md`) | W05 readiness checker, webhooks, reconcile |
| KMS / governance | consolidated role-separation, freshness, fail-closed and rotation tests; operator procedures (`docs/W06-GOVERNANCE-OPERATOR-PROCEDURES.md`) | signer registry, fake KMS, Safe/timelock simulation |
| Drills | 8 additional drills + 13-scenario coverage map (`docs/W06-DRILL-COVERAGE.md`) | 15 W05 drills, alert rules |
| Audit | `docs/audit/` dossier (12 files) + deterministic source manifest with drift gate | `SECURITY-REVIEW`, threat models, authority matrix, scanner baseline |
| Gate / CI | items `A13`–`A16`, `w06.yml`, manual `w06-compose-smoke.yml` | release gate, Class B/C untouched |

## Verification run for this candidate (local sandbox; CI on the exact head is authoritative)
| Suite | Result |
|---|---|
| `tsc --noEmit`, `eslint .` | clean |
| unit (vitest) | 361 passed (27 files) |
| integration (real W02 contracts on Anvil) | 162 passed (15 files) |
| PostgreSQL (`test:pg`, real server) | 15 passed |
| staging acceptance (`test:staging`) | 11 passed |
| genuine Uniswap V4, local (`test:v4`) | 42 passed |
| Playwright, production build (all 4 specs) | 18 passed (1 transient failure of `J14-J17` in 1 of 7 full runs; passed in isolation and in the 3 following full runs; cause **not established**, see Known defects) |
| Foundry `--profile forge` | 132 passed, 0 failed (11 suites, incl. W06 fuzz 256 runs) |
| Robinhood read-only (`test:fork`, `NODE_USE_ENV_PROXY=1`) | 7 passed |
| Robinhood fork (`test:v4-fork`) | first full run 15 passed / 2 failed (live-RPC tests) / 3 skipped (A07e steps 7–9); the 2 failing tests pass when re-run alone — live public RPC, not a code change; CI is authoritative |
| `forge` size gate / ABI drift | `EIP170_GATE_OK factory=24470 B margin=106 B`; splitter runtime **11,680 B** (the 11,220 B figure in the PR #5 description was wrong); ABI drift check clean |
| Semgrep CE 1.181.0 (repo config) | 3 findings, all the existing baselined `forge-sql-string-interpolation` in `webhooks.ts`; 0 new. Slither/Aderyn not re-run: no scanned contract file changed |
| actionlint / zizmor (`--min-severity low`) / shellcheck on W06 files | clean |
| audit manifest `--check` | `AUDIT_MANIFEST_OK files=157 lines=30110 (W07 head: files=157 lines=30138)` |

## Statuses
- **GitHub App: `EXTERNAL_GITHUB_APP_CONFIGURATION_REQUIRED`.** No App was registered; the in-process fake is `SANDBOX_NOT_EVIDENCE`. Operator steps: `docs/W06-GITHUB-APP-ACCEPTANCE.md`.
- **KMS / Safe / timelock:** test-only keys and a fake KMS exercised; production custody, Safe owners and timelock are operator items (B02, B03). No production signing was activated.
- **Robinhood 4663:** read-only identity and ArbSys block evidence reproduce; fork lifecycle steps 1–6 and 10 run. **`A07e_ROBINHOOD_FORK_REVENUE_CLAIMS_LIFECYCLE = NOT_VERIFIED`**: on Anvil 1.8.5's 4663 fork the ArbSys precompile answers `arbBlockNumber()` but `arbBlockHash(uint256)` fails (`PrecompileError`; in-EVM `STATICCALL` returns ok=0), so `authorizeEligibleRevenue` can only revert `StaleEvidence` and steps 7–9 cannot run through the splitter. `anvil_setCode` cannot replace a precompile. A genuine method needs a source-proven ArbSys whose `arbBlockHash` returns the RPC hash on the fork; then un-defer the steps (CI would show 11 passed, 0 skipped). Details: `docs/W06-ROBINHOOD-A07E-ASSESSMENT.md`. No skipped test was converted to PASS.
- **Staging:** process-based topology executed; **docker compose NOT executed** (no Docker daemon here). Run `w06-compose-smoke.yml` once.
- **Browser step 11** (graduation) is on the sandbox pool; genuine V4 graduation is evidenced by `test/v4` only.
- **Security baseline:** `UNREVIEWED` (302 entries, 0 open high). Not approved by W06. Slither, Aderyn, Semgrep and CodeRabbit are not an audit.

## Known defects and open observations (reported, not hidden)
Product defects found by the W06 drills, pinned as `KNOWN_GAP`/observation tests and **not fixed** (monitoring semantics deserve their own reviewed change):
1. `DEEP_REORG` alert is dead: the rule reads `audit_events` rows `ALERT:reorg%` that nothing writes (`it.fails` drill; it will fail loudly when the indexer starts emitting the alert).
2. `WEBHOOK_BACKLOG` cannot fire: a delivery is recorded and processed in one transaction, so failed deliveries are invisible to monitoring.
3. During a PostgreSQL outage `/api/health` can return a bare HTTP 500: `revocationHealth()` is awaited outside the per-probe guards (`/api/ready` and `/api/live` behave correctly).
4. A correctly signed webhook with a malformed JSON body throws (HTTP 5xx instead of 400); no state is written.
5. No alert rules exist for `ALERT:signer_*`, a stuck pending transaction, or rejected webhook signatures.
6. `setEligibilityAuthority(0)` is not permanent despite its natspec; the authorizer/registry owner can rotate the authority key without a timelock (observation from the dossier; part of the disclosed owner-power set).
Other observations: a transient Playwright failure of the claim step (1 of 7 full local runs, cause not established — if it recurs in CI, capture the trace before changing anything); `W05EmergencyRevocationTest` is selected by no CI job (passes locally, 11/11); dossier discrepancies listed in `docs/audit/KNOWN-DISCREPANCIES.md` (stale test counts in older docs, baseline `generatedFrom.commit` is `regen`, etc.).

## Remaining blockers (none of them closable by this PR)
Operator (Class B, evidence must be signed by an allowlisted operator — the registry is empty): GitHub App registration (B01), KMS/HSM custody (B02), production Safe + timelock (B03), production RPC (B04), deploy/treasury approval (B05), monitoring routing and escalation (B06), production backup/restore (B07), hook CREATE2 salt (B08), Robinhood production-write acceptance (B09). External (Class C): independent smart-contract audit and findings closure (C01, C02), F-03/F-04 owner-power review (C03), BUSL/legal review (C04), launch terms/regulatory (C05), FINCO tokenomics/burn (C06). Also: A07e fork steps 7–9, the docker-compose execution, and the baseline review.
