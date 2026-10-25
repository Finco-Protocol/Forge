# 6. Fee classification and financial invariants

Derived from the contract source at `f4fa5e8a` and cross-checked with `docs/W04-FEE-AUTHORITY.md`, `docs/W04-ECONOMICS-ARCHITECTURE.md` and `docs/THREAT-MODEL-W04.md`. Flags: `FORGE_FEE_POLICY_AUTHORITY_UNPROVEN=true`, `FINCO_BURN_ENABLED=false`, `PRODUCTION_BLOCKED=true`. Nothing here is a statement that the distribution is correct in production; it describes what the code does and which tests pin it.

## 6.1 The 70/20/10 rule, exactly

"70/20/10" applies **only** to an **eligible base trading fee** `F`: a fee of a launch whose frozen fee-policy snapshot has `protocolFeeShareBps == 3000` and `protocolFeeRecipient == the Forge splitter`.

| Share of `F` | Recipient | Mechanism |
| --- | --- | --- |
| 70% | creator | escrow credit under the creator's own key (`credit(deployer)` from the curve; `_payOut(info.creator)` from the hook); claimed by the creator with `PonsV2FeeEscrow.claim*` |
| 30% | Forge protocol leg | escrow credit under the **splitter's** key; moved into the splitter by `pullRevenue`, bounded by the attested ceiling |
| of which 20 points | treasury | `treasuryAllocated`, claimed with `claimTreasury` by the treasury recipient |
| of which 10 points | FINCO reserve | `reserveAllocated`, a liability with **no exit**; `FINCO_BURN_ENABLED` is `constant false` |

Details that matter to an auditor:

- Split inside the splitter: `reserveTotal = floor(lifetimeRevenue * 1 / 3)`; `toReserve = reserveTotal - reserveAllocated`; the treasury gets the remainder of the measured receipt. Per-asset, cumulative, so rounding never drifts and the reserve never exceeds an exact third (`_allocate`, SOURCE).
- Allocation uses the **measured** receipt (balance delta), not the nominal amount, so fee-on-transfer assets stay conservative.
- The 30% default is the hook constructor's `protocolFeeShareBps = 3000` (SOURCE) and the on-chain PONS hook was read at 3000 on 2026-10-08 (`docs/ROBINHOOD-CHAIN-VALIDATION.md`, DOC). The splitter itself does **not** read the share; eligibility per launch is decided by the off-chain attestor from the launch snapshot, and enforced on chain only as a cumulative ceiling.
- The "10" is a **reserve liability**, not a burn and not a buyback. The word "burn" in `buybackBurnBps` and in the PONS buyback vault refers to a five-year vesting **lock** of the launch token, which returns tokens to circulation; it is not supply destruction (`docs/FORGE-CHANGE-MAP.md` section 7). A true burn requires a future executor behind `IFincoBurnReserveExecutor`, a separate FINCO token track, governance and a new splitter version (`BURN` blocker).
- With buyback enabled (hook default `buybackBurnBps = 5000`) half of the **creator** bucket buys the launch token and vests: the creator sees 35% cash + 35% vested tokens, not 70% cash. Vest releases split protocol/creator by the frozen `protocolFeeShareBps` in the launch token.
- The 70/20/10 mapping in `docs/FORGE-CHANGE-MAP.md` section 6 (`protocolFeeShareBps = 2000`, ...) is an earlier design and does not describe the code (KNOWN-DISCREPANCIES D3).

## 6.2 Flow classification

"Eligible" means: may enter the splitter's revenue allocation. Everything else is held or paid elsewhere and is never allocated 70/20/10.

| # | Flow | Source in code | Goes to | Eligible for 70/20/10? |
| --- | --- | --- | --- | --- |
| 1 | Curve base fee (`curveFeeBps`) **including the launch-window snipe tax** | `PonsV2BondingCurve`: `_accrueFees(fee + snipeTax, tax)` then `_sweepFees` | protocol leg -> escrow key `protocolFeeRecipient` (first), creator leg -> escrow key `deployer` | **Yes**, protocol leg, when the snapshot is 30% + splitter. (The snipe tax is part of the base fee in code, so it is split like any other fee) |
| 2 | Hook fee after graduation (`hookFeeBps`) | `PonsV2MemeHook` `afterSwap` -> `sweepPoolFees` -> `_distribute` | creator leg first, then protocol leg, via the escrow | **Yes**, quote-denominated portion, and the memecoin portion once converted |
| 3 | **Creator tax** (`creatorTaxBps`, <= 10%) | curve `creatorTaxBalance`; hook `pendingCreatorTax` | 100% to the creator, added to the creator credit | **No** (excluded). Combined with the creator base leg in one credit; the indexer separates it by per-trade `tax` accumulated since the previous sweep; a hook sweep that converted memecoin-denominated tax is reported **unsplit** |
| 4 | **Launch fee** (`launchFee`) | factory `_payLaunchFee()` | direct ETH call to the hook's **live** `protocolFeeRecipient` (the splitter `receive()` records class `LaunchFee` when `msg.sender == forgeFactory`) | **No**: non-revenue, held; owner `releaseNonRevenue` pays only the treasury recipient |
| 5 | **Rescues** (F-04) | `rescueCurveFees` -> `rescueFees()`; `rescuePoolFees` | direct payment, escrow bypassed; protocol leg lands at the splitter as a plain transfer | **No**: unattributed non-revenue (`recordUnattributed` for ERC-20; native via `receive()`); the ledger raises `OWNER_RESCUE_*` exceptions |
| 6 | `rescueSweptGraduation` / `forceSweptGraduation` | factory | owner-chosen recipient | **No**: holders' reserves, not revenue |
| 7 | **Third-party escrow credits** to the splitter's key | anyone may call `credit` / `creditToken` | stay in the escrow | **No**, by the *intended attestor calculation* (they are never attested into the ceiling; reported `UNATTRIBUTED`). This is **not an on-chain guarantee**: a compromised attestor could attest third-party credits already held under the splitter key (`THREAT-MODEL.md` 5.4). Attested-not-proven (`THREAT-MODEL.md` 5.4) |
| 8 | Direct transfers / donations / forced ETH to the splitter | any | splitter balance | **No**: `NonRevenueReceived` (`UnattributedNative` / `UnattributedToken`) |
| 9 | Graduation residual ("dust") | `PonsV2GraduationExecutor._sweepResidualBalance` | snapshot `protocolFeeRecipient`, direct transfer | **No**: separate class `graduationResidual` (ledger), non-revenue (sender is the executor) |
| 10 | Buyback-vault releases | `PonsV2BuybackVault.release` -> `creditToken` | beneficiaries' escrow keys in the **launch token** | **No**: the splitter refuses launch tokens (`AssetIsLaunchToken`) |
| 11 | Original PONS fees (0x7eD5… factory and its hook/escrow) | outside Forge | PONS | **No**: outside Forge authority |

Per-launch eligibility is decided from the **frozen** snapshot, fails closed, and is not re-evaluated when the owner later changes hook policy (`test_policy_snapshot_frozen_across_launches`).

## 6.3 Invariants and the tests that enforce them

"RAN" = executed for this dossier (`REPRODUCTION.md`); the Solidity suites below all passed. "CI-only/DOC" = enforced by a test this author did not run.

### On-chain (splitter)

| # | Invariant | Enforced by |
| --- | --- | --- |
| F1 | Conservation per asset: `balance >= treasuryLiability + reserveLiability + nonRevenueHeld`; `reconcile().deficit == 0` | `ForgeRevenueSplitterInvariantTest.invariant_native_conservation`, `invariant_token_conservation` (`_check`), 64 runs x depth 32, RAN |
| F2 | `revenueReceived == Σ measured pulls`; no other path creates revenue | same `_check` |
| F3 | `revenueReceived <= verified eligible credits`; `escrowClaimed <= eligibleCeiling` | same `_check`; `test_C_legit_plus_third_party_bounded_by_verified`, `W05AttestorCompromiseTest.test_unbounded_ceiling_is_refused` |
| F4 | `treasuryAllocated + reserveAllocated == revenueReceived`; `reserveAllocated == floor(revenueReceived / 3)` | same `_check`; `testFuzz_cumulative_split_exact`, `testFuzz_extreme_amounts`, `testFuzz_F_partial_pulls_conserve` (256 runs each) |
| F5 | `treasuryPaid <= treasuryAllocated`; `nonRevenueReleased <= nonRevenueReceived` (no overclaim) | same `_check`; `test_partial_repeated_and_unauthorized_claims` |
| F6 | Third-party credits never leave the escrow; `escrowed == verified + thirdParty - escrowClaimed` | same `_check`; `test_B_third_party_only_allocates_nothing`, `test_D_E_third_party_before_and_after_sweep` |
| F7 | The reserve has no exit and `FINCO_BURN_ENABLED == false` | `test_reserve_has_no_exit`, `invariant_burn_disabled` |
| F8 | Zero/dust pull reverts; dust rounds to treasury | `test_F_zero_pull_reverts_and_dust_rounds_to_treasury` |
| F9 | Multiple sweeps never double count (cumulative, not additive); old authorization replay refused | `test_G_multiple_sweeps_never_double_count`, `test_I_expired_replayed_decreasing_refused` |
| F10 | Bindings isolated by asset, factory, escrow, chain, splitter | `test_J_bindings_isolated`, `test_mixed_assets_isolated` |
| F11 | Failed escrow claim leaves no state | `test_L_failed_escrow_claim_no_mutation` |
| F12 | Creator share and creator tax untouched by the splitter | `test_M_creator_share_and_tax_untouched` |
| F13 | Supported assets are source-derived; launch tokens, EOAs, unlisted ERC-20s refused; fails closed with no factory wired; disabling an asset keeps historic liabilities claimable | `test_P3_*` (6 tests), `test_unapproved_asset_fails_closed` |
| F14 | Pause stops pulls, never claims | `test_pause_blocks_pulls_never_claims`; `W05EmergencyRevocationTest.test_F_treasury_claims_remain_executable`, `test_G_creator_escrow_claims_remain_executable` |
| F15 | Treasury recipient and attestor changes timelocked 3 d + 3 d; renounce refused; roles separated | `test_treasury_recipient_rotation_timelocked`, `test_recipient_proposal_expires_and_cancels`, `test_invalid_recipient_and_renounce_refused`, `test_K_attestor_roles_separated_and_rotation_timelocked` |

### On-chain (full stack, canonical escrow)

| # | Invariant | Enforced by |
| --- | --- | --- |
| L1 | Curve fees: 70/20/10 on the eligible base fee, creator tax excluded | `ForgeRevenueLifecycleTest.test_curve_fees_70_20_10_creator_tax_excluded` |
| L2 | Post-graduation hook fees reach the splitter | `test_post_graduation_hook_fees_reach_splitter` |
| L3 | ERC-20 quote launch 70/20/10 | `test_erc20_quote_launch_70_20_10` |
| L4 | Buyback vest is separate and not revenue; launch token refused by the real factory | `test_buyback_vest_is_separate_and_not_revenue` |
| L5 | Policy snapshot frozen across launches (30% vs 20% in different launches) | `test_policy_snapshot_frozen_across_launches` |
| L6 | Third-party credit amid real fees is not allocated | `test_third_party_credit_amid_real_fees_is_not_allocated` |
| L7 | Launch fee and rescues are non-revenue | `test_launch_fee_and_rescue_are_non_revenue` |
| L8 | Creator recipient rotation (owner override timelocked) | `test_creator_recipient_rotation` |
| L9 | Rescues are never eligible revenue (curve and pool) | `W05OwnerPowersTest.test_F04_curve_rescue_is_never_eligible_revenue`, `test_F04_pool_rescue_is_never_eligible_revenue` |
| L10 | Reserve conservation, supply conservation and locker custody through graduation | `ForgeLifecycleTest.test_full_lifecycle_launch_to_graduation` (RAN); upstream curve accounting invariants `test/CurveInvariants.t.sol` (`invariant_curveAccountingConservation`, `invariant_afterGraduationCurveIsDrained`; `testable` profile, not run here) |
| L11 | Anti-snipe tax decays; creator exempt | `ForgeSnipeTaxTest.test_snipe_tax_decays_and_creator_is_exempt` (RAN) |

### Off-chain ledger (not Solidity; DOC for this dossier)

- Pure deterministic projection of indexed events, de-duplicated by `(blockHash, logIndex)`; duplicate or reordered delivery gives an identical result; a reorg is a smaller event set (`apps/forge-web/test/unit/finance-ledger.test.ts`, `ledger-fold.test.ts`).
- Reconciliation against on-chain state at the indexer checkpoint block: statuses `RECONCILED`, `RECONCILED_WITH_UNRECORDED_SURPLUS`, `MISMATCH`; provenance statuses `PROVEN_ELIGIBLE`, `PROVENANCE_BLOCKED`, `RECONCILIATION_MISMATCH` (`docs/W04-ECONOMICS-ARCHITECTURE.md` section 3; `test/integration/economics.test.ts`, 30 cases per the docs).
- Materialized fold with a halt flag: a materialized/reference divergence or unexplained splitter deficit **halts attestation** (`LEDGER_HALTED`) until an operator clears it (`docs/W05-DATABASE-LEDGER.md`).
- Per-asset amounts only; no cross-asset sums, no prices.

## 6.4 Known limits that affect financial correctness

1. **Eligibility provenance is off-chain** (attestor, section 5.4 of the threat model). The on-chain ceiling prevents drain beyond what is already in the escrow under the splitter's key; it does not prove which credits were fees.
2. Hook sweeps that convert memecoin-denominated tax cannot be split exactly between base and tax; reported unsplit.
3. The ledger attributes legs by sweep order (curve credits protocol first; hook credits creator first) and by `depositor`; this relies on the unmodified, parity-proven PONS call order.
4. The fee-sweep operator chooses `minConversionQuoteOut` / `minBuybackTokensOut`; up to `maxInternalPriceImpactBps` (default 3%) per conversion can be extracted by a malicious operator (F-05).
5. The invariant suite fuzzes the splitter with handler actions (credits, third-party credits, over-pull attempts, claims); it does not fuzz the whole launch stack end to end.
6. Burn, buyback executor, FINCO token and conversion route do not exist (`BURN`).
