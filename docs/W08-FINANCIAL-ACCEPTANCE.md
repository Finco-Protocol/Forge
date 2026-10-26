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

## W08-remaining (tracked in docs/W08-TO-W09-HANDOVER.md as W08-2)

- Independent oracle-style reconciliation across multi-launch / multi-creator / multi-block histories (existing suites use production calculations cross-checked by invariant assertions; an independently implemented oracle is the remaining gap).
- Reorg-near-attestation and interrupted-claim lifecycle combinations on the integrated staging stack (covered at unit/integration level; the compose-level drill rides the W08 recovery suite).

## Boundaries

- A green suite is not financial-policy approval. C03 (F-03/F-04 owner powers) remains `EXTERNAL_FINANCIAL_GOVERNANCE_REVIEW_REQUIRED`.
- No trustless on-chain revenue provenance is claimed: the attestor is a trusted component (ceiling-bounded, revocable, timelock-rotated) pending independent review (ATTESTOR blocker open).
- No Robinhood 4663 writes; A07e NOT_VERIFIED.
