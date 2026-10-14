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
| 11 | Third-party donations | Sol `test_direct_eth_and_token_transfers_are_non_revenue`, `test_escrow_credit_by_third_party_emits_depositor`; Int 11/13; Unit |
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
| 27 | Ineligible revenue cannot enter 70/20/10 | Int 11/13; Life launch fee, rescue and vest; Unit |
| 28 | Unauthorized policy recipient substitution | Int 28 (hook recipient → EOA is flagged; new launches fail closed); Sol recipient timelock |

## 2. Invariants (fuzzed, 64 runs × 32 depth)

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
| Donation inflating "revenue" | Direct transfers are non-revenue. Escrow-key credits are separated off chain by depositor (on-chain residual: §7 of the architecture document). |
| Fee-on-transfer, rebasing or blocklisting quote asset | Receipts are measured on delta. A deficit is reported (`SPLITTER_DEFICIT`). Assets need explicit approval, and launch tokens and EOAs are refused. Partial pulls and claims work around per-transfer limits. |
| Reentrancy during pull or claim | Pull and claim are `nonReentrant`. State and events are committed before the transfer. Native escrow payments are accepted only while a pull is pending. |
| Indexer double counting | The ledger is a pure projection, idempotent by event identity, with reorg rollback inherited from W03. |
| Misleading UI totals | Amounts are per asset, with no cross-asset sums and no prices. Estimates (accrued, unswept) and derived per-project splits are labelled as such. |
| Admin impersonation in claims | The API only prepares unsigned transactions for the session's bound wallet. The contract enforces `msg.sender`. Submitted hashes must come from the caller's own wallet. |

## 4. Residual trust assumptions (for independent review)

1. The splitter owner, hook owner and factory owner are single sandbox keys. A timelocked multisig must replace them before any production use (`FORGE_FEE_POLICY_AUTHORITY_UNPROVEN`).
2. F-03 (owner override of the creator fee recipient, 3-day notice) and F-04 (rescue hatches with no timelock) remain standing owner powers. They are visible, not removed.
3. The escrow's permissionless credit means on-chain revenue can include third-party credits to the splitter key. This is disclosed and reconciled off chain.
4. The fee-sweep operator chooses price floors for conversion and buyback swaps.
