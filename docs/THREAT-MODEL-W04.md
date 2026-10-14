# W04 Threat Model & Financial Test Map

Scope: `ForgeProtocolRevenueSplitter`, the canonical-escrow claim flows, the W04 ledger, reconciliation, and the creator and treasury UIs, all in the sandbox.

Abbreviations in the evidence column:

- **Sol** = `test-forge/ForgeRevenueSplitter.t.sol` (unit and fuzz) and `ForgeRevenueSplitterInvariantTest`.
- **Life** = `test-forge/ForgeRevenueLifecycle.t.sol`: the real stack with the canonical escrow.
- **Int** = `apps/forge-web/test/integration/economics.test.ts`: real contracts on a standard Anvil, through the real API.
- **Unit** = `apps/forge-web/test/unit/finance-ledger.test.ts`.
- **E2E** = `apps/forge-web/test/e2e/w04-economics.spec.ts`.

## 1. Required financial scenarios (1–28)

| # | Scenario | Evidence |
| --- | --- | --- |
| 1 | 70/20/10 eligible base-fee distribution | Sol `test_native_70_20_10_on_eligible_base_fee`; Life `test_curve_fees_70_20_10_creator_tax_excluded`; Int 1/2, 3; E2E |
| 2 | Creator tax exclusion | Life `test_curve_fees_70_20_10_creator_tax_excluded`; Int 1/2; Unit (base/tax split) |
| 3 | Native ETH payout | Sol native; Int 3, 8 |
| 4 | ERC-20 quote payout | Sol `test_erc20_70_20_10`; Life `test_erc20_quote_launch_70_20_10` |
| 5 | Mixed-asset accounting | Sol `test_mixed_assets_isolated`; invariant (ETH and token ledgers) |
| 6 | Zero and dust amounts | Sol `test_zero_pull_reverts_and_dust_rounds_to_treasury` |
| 7 | Integer rounding | Sol `testFuzz_cumulative_split_exact`, `testFuzz_extreme_amounts`; Unit derived split |
| 8 | Partial claim | Sol `test_partial_repeated_and_unauthorized_claims`; Int 8 (treasury) |
| 9 | Repeated claim | Sol same; Int 8/9 (`NOTHING_TO_CLAIM`) |
| 10 | Unauthorized claim | Sol same; Int 10 (API 403 and contract revert) |
| 11 | Third-party donations | Sol `test_direct_eth_and_token_transfers_are_non_revenue`, `test_escrow_credit_by_third_party_emits_depositor`, cases B–E (§1a); Int 11/13; Unit |
| 12 | Fee-on-transfer | Sol `test_fee_on_transfer_measured_on_receipt` |
| 13 | Rescue transfers | Life `test_launch_fee_and_rescue_are_non_revenue`; ledger `OWNER_RESCUE_*` exceptions |
| 14 | Creator fee recipient rotation | Life `test_creator_recipient_rotation` (owner override is timelocked) |
| 15 | Governance policy changes | Int 15/16/17; Life `test_policy_snapshot_frozen_across_launches` |
| 16 | Frozen launch snapshot | Life same; Int 15/16/17 |
| 17 | Different policies across launches | Life same (30% vs 20%); Int 15/16/17 (fails closed) |
| 18 | Buyback enabled vs disabled | Life `test_buyback_vest_is_separate_and_not_revenue`; Int 18/19 (35% cash + 35% lock) |
| 19 | Five-year PONS vesting separation | Life same: vest releases arrive in the launch token, which the splitter refuses |
| 20 | Pre- and post-graduation fees | Life `test_post_graduation_hook_fees_reach_splitter`; Int 20 |
| 21 | Double-credit protection | Unit (credits − claims); invariant `revenue == measured pulls` |
| 22 | Duplicate or reordered events | Unit `is identical under duplicate delivery and arbitrary input order` |
| 23 | Blockchain reorganization | Int 21/23; Unit |
| 24 | Indexer restart and replay | Int 24: full wipe and re-index gives an identical report |
| 25 | Treasury liability reconciliation | Int 25; invariant `balances cover liabilities` |
| 26 | Burn reserve cannot swap or burn | Sol `test_reserve_has_no_exit`; invariant `invariant_burn_disabled`; Int 8 |
| 27 | Ineligible revenue cannot enter 70/20/10 | Sol cases A–N (§1a); Life `test_third_party_credit_amid_real_fees_is_not_allocated`, `test_policy_snapshot_frozen_across_launches` (ineligible launch never attested); Int 11/13 and Correction A P1; Life launch fee, rescue and vest; Unit |
| 28 | Unauthorized policy recipient substitution | Int 28 (hook recipient → EOA is flagged; new launches fail closed); Sol recipient timelock |

## 1a. Correction A — revenue provenance (P1), claim attestation (P2), quote-asset authority (P3)

Reproduction (pre-correction, real escrow): `test_reproduction_third_party_credit_is_not_allocated` now asserts the corrected behaviour (only the verified 0.03 ETH is allocated; the 1 ETH third-party credit stays in escrow).

| Case | Scenario | Evidence |
| --- | --- | --- |
| A | Legitimate fee credit only: correct 70/20/10 | Sol `test_A_native_70_20_10_on_eligible_base_fee`; Life curve and hook tests; Int 3, 20 |
| B | Third-party credit only: zero allocation | Sol `test_B_third_party_only_allocates_nothing` |
| C | Fee plus third-party credit: allocate ≤ verified fee | Sol `test_C_legit_plus_third_party_bounded_by_verified`; Life `test_third_party_credit_amid_real_fees_is_not_allocated`; Int P1 |
| D / E | Third-party credit before and after a sweep | Sol `test_D_E_third_party_before_and_after_sweep`; Int P1 (credits on both sides of the sweep) |
| F | Partial pulls, rounding and conservation | Sol `test_F_zero_pull_reverts_and_dust_rounds_to_treasury`, `testFuzz_F_partial_pulls_conserve`, `testFuzz_cumulative_split_exact`; invariants |
| G | Multiple sweeps, no double count | Sol `test_G_multiple_sweeps_never_double_count` (cumulative, not additive; old auth replay refused) |
| H | Reorganised or stale evidence refused | Sol `test_H_reorged_or_stale_evidence_refused` (orphaned hash, > 256 blocks, current block, zero hash); Int 21/23 (authorization reorged out with its sweep) |
| I | Expired, replayed or decreasing authorization refused | Sol `test_I_expired_replayed_decreasing_refused` |
| J | Assets, factories, escrows, chains and splitters isolated | Sol `test_J_bindings_isolated`, `test_mixed_assets_isolated`; Unit EIP-712 digest binding |
| K | Unauthorised signer refused; revocation; role separation | Sol `test_K_unauthorized_signer_refused`, `test_K_attestor_roles_separated_and_rotation_timelocked`; Int P1 (non-attestor signature refused on chain) |
| L | Failed escrow claim leaves no state | Sol `test_L_failed_escrow_claim_no_mutation` |
| M | Creator share and creator tax untouched | Sol `test_M_creator_share_and_tax_untouched`; Life curve test; Int 1/2 |
| N | Canonical escrow and PONS sources unchanged | `provenance/verify-parity.sh` (`SOURCE_PARITY_GATE_OK`, `PonsV2FeeEscrow` RUNTIME-PARITY-PROVEN); `scripts/check-vendored-deps.sh`; the diff touches no PONS source |

Claim transaction attestation (P2), all in Int `W04 Correction A (P2)`, with the content rules unit-tested in Unit:

| # | Case | Outcome |
| --- | --- | --- |
| 1 | Valid native `claim(uint256)` | `MINED_AWAITING_INDEXER` → `CONFIRMED_INDEXED` only after the canonical `Claimed` is indexed |
| 2 | Valid ERC-20 `claimToken(address)` | `CONFIRMED_INDEXED` |
| 3 | Valid treasury `claimTreasury(address,uint256)` | `CONFIRMED_INDEXED` |
| 4 | Wrong sender | 403 `NOT_YOUR_TRANSACTION` |
| 5 | Wrong recipient contract | 422 `WRONG_RECIPIENT_CONTRACT` |
| 6 | Wrong selector (`credit` on the escrow) | 422 `WRONG_SELECTOR` |
| 7 | Wrong asset | 422 `WRONG_ASSET` |
| 8 | Wrong amount (including full-balance semantics) | 422 `WRONG_AMOUNT` |
| 9 | Unrelated successful transaction | 422 `WRONG_RECIPIENT_CONTRACT`; never a claim |
| 10 | Dropped transaction | `UNVERIFIED_PENDING`, still unverified after indexing |
| 11 | Reverted transaction | `FAILED` |
| 12 | Reorged transaction | After the reorg, no longer `CONFIRMED_INDEXED`; `verified: false` |
| 13 | Duplicate submission | Idempotent (`duplicate: true`, one row); conflicting details → 409 `DUPLICATE_SUBMISSION_MISMATCH` |
| 14 | Pending hash with no proven contents | `UNVERIFIED_PENDING`; no selector or verification timestamp stored |

Quote-asset authority (P3): Sol `test_P3_native_eth_always_supported`, `test_P3_unsupported_quote_refused` (not listed, economics only, no economics, decimals mismatch), `test_P3_launch_token_refused`, `test_P3_factory_not_wired_fails_closed`, `test_P3_disabled_quote_keeps_historic_liabilities_claimable`, `test_fee_on_transfer_measured_on_receipt`; Life `test_buyback_vest_is_separate_and_not_revenue` (launch token refused by the real factory); Int P3 (real factory approval accepted; unsupported ERC-20 and launch token refused; later de-listing keeps the approval).

## 2. Invariants (fuzzed, 64 runs × 32 depth)

- `revenueReceived ≤ verified eligible credits` and `escrowClaimed ≤ eligibleCeiling`: third-party credits (fuzzed separately) never enter 70/20/10.
- `escrow balance of the splitter key == verified + third-party − escrowClaimed`, and `≥ third-party credits`: third-party credits never leave the escrow.
- An attempted pull above the verified headroom always reverts (`overPull` handler).
- `revenueReceived == Σ measured pulls`: no other path creates revenue.
- `treasuryAllocated + reserveAllocated == revenueReceived`: every unit is allocated exactly once.
- `reserveAllocated == floor(revenueReceived / 3)`.
- `treasuryPaid ≤ treasuryAllocated` and `nonRevenueReleased ≤ nonRevenueReceived`: no overclaim.
- `deficit == 0`: on-chain balance covers every liability.
- `FINCO_BURN_ENABLED == false`.

## 3. Threats and dispositions

| Threat | Disposition |
| --- | --- |
| Splitter confiscates creator funds | Impossible by construction: the escrow pays `msg.sender`, and the splitter only ever claims its own key. There is no creator-fund path. |
| Owner drains treasury or reserve | No owner withdrawal of allocated liabilities exists. `releaseNonRevenue` is limited to the non-revenue bucket and the fixed treasury recipient. The reserve has no exit. |
| Treasury recipient hijack | Changing it requires a 3-day timelock and an execution window, and both steps emit events. The current and pending recipient are shown in Governance. |
| Recipient substitution at the hook | Detected (Governance warning). It affects only launches created after the change; those are marked ineligible. |
| Policy re-peg of existing launches | Impossible. The snapshot is immutable per launch, and the W02 economics digest binds creator consent to the policy. |
| Donation inflating "revenue" | Direct transfers are non-revenue. Third-party escrow-key credits are never attested, so `pullRevenue` cannot debit them (Correction A ceiling); they stay in the escrow and are reported as `UNATTRIBUTED`. |
| Faulty or compromised revenue attestor | Explicit trust boundary. Worst case: third-party credits already under the splitter's escrow key are pulled as revenue. It cannot mint, reach creator funds or withdraw, and is bounded by the escrow balance. Signatures are bound to chain, splitter, escrow, factory and asset, with an increasing nonce, a deadline and a canonical evidence block hash checked by `blockhash`. The attestor is separate from the owner and the treasury recipient; rotation is timelocked; revocation is immediate. The service refuses to sign above `escrowClaimed + escrow balance`. Production signing is disabled. |
| Reorganised evidence | The splitter refuses an evidence hash that differs from `blockhash`, and evidence older than 256 blocks. The service signs only up to the indexer checkpoint (which applies W03 confirmations and reorg rollback) and never lowers a ceiling; an on-chain ceiling above recomputed evidence is reported as `RECONCILIATION_MISMATCH`. |
| Unsupported quote asset | Approval is derived from the wired factory's `approvedPairTokens` and `pairTokenEconomics` plus a `decimals()` check, and fails closed when no factory is wired. Launch tokens are refused. |
| Fee-on-transfer, rebasing or blocklisting quote asset | Receipts are measured on delta. A deficit is reported (`SPLITTER_DEFICIT`). Assets need explicit approval, and launch tokens and EOAs are refused. Partial pulls and claims work around per-transfer limits. |
| Reentrancy during pull or claim | Pull and claim are `nonReentrant`. State and events are committed before the transfer. Native escrow payments are accepted only while a pull is pending. |
| Indexer double counting | The ledger is a pure projection, idempotent by event identity, with reorg rollback inherited from W03. |
| Misleading UI totals | Amounts are per asset, with no cross-asset sums and no prices. Estimates (accrued, unswept) and derived per-project splits are labelled as such. |
| Admin impersonation in claims | The API only prepares unsigned transactions for the session's bound wallet. The contract enforces `msg.sender`. |
| Forged or misleading claim submissions | A submitted hash is valid only when its contents are proven (chain, sender, canonical contract, exact selector, decoded asset and amount, zero value), its receipt succeeded, and the canonical claim event is indexed for that wallet and asset. Hashes that are not visible stay `UNVERIFIED_PENDING`. |

## 4. Residual trust assumptions (for independent review)

1. The splitter owner, hook owner and factory owner are single sandbox keys. A timelocked multisig must replace them before any production use (`FORGE_FEE_POLICY_AUTHORITY_UNPROVEN`).
2. F-03 (owner override of the creator fee recipient, 3-day notice) and F-04 (rescue hatches with no timelock) remain standing owner powers. They are visible, not removed.
3. The escrow's permissionless credit lets third parties credit the splitter key. Correction A keeps such credits out of 70/20/10 with an attested ceiling. Eligibility is attested by a **trusted** off-chain attestor (sandbox key, production signing disabled), not proven on chain.
4. The fee-sweep operator chooses price floors for conversion and buyback swaps.
