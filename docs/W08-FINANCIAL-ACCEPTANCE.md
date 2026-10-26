# W08 — Financial acceptance

Status: **in progress**. This document separates what is proven by executed tests from what remains. No fee policy, economics, payout permission or contract authority changed in W08 (diff-checked against post-W07 `main`; the only Solidity-adjacent content in W08 is documentation).

## Proven by executed tests (carried into W08 CI, all green on the W07 merge head)

| Invariant | Evidence |
|---|---|
| 70/20/10 applies only to the qualifying 30%-protocol-leg snapshot; treasury:reserve = 2:1 of the protocol leg | `W06FinancialAcceptanceTest` (4/4, fuzz 256 runs) + splitter suites (81 tests) |
| Third-party escrow credits are never attested revenue | W06 fuzz keeps a third-party credit unattested while genuine revenue is attested/pulled; mutation check (ceiling over third-party credits) fails the fuzz at run 7; `test_directed_third_party_credit_is_never_attested_or_pulled` |
| Ceiling ≤ genuine revenue; escrow-key balance == third-party credit + genuine revenue − verified claims, at every fuzz prefix | `_assertConservation()` in the W06 fuzz |
| Revoked attestor can never be bypassed by a pending rotation; claims survive pause/revocation | W06 fuzz + `W05EmergencyRevocationTest` (11, now CI-selected) |
| Attestor ceilings, sequential nonces, evidence-block freshness, `CeilingExceedsEscrow` cap | splitter unit suite + W05 attestor-compromise suite |
| Ledger reconciliation (reference recompute vs materialized) and restore digest agreement | `w06 staging acceptance` (CI) + compose backup/restore step (reference = materialized = `1bd5df2c…` on both databases, run 40278679711) |
| Exact wallet submission counts, refusal codes (BAD_SIGNATURE / NOT_ADMIN / NOT_VERIFIED / PAYLOAD_MISMATCH) | browser journey + webhook acceptance suites |

## W08 independent economic oracle — added, final-head CI required

`apps/forge-web/test/unit/w08-financial-oracle.test.ts` now computes expected amounts *from primitive scenario fees and economic rules*, not production allocation, ledger-fold or rounding helpers. The test inputs cover three launches, two distinct creators, per-launch floors on fees 101/205/331 (protocol contributions 30/61/99), cumulative protocol amount 190, treasury 127 and reserve 63, a third-party escrow credit of 9, an excluded/ineligible launch, a truncated history near attestation, a missing/interrupted creator claim with canonical recovery, and shuffled duplicate events. Test assertions must pass on the final SHA. This remains isolated unit-level economic reconciliation, **not independent financial governance approval or real Compose recovery**.

## W08-remaining (tracked in docs/W08-TO-W09-HANDOVER.md as W08-2)

- The independent oracle is implemented, but final-head CI pass and independent review are still required. Any unexecuted large-history/live-chain verification must not be inferred from these unit scenarios.
- Reorg-near-attestation and interrupted-claim execution/recovery at the COMPOSE level: **PENDING** (Correction A, review finding 3). Existing coverage is unit/integration-level only (ledger-fold reorg suites, economics claim-recovery cases) — that is not a full Compose lifecycle drill, and none has been executed yet. Implementing these as compose drills is tracked in this PR's remaining W08 scope; until executed they are classified PENDING, not covered.

## Boundaries

- A green suite is not financial-policy approval. C03 (F-03/F-04 owner powers) remains `EXTERNAL_FINANCIAL_GOVERNANCE_REVIEW_REQUIRED`.
- No trustless on-chain revenue provenance is claimed: the attestor is a trusted component (ceiling-bounded, revocable, timelock-rotated) pending independent review (ATTESTOR blocker open).
- No Robinhood 4663 writes; A07e NOT_VERIFIED.
