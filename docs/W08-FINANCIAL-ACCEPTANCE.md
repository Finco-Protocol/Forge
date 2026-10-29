# W08 — Financial acceptance

Status: **ENGINEERING ACCEPTED** (`W08_ENGINEERING_PASS`) at engineering source HEAD `0f171ac4fb5264a6b45eb26a2dd638b71a7b89ab`; Compose PASS run 40914723992 on that SHA. **NOT production-ready**: no financial-policy approval, no operator acceptance, independent review still required (C01–C03). This document separates what is proven by executed tests from what remains. No fee policy, economics, payout permission or contract authority changed in W08 (diff-checked against post-W07 `main`; the only Solidity-adjacent content in W08 is documentation).

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

`apps/forge-web/test/unit/w08-financial-oracle.test.ts` **PASSES in exact-head CI on the engineering HEAD `0f171ac4`** (W08-2 closed). It computes expected amounts *from primitive scenario fees and economic rules*, not production allocation, ledger-fold or rounding helpers. The test inputs cover three launches, two distinct creators, per-launch floors on fees 101/205/331 (protocol contributions 30/61/99), cumulative protocol amount 190, treasury 127 and reserve 63, a third-party escrow credit of 9, an excluded/ineligible launch, a truncated history near attestation, a missing/interrupted creator claim with canonical recovery, and shuffled duplicate events. All assertions pass on the engineering HEAD `0f171ac4`. Unit-level economic reconciliation is complemented by REAL Compose recovery execution (below); this remains **not independent financial governance approval** (C03 open).

## W08-remaining (tracked in docs/W08-TO-W09-HANDOVER.md as W08-2)

- CLOSED (W08-2): the independent oracle passes in exact-head CI on `0f171ac4fb5264a6b45eb26a2dd638b71a7b89ab`. Independent external REVIEW of the financial layer remains open under C01–C03; no large-history or live-chain verification is claimed.
- Reorg-near-attestation and interrupted-claim execution/recovery at the COMPOSE level: **EXECUTED AND PASSING** (Correction D) — `apps/forge-web/scripts/w08-financial-drill.ts` inside the compose web container, run 40911719094 @ `893da5d` (final W08 HEAD), evidence JSON `W08_FINANCIAL_EVIDENCE` with `fail: null`. The drill drives the REAL stack (real OAuth + wallet bind + repository admin proof, real EIP-712 launch tx, real trades crossing the 30 ETH graduation threshold, real sweep credits, real worker attestation) and proves, execution-backed and with no unit-test substitution: (a) a REORG just past the attestation (`evm_revert` to a pre-graduation snapshot) returns events/ceiling/escrow EXACTLY to the snapshot baselines (28→28 events, ceiling and escrow credits fully undone from a 91836734693877550 wei peak) with the ledger reconciling 0/0 — the orphaned attestation authorization cannot survive; (b) the graduation + sweep re-executed canonically (same threshold-crossing buy on the reverted chain) are re-attested by the worker with fresh in-window evidence (ceiling recovered, headroom > 0); (c) the creator claim (520408163265306122 wei) sent while the worker is STOPPED drains the escrow exactly, indexes ZERO events during the interruption, is indexed EXACTLY ONCE after the restart (still exactly 1 after +10 s of extra passes), the duplicate claim pays nothing and the ledger reconciles 0/0. The drill also exposed a REAL compose defect (compose `start` re-runs the deploy one-shot and swapped `deployment.json` under the live stack) — fixed in the same PR; full narrative in docs/W08-STAGING-RECOVERY.md. This remains SANDBOX/ISOLATED evidence (local Anvil, fake GitHub, test keys) — it is not production financial assurance.

## Boundaries

- A green suite is not financial-policy approval. C03 (F-03/F-04 owner powers) remains `EXTERNAL_FINANCIAL_GOVERNANCE_REVIEW_REQUIRED`.
- No trustless on-chain revenue provenance is claimed: the attestor is a trusted component (ceiling-bounded, revocable, timelock-rotated) pending independent review (ATTESTOR blocker open).
- No Robinhood 4663 writes; A07e NOT_VERIFIED.
