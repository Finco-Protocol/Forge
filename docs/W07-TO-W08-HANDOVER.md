# W07 → W08 handover

Status after W07 (see `docs/W07-OPERATIONAL-RELIABILITY.md` for the full backlog matrix and evidence): engineering stabilization complete; `PRODUCTION_BLOCKED=true` and every other freeze flag unchanged; production readiness remains false. This file lists ONLY remaining actionable work and external dependencies. The original W08/W09 roadmap is unchanged.

## 1. Remaining engineering items (W08)

| ID | Item | Where | Why it remains |
|---|---|---|---|
| E1 | Compose-level backup/restore into a NEW database with ledger-digest agreement | `w06-compose-smoke.yml` (Correction A) + `apps/forge-web/scripts/w06/staging-ops.ts` | CLOSED in Correction A: the smoke now stops the worker, `pg_dump`s the running staging database, restores into a second `forge_restore` database, and asserts identical canonical ledger digests via `staging-ops snapshot` on both. The final smoke run id/SHA is recorded in `docs/W07-OPERATIONAL-RELIABILITY.md` §4. |
| E2 | Genuine V4 graduation in the browser journey (brief §6.3) | `apps/forge-web/test/e2e/w06-journey.spec.ts` step 11 | Documented W08 integration target; sandbox pool remains the browser evidence; genuine V4 acceptance is `test/v4` (A06) |
| E3 | W08 real-beta readiness wiring | release/readiness-items.json | A17 now covers operational reliability; W08 adds beta-acceptance items per its own brief |

## 2. External / operator dependencies (unchanged classes)

- **B01** GitHub App registration; **B02** KMS/HSM custody; **B03** production Safe+timelock; **B04** production RPC; **B05** deployment/treasury approval; **B06** alert routing/on-call escalation (W07 made every alert reachable — routing contacts remain operator config); **B07** production backup/restore; **B08** real CREATE2 hook salt; **B09** Robinhood production-write acceptance.
- **C01/C02** independent audit + findings closure; **C03** F-03/F-04 owner-powers review (`EXTERNAL_FINANCIAL_GOVERNANCE_REVIEW_REQUIRED`); **C04** BUSL/legal; **C05** launch terms; **C06** FINCO tokenomics/burn.
- Security baseline: 302 entries, `PROPOSED_BY_AGENT_PENDING_INDEPENDENT_REVIEW` — independent review still required.

## 3. Governance decisions opened or kept open by W07

| Decision | Context |
|---|---|
| Authority kill-switch latch/delay | `setEligibilityAuthority(0)` is owner-reversible with no timelock (D12 — natspec now says so; behavior pinned by test). A latch or ownership separation is a contract change requiring owner authorization |
| `renounceOwnership` on the three renounceable surfaces | `ForgeBindingRegistry`, `ForgeLaunchAuthorizer`, `PonsV2LaunchAndBuy` (W07 added the third to the matrix). Disabling renounce is a contract change requiring owner authorization |
| `PonsV2LaunchAndBuy` deployability | Classified and documented as source-only (no deploy plan); wiring it as `launchForwarder` is an owner decision requiring review (D11) |

## 4. W08 acceptance instructions for A07e (unchanged)

`docs/W06-ROBINHOOD-A07E-ASSESSMENT.md` §5: a source-proven ArbSys on the fork (`STATICCALL 0x64.arbBlockHash(n)` == RPC hash for fork-origin AND locally mined blocks), steps 7–9 un-deferred in the same change, production attestor path, reconciled ledger, no contract/gate changes. Never a mocked precompile or skipped-step conversion.
