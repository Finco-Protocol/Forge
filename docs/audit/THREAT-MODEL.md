# 5. Threat model (consolidated W02 / W04 / W05)

Consolidates `docs/THREAT-MODEL-W02.md` (launch authorization), `docs/THREAT-MODEL-W04.md` (revenue, claims, ledger) and the W05 attestor / signer / governance material (`docs/W05-SECURITY-GOVERNANCE.md`, `docs/W05-SIGNER-CUSTODY.md`, `docs/W05-INCIDENT-RUNBOOK.md`). Each claim was re-read against `contractsV2-forge/src` at `f4fa5e8a`; test names are the ones present in `test-forge/` at that SHA. Tests marked RAN were executed for this dossier (see `REPRODUCTION.md`: 129 tests passed over 10 suites, 0 failed).

This is a map of what the authors considered and what evidence they point to. It is **not** an independent assessment and does not say the system is safe.

## 5.1 Assets and trust boundaries

| Asset | Held by | Main threat |
| --- | --- | --- |
| Creators' claimable fees and credits held under the splitter's key | `PonsV2FeeEscrow`; after `pullRevenue` the treasury and reserve liabilities are held by `ForgeProtocolRevenueSplitter` (the treasury recipient claims from the splitter) | owner redirection (F-03); rescue paths (F-04); reentrancy; wrong accounting |
| Treasury and reserve liabilities, non-revenue | `ForgeProtocolRevenueSplitter` | over-allocation from non-eligible credits; attestor compromise; owner misuse |
| Holders' graduation reserves | factory (Swept phase) until seeding or rescue | `rescueSweptGraduation` (7 d), unseedable-state handling |
| Locked LP position, locked buyback tokens | `PonsV2LaunchLocker`, `PonsV2BuybackVault` | recipient redirection (F-03) for vest; no path to the LP NFT |
| Launch eligibility | `ForgeLaunchAuthorizer` + `ForgeBindingRegistry` + two off-chain keys | unauthorized launches; stale/replayed authorizations; key compromise |

Trust boundaries: (1) EVM contracts; (2) the eligibility authority and revenue attestor off-chain services (`apps/forge-web`, sandbox, production signing disabled); (3) GitHub (App webhooks, admin checks); (4) Uniswap v4 PoolManager/PositionManager/Permit2 and Robinhood Chain (an Arbitrum Orbit chain) as external dependencies; (5) the owner/governance.

## 5.2 EIP-712 signing and replay controls (SOURCE)

### Domains and typed data

| Contract | `EIP712(name, version)` | Domain fields | Typed structs |
| --- | --- | --- | --- |
| `ForgeLaunchAuthorizer` | `"FINCO Forge Launch"`, `"1"` | `chainId = block.chainid`, `verifyingContract = authorizer` | `LaunchAuthorization(address factory, address creator, uint64 githubRepoId, uint256 launchConfigId, address pairToken, bytes32 tokenMetadataHash, bytes32 economicsDigest, bytes32 salt, uint64 expiresAt, uint64 nonce, uint16 creatorTaxBps, bytes32 exemptionListHash)`; `EligibilityAttestation(uint64 githubRepoId, address creator, uint64 bindingEpoch, uint64 issuedAt, uint64 expiresAt)` |
| `ForgeBindingRegistry` | `"FINCO Forge Binding Registry"`, `"2"` | chain id, registry | `BindingOp(uint64 githubRepoId, address creator, uint64 bindingExpiresAt, uint64 opDeadline, uint64 opNonce, bytes32 parentOpDigest, string repoFullName, bool revoke)` |
| `ForgeProtocolRevenueSplitter` | `"FINCO Forge Revenue Splitter"`, `"1"` | chain id, splitter | `EligibleRevenue(address escrow, address factory, address asset, uint256 cumulativeEligible, uint64 nonce, uint64 deadline, uint64 evidenceBlock, bytes32 evidenceBlockHash)` |

The three domains differ in name and verifying contract, so a signature for one cannot validate against another. OpenZeppelin's `EIP712` (vendored, v5.0.0 header) recomputes the separator when `block.chainid` or `address(this)` differs from the cached values, so a chain fork does not reuse a stale separator. Off-chain mirrors: `apps/forge-web/src/shared/forge-typed-data.ts` (launch, registry) and `src/server/finance/attestor.ts` (splitter); digest parity with the contracts is tested in `test/integration/eip712-parity.test.ts` and `test/unit/typed-data.test.ts` (DOC level here; the Foundry-side digest equivalence is `ForgeLaunchCallTest.test_calldata_path_binds_same_digest_as_struct_path`, RAN). Signatures are recovered with OpenZeppelin `ECDSA.recover`, which rejects high-s values.

### Two independent signatures per launch

1. **Creator consent** (`LaunchAuthorization`): the creator's own wallet signs the exact launch. the signed `tokenMetadataHash` field is `keccak256(abi.encode(rawMetadataHash, effectiveCreatorFeeRecipient, buybackEnabled, creatorTaxBps))`, where `rawMetadataHash = keccak256(abi.encode(name, symbol, logo, description, socials))` and `effectiveCreatorFeeRecipient` is the creator when `creatorFeeRecipient == address(0)`; `economicsDigest` is the factory's live economics digest (config, fee-policy snapshot, phantom quote, graduation threshold); `exemptionListHash` is the sorted-ascending canonical hash of the anti-snipe exemption list (a reordering is accepted by design; any addition, removal, substitution or duplicate changes the hash; zero address refused; max 32).
2. **Eligibility attestation** (`EligibilityAttestation`, packed as `uint64 issuedAt || uint64 expiresAt || 65-byte signature` = exactly 81 bytes, any other length reverts `BadAttestationEncoding`): signed by the eligibility authority, bound to the registry's *current* `bindingEpoch`.

The two recovered signers must differ (`SignaturesNotIndependent`) and the attestation signer must equal `eligibilityAuthority`.

### Replay and freshness controls

| Control | Mechanism | Where | Tests (all RAN unless noted) |
| --- | --- | --- | --- |
| Per-creator consent nonce | strictly sequential: `intent.nonce == nextCreatorNonce[creator]`, then incremented; replay reverts `CreatorNonceStale` | authorizer | `ForgeLaunchAuthTest.test_b4_replayed_consent_reverts`; `ForgeLifecycleTest.test_nonce_reuse_second_launch_reverts` |
| Consent expiry | `intent.expiresAt >= block.timestamp` else `AuthorizationExpired` | authorizer | `test_b6_expired_consent_reverts` |
| Attestation validity | `issuedAt <= now` (`AttestationNotYetValid`), `issuedAt <= expiresAt` (`AttestationTimesInverted`), `expiresAt >= now` (`AttestationExpired`), `issuedAt + 3 days >= now` (`AttestationTooOld`), each checked independently | authorizer | `test_r10_future_dated_attestation_reverts`, `test_r10b_inverted_attestation_times_revert`, `test_b15_stale_attestation_reverts` |
| Chain / contract binding | domain `chainId` + verifying contract; `intent.factory` must equal the one-time wired `forgeFactory` and `msg.sender`; wrong caller -> `WrongFactory` | authorizer | `test_b2_wrong_caller_reverts`, `test_b3_wrong_factory_in_intent_reverts`, `test_b5_wrong_chain_reverts` |
| Binding epoch | `bindingEpoch` increments on **every** applied bind; attestation digest embeds the epoch read at launch time, so an attestation from an earlier generation never verifies, even for the same creator re-bound after revocation | registry + authorizer | `test_cb5_fresh_rebind_after_revoke_and_barrier_accepted`, `test_cb6_old_epoch_attestation_rejected_after_rebind` |
| Binding freshness | `registry.isActive(repoId, creator)`: bound, not revoked, creator matches, `expiresAt >= now` | registry | `test_b7_revoked_binding_reverts`, `test_b8_expired_binding_reverts`, `test_b10_unauthorized_wallet_reverts` |
| Hash-chained op log | `opNonce == opSequence + 1` **and** `parentOpDigest == headOpDigest`; an op signed against an earlier head is dead whatever its nonce; `usedOps[digest]` blocks replay | registry | `test_r1`..`r5`, `test_cb1_future_nonce_op_after_revoke_reverts`, `test_cb2`..`cb4`, `test_cb7_operation_log_is_auditable`, `testFuzz_cb8_no_preissued_op_survives_revoke` (256 fuzz runs) |
| Op deadline | `opDeadline >= now` and `<= now + 10 min`; `bindingExpiresAt <= now + 30 days` | registry | `test_operation_deadline_enforced` |
| Revocation finality | `invalidatePendingOps(repoId)` (authority or owner): revokes the active binding, bumps the sequence, sets the head to `keccak256(abi.encode(BARRIER_TAG, chainid, repoId, seq, parent, blockhash(block.number - 1)))` which no pre-signed op can name | registry | `test_cb4_barrier_invalidates_all_outstanding_ops` |
| Splitter nonce | `auth.nonce == authNonce + 1` per asset (strictly sequential, W05) | splitter | `W05AttestorCompromiseTest.test_nonce_space_cannot_be_exhausted`; `ForgeRevenueSplitterTest.test_I_expired_replayed_decreasing_refused` |
| Splitter deadline | `auth.deadline >= now` (no upper bound is enforced on chain; the off-chain service uses `AUTHORIZATION_TTL_SECONDS = 600`) | splitter | `test_I_...` |
| Splitter evidence block | block hash must equal the chain's hash for a block strictly in the past and at most 256 blocks old (ArbSys-aware, section 5.4) | splitter | `test_H_reorged_or_stale_evidence_refused`, `test_H2_arbsys_chain_accepts_l2_numbered_evidence`, `test_H2_arbsys_chain_refuses_l1_numbered_evidence_and_bad_windows` |
| Monotone ceiling | `cumulativeEligible >= eligibleCeiling` (`CeilingDecrease`) and `<= escrowClaimed + held` (`CeilingExceedsEscrow`) | splitter | `W05AttestorCompromiseTest.test_unbounded_ceiling_is_refused`, `test_overstatement_blast_radius_is_current_third_party_credit_only` |

Caveats an auditor should weigh (SOURCE): the consent nonce is consumed *before* the attestation checks, which is safe only because a later revert rolls the whole launch transaction back; the attestation has no nonce of its own and can back any number of launches by the same creator for the same `(repoId, epoch)` within its freshness window (each launch still needs its own fresh consent nonce); the splitter deadline has no on-chain upper bound.

## 5.3 Launch-authorization bypass vectors (W02), updated

The W02 table (16 vectors plus Corrections A/B) holds against the current source. Condensed, with tests that exist at this SHA:

| Vector | Closure | Evidence |
| --- | --- | --- |
| Direct factory call without signatures | check inside private `_launchToken`, before any state change | `ForgeLifecycleTest.test_unauthorized_launch_reverts_at_factory`, `ForgeLaunchAuthTest.test_b1_direct_call_without_signatures_reverts` |
| Alternative entry points / forwarder | all three public entry points funnel through `_launchToken`; the authorizer decodes the factory's own `msg.data` by selector, so there is no second encoding to desync; unknown selector -> `UnknownLaunchEntry`; for `launchTokenFor` the decoded `originalDeployer` must equal the creator | `ForgeLaunchCallTest` (10 own tests; the suite runs 14 including 4 inherited `ForgeLifecycleTest` tests) |
| Owner reopens whitelist / `setLaunchEnabled(true)` | gates `canLaunch` only; does not satisfy the authorizer | `ForgeLifecycle`, `ForgeLaunchAuth` suites |
| Creator tax, buyback flag, fee recipient or exemption list changed after signing | all hashed into the consent digest | `test_r6_changed_creator_tax_reverts`, `test_r7_changed_exemption_list_reverts`, `test_r7b_reordered_exemption_list_accepted`, `test_three_entry_points_reject_unsigned_metadata_change` |
| One key plays both roles | `SignaturesNotIndependent` | `test_b11_same_key_both_layers_reverts` |
| Revoked repo / transferred repo | `isActive` false; stale ops dead | `test_b7`, `test_r2_old_bind_after_transfer_reverts`, `cb*` |
| Authority revoked | `setEligibilityAuthority(address(0))` on the authorizer makes every launch revert `AuthorityRevoked`; **not permanent**, the owner can set a non-zero key again (the contract natspec says "permanently"; KNOWN-DISCREPANCIES D12) | `test_b9_revoked_authority_bricks_launches` |
| Deployer bypass | `deployLaunch` is `onlyFactory`; CREATE2 salt namespaced by original deployer | `test_direct_deployer_bypass_blocked` |
| EIP-170 | factory runtime 24,470 B (limit 24,576 B, margin 106 B) | `ForgeLaunchCallTest.test_factory_runtime_within_eip170` (RAN); `ROBINHOOD-CHAIN-RISKS.md` 7.4 |

Residual launch-side trust (W02 risk register, still true): authorizer and registry are rotated by two separate transactions (W02-R1: a partial rotation leaves one on the old key; monitor both); a bound-but-unattested repo needs the backend within 3 days (W02-R2); registry bindings expire and need re-binding (W02-R3); a leaked-but-valid pending op can front-run one authority revoke op, but `invalidatePendingOps` does not depend on the head and defeats it (W02-R5). Plus the rotation observation in `PRIVILEGED-AUTHORITIES.md` 4.5.

## 5.4 Revenue-provenance trust assumption: attested, not proven

The canonical escrow's `credit` / `creditToken` are permissionless and record `depositor` only in an event, not in storage. A balance-based pull would therefore let a third party inflate "protocol revenue" by crediting the splitter's escrow key (reproduced pre-correction at commit `f3b8b13`: a 0.1 ETH base fee plus a 1 ETH third-party credit produced a 1.03 ETH allocation, per `docs/W04-ECONOMICS-ARCHITECTURE.md` section 2a; the regression test `test_reproduction_third_party_credit_is_not_allocated` now asserts the corrected outcome).

**Control.** `pullRevenue` can claim from the escrow only while `escrowClaimed + amount <= eligibleCeiling`; the ceiling is raised only by an EIP-712 `EligibleRevenue` signature from `revenueAttestor`.

**What the attestor attests (off chain, `apps/forge-web/src/server/finance/attestor.ts`):** the cumulative sum of escrow credits to the splitter key whose depositor is a Forge curve, or the Forge hook in the same transaction as its `PoolFeesSwept`, for launches whose frozen snapshot names the splitter at a 30% protocol share, in blocks up to the indexer checkpoint, recomputed deterministically from indexed events.

**Why this is a trust assumption.** Eligibility is not provable on chain: the escrow keeps no depositor in storage and cannot be changed (it is canonical and parity-proven, `PonsV2FeeEscrow` `RUNTIME-PARITY-PROVEN`). So the attestor is trusted to report the right number. This is the open item `ESCROW-CREDIT` / `ATTESTOR`.

**Bounds that do hold on chain (tests RAN):**
- cannot raise the ceiling above `escrowClaimed + currently held for the splitter key` (`CeilingExceedsEscrow`), so it cannot pre-authorize *future* third-party credits (finding W05-01, fixed);
- sequential nonces: a compromised attestor cannot exhaust the nonce space;
- cannot mint, cannot reach creator funds (the escrow pays `msg.sender` only), cannot withdraw (no entry point), cannot govern;
- worst case: pull third-party credits that are *already sitting* under the splitter's key at signing time and allocate them 2:1 as revenue (`test_overstatement_blast_radius_is_current_third_party_credit_only`); under-statement only delays (`test_understatement_only_delays`);
- the attestor must differ from the owner, the treasury recipient and the splitter, at construction, at rotation and at treasury-recipient changes (`RolesNotSeparated`).

**Containment.** `revokeRevenueAttestor()` (atomic, see `PRIVILEGED-AUTHORITIES.md` 4.5), 3-day timelocked rotation, off-chain refusals (the service refuses to sign above recomputed evidence or above `escrowClaimed + balance`; halts on `LEDGER_HALTED`; refuses on a mismatched on-chain attestor/escrow/factory; production signing disabled; local-test signer refuses chains other than 31337/1337). Alert `ATTESTOR_DISCREPANCY` (critical).

**Not resolved:** independent review of the attestation rule (`finance/attestor.ts`, `ledger-fold.ts`), KMS/HSM custody, and the choice between keeping the attestor or adopting a reviewed escrow change that records provenance on chain (`docs/W04-W05-HANDOVER.md`).

### Evidence-block semantics on an Arbitrum Orbit chain

See `ROBINHOOD-CHAIN-RISKS.md` 7.1. The splitter reads the head and hash through ArbSys when it answers, with the 256-block window, because on chain 4663 the EVM `block.number` is the parent-chain number (finding W05-05).

## 5.5 Operator, signer and governance threats (W05)

| Threat | Disposition | Evidence |
| --- | --- | --- |
| Compromised eligibility authority key | immediate off-chain: lockdown + signer allowlist/disable; on-chain: `setEligibilityAuthority(0)` on both contracts then rotate; `invalidatePendingOps` per repo. Under a timelocked owner the on-chain steps wait for the delay (W05-03) | runbook D2; `w05-incident-drills.test.ts` (DOC) |
| Revenue attestor compromised | runbook D3; **PR #5 Correction A** closed a bypass in which a pending rotation matured, the attestor was revoked, and anyone executed the rotation (reproduced on the unfixed contract) | `W05EmergencyRevocationTest` A-J (RAN, 11 passed; not selected by any CI job, D9) |
| Stale signer authority off-chain | `SignerRegistry` takes one fresh on-chain snapshot per signing request (eligibility authority, attestor, owners, treasury), fails closed on RPC error, sticky custody-conflict flag | `test/integration/w05-signer-freshness.test.ts` (DOC; W05-07 fixed) |
| Key custody | KMS adapters for AWS/GCP exist; only a fake KMS was used; distinct authority / evidence / attestor / relayer keys enforced at startup; allowlisted typed-data guard, digests recomputed in the guard | `docs/W05-SIGNER-CUSTODY.md`; `signer-guard.test.ts`, `signer-kms.test.ts` (DOC) |
| Governance misuse of standing powers | F-03/F-04/F-05, W05-02/03/04 are `disclosed-owner-trust`; none removed | `PRIVILEGED-AUTHORITIES.md` |
| GitHub App compromise or forged webhooks | webhook signature + replay checks, reconcile worker, rate-limit fail-closed, lockdown (runbook D1, D7, D8) | `test/unit/w05-github-app.test.ts`, `revocation.test.ts` (DOC). **External configuration still required** (`B01_GITHUB_APP`) |
| Uniswap v4 / Permit2 / chain assumptions | graduation uses genuine v4 contracts in tests; production addresses and runtime identity are read-only evidence | `ROBINHOOD-CHAIN-RISKS.md` |

## 5.6 Revenue-side threats (W04) kept, with current test names

| Threat | Closure | Evidence |
| --- | --- | --- |
| Splitter confiscates creator funds | impossible by construction: escrow pays `msg.sender`; splitter only claims its own key | `test_M_creator_share_and_tax_untouched` |
| Owner drains treasury/reserve | no such function; `releaseNonRevenue` only to the treasury recipient from the non-revenue bucket; reserve has no exit | `test_reserve_has_no_exit`, `invariant_burn_disabled` |
| Treasury recipient hijack | 3-day timelock + window, `cancel` by owner | `test_treasury_recipient_rotation_timelocked`, `test_recipient_proposal_expires_and_cancels` |
| Policy re-peg of live launches | per-launch snapshots are immutable in curve and hook; economics digest binds creator consent | `ForgeRevenueLifecycleTest.test_policy_snapshot_frozen_across_launches` |
| Unsupported / fee-on-transfer quote asset | source-derived approval; receipts measured by balance delta; deficit surfaced | `test_P3_*`, `test_fee_on_transfer_measured_on_receipt` |
| Reentrancy in pull/claim | `nonReentrant`; state before transfer; native escrow payment accepted only while `_pullingNative` is set and sender is the escrow | `test_L_failed_escrow_claim_no_mutation` |
| Indexer double counting / reorg | pure projection keyed by `(blockHash, logIndex)` | `finance-ledger.test.ts`, `ledger-fold.test.ts` (DOC) |
| Forged claim submissions | claim hash accepted only after decoded contents and the canonical claim event are verified | `economics.test.ts` P2 cases (DOC) |

## 5.7 Open threat-model gaps (stated, not hidden)

1. No external review of any of the above (`C01`, `C02`).
2. `Multicall`-style or other vendored-library behaviors were not individually threat-modeled.
3. The fee-sweep operator's price floors (F-05) rely on off-chain independent pricing that is not part of the Solidity (DOC).
4. Genuine Uniswap v4 graduation and the revenue/claims path have **not** been exercised against a fork of the live chain (`A07e` NOT VERIFIED, `B09` NOT PERFORMED).
5. The 302 scanner findings are agent-proposed, not independently triaged (`SECURITY-SCANNER-RESULTS.md`).
