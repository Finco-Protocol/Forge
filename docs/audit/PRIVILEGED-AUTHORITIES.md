# 4. Privileged authorities

Primary sources: `apps/forge-web/config/authority-matrix.json` (103 state-changing functions over 10 contracts, rendered to `docs/W05-AUTHORITY-MATRIX.md`; drift-tested against the compiled ABI by `apps/forge-web/test/unit/w05-authority-matrix.test.ts`), re-checked against the Solidity at `f4fa5e8a`. This file is a digest for an auditor. The matrix is the complete per-function list; use it for anything not named here.

Nothing here has been accepted by an external reviewer. The release register marks the standing owner powers `disclosed-owner-trust`, which means documented, monitored and routed to Class C review item `C03_FEE_POLICY_POWERS_REVIEW` (`release/security-findings.json`, `release/readiness-items.json`). `release/approver-registry.json` has no approver keys, so the gate cannot pass any Class B/C item (`docs/W05-RELEASE-READINESS.md`).

## 4.1 Roles

| Role | Holder today | Production target (not met; Class B `B03_GOVERNANCE_SAFE_TIMELOCK` unevidenced) |
| --- | --- | --- |
| Owner of factory, hook, vault, locker, splitter, authorizer, registry | one sandbox key (Anvil) | Safe (>=3 owners, strict-majority threshold) behind a self-administered timelock (>=2 days). Policy floor simulated in `scripts/w05/governance.ts` with Safe 1.5.0 + OZ `TimelockController`. Nothing was transferred anywhere |
| Eligibility authority key | one sandbox key; used by **two** contracts (registry and authorizer each hold their own copy) | non-exportable KMS/HSM key (`B02_SIGNER_CUSTODY`); adapters exist and were tested only against a fake KMS (`docs/W05-SIGNER-CUSTODY.md`) |
| Revenue attestor | `ForgeProtocolRevenueSplitter.revenueAttestor`; sandbox key | separate KMS/HSM key; `REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED=false` |
| Treasury recipient | `treasuryRecipient`; sandbox key | custody not designed (`CUSTODY`) |
| Fee-sweep operator | `PonsV2MemeHook.feeSweepOperator`, defaults to the hook's initial owner | key as protected as the owner (F-05) |
| Launch forwarder | `PonsV2LaunchFactory.launchForwarder`, unset by default; owner may set any non-zero address | none configured. Not in the deploy plan |
| Creator fee recipient | per launch, default the creator | n/a |
| `Ownable2Step` pending owner | none | n/a |

Every owned contract uses `Ownable2Step`. `renounceOwnership` reverts on factory, hook, vault, locker and splitter (SOURCE), and is **not** disabled on `ForgeLaunchAuthorizer` and `ForgeBindingRegistry` (finding W05-02): renouncing either freezes authority rotation and, for the authorizer, the launch kill switch.

## 4.2 Timelocks that exist on chain (SOURCE)

| Action | Delay | Where |
| --- | --- | --- |
| Creator-fee-recipient override | 3 days notice (`CREATOR_FEE_RECIPIENT_TIMELOCK`) + 3 days execution window (`CREATOR_FEE_RECIPIENT_EXECUTION_WINDOW`) | factory |
| Treasury recipient change; revenue attestor change | 3 days (`RECIPIENT_TIMELOCK`) + 3 days window (`RECIPIENT_EXECUTION_WINDOW`) | splitter |
| Swept-graduation rescue | `GRADUATION_RESCUE_DELAY` = 7 days after `sweptAt` | factory |
| Signed registry operation validity | `MAX_OP_VALIDITY` = 10 minutes | registry |
| Binding evidence horizon | `MAX_BINDING_HORIZON` = 30 days | registry |
| Eligibility attestation freshness | `MAX_ATTESTATION_AGE` = 3 days | authorizer |

**Every other owner function is immediate.** Under a timelocked Safe owner, each inherits the owner's delay, including the emergency stops (finding W05-03): `setLaunchEnabled`, `setEligibilityAuthority(0)`, `setPullsPaused`, `revokeRevenueAttestor`. Immediate containment in the target design is off-chain only (signer kill switches, `emergency_lockdown`) and is not on-chain state.

## 4.3 F-03: owner override of a launch's creator fee recipient

| Item | Source truth |
| --- | --- |
| Propose | `PonsV2LaunchFactory.setCreatorFeeRecipient(address token, address newRecipient)` `onlyOwner`; stores `{newRecipient, effectiveAt = now + 3 days, expiresAt = effectiveAt + 3 days}`; a new proposal for the same token replaces the previous one and resets the clock. Reverts for an unknown token or a zero recipient. Event `CreatorFeeRecipientChangeProposed(token, currentRecipient, newRecipient, effectiveAt, expiresAt)` |
| Execute | `executeCreatorFeeRecipientChange(address token)` is **permissionless** inside `[effectiveAt, expiresAt]` (`TimelockNotElapsed` / `TimelockExpired` otherwise). Forwards to `memeHook.setCreatorFeeRecipient` when the launch phase is `PoolCreated`, otherwise to the curve's `setCreatorFeeRecipient`, and always to `buybackVault.updateCreatorRecipient`. Events: factory `CreatorFeeRecipientUpdated(token, previous, new)` plus the curve/hook `CreatorFeeRecipientUpdated` and vault `CreatorRecipientUpdated` |
| Cancel | `cancelCreatorFeeRecipientChange(address token)` `onlyOwner` only; the creator cannot cancel |
| Creator counter-move | `transferCreatorFeeRecipient(token, newRecipient)` (current recipient, immediate) does **not** cancel a pending override, and a matured override takes precedence over a creator transfer made meanwhile. The collision is observable: the proposal event names the recipient at proposal time, the update event names the recipient actually replaced |
| What it reaches (`test-forge/W05OwnerPowers.t.sol`, 11 tests, RAN: 11 passed) | fees still **accrued** in the curve or hook at execution time follow the new recipient at the next sweep; **unreleased vested** buyback tokens follow it; the creator can settle accrued fees to their own key during the 3-day notice (`curve.sweepFees`) and release vested tokens, which shrinks the reach. It does **not** touch amounts already credited to the escrow under the old recipient's key, other launches, or other recipients' liabilities. A matured proposal nobody executes in time lapses |
| Scope | Any launch, before or after graduation. Not conditioned on lost-key recovery: the natspec says so explicitly (`docs/SECURITY-REVIEW.md` F-03; upstream finding HACK-01 / H-01 of Hackerbane HB-AR-2026.2, remediation PENDING per that document) |
| Detection | Off-chain: alert rule `SUSPICIOUS_RECIPIENT_CHANGE` (critical, triggered by `CreatorFeeRecipientChangeProposed`, `CreatorFeeRecipientUpdated`, `ProtocolFeeRecipientUpdated`, `TreasuryRecipientChange*`, ... in `apps/forge-web/src/server/ops/monitor.ts`); runbook `docs/W05-INCIDENT-RUNBOOK.md` D6; the public governance view (`GET /api/finance/governance`) shows pending changes (DOC: `docs/W04-ECONOMICS-ARCHITECTURE.md` section 4; UI copy not re-verified) |
| Disclosure | `docs/SECURITY-REVIEW.md`, `docs/W05-SECURITY-GOVERNANCE.md` section 3, this dossier. Whether launch-time creator disclosures are legally adequate is open (`C05_LAUNCH_TERMS_REGULATORY`, `LEGAL`) |
| Status | `disclosed-owner-trust`. Removal/narrowing would be a new factory version needing its own review (proposed in W05-SECURITY-GOVERNANCE section 3, not built). Any document that presents creator revenue as owner-independent would be wrong |

## 4.4 F-04: owner rescue and escape hatches

| Function (contract) | Delay | Effect (SOURCE) | Event for monitoring | Reaches creators' funds? |
| --- | --- | --- | --- | --- |
| `rescueCurveFees(address token)` (factory, `onlyOwner nonReentrant`) -> `PonsV2BondingCurve.rescueFees()` (`onlyFactory`) | none | Pays the pending curve fee bucket directly: protocol leg to the frozen `protocolFeeRecipient`, creator leg (+ creator tax) to the curve's `deployer` (creator recipient), **bypassing the escrow**; zeroes the buyback earmark | curve `FeesRescued(protocolRecipient, creatorRecipient, protocolAmount, creatorAmount)`; no factory event | Pays creators their regular share, directly. The protocol leg lands at the splitter as an unattributed direct transfer = non-revenue |
| `rescuePoolFees(bytes32 poolId)` (hook, `onlyOwner nonReentrant`) | none | Same direct split for a graduated pool's pending buckets in the quote token and in the memecoin; a **native** quote bucket is skipped by design (W05-04); reverts `NothingToRescue` if nothing moved | hook `PoolFeesRescued` | As above |
| `forceSweptGraduation(address token)` (factory, `onlyOwner`) | none | Only for a launch whose curve is `readyToGraduate` **and** whose seed `_graduationSeedable` reports unseedable (`GraduationStillViable` otherwise): moves reserves into the factory, phase `Swept` | `LaunchForceSwept` | Moves holders' reserves into the factory; starts the 7-day rescue clock |
| `rescueSweptGraduation(address token, address recipient)` (factory, `onlyOwner nonReentrant`) | 7 days after `sweptAt` | Phase must be `Swept`; sends **all** swept quote and tokens to an owner-chosen `recipient` (non-zero); phase becomes `Rescued`. Seeding stays permissionless during the wait: a call to `createGraduatedPool` before the owner rescues seeds the pool and ends the rescue path for good | `LaunchGraduationRescued` | **Highest trust**: holders' graduation reserves, one recipient, off-chain distribution |
| `releaseNonRevenue(address asset, uint256 amount)` (splitter, `onlyOwner`) | none | Held non-revenue (launch fee, rescues, donations, graduation residual) to the **treasury recipient only** | `NonRevenueReleased` | No |
| `PonsV2LaunchAndBuy.rescue(address asset, address recipient)` (`onlyOwner`) | none | Sends the router's stranded balance anywhere. Not in the authority matrix or the deploy plan (KNOWN-DISCREPANCIES D11) | `Rescued` | Only balances that should be zero between transactions |

Monitoring and disclosure for F-04: alert `OWNER_RESCUE` (high, containment class `observe`: the alert follows the event, it does not prevent it) fires on `FeesRescued`, `PoolFeesRescued`, `LaunchGraduationRescued`, `LaunchForceSwept`; the ledger raises `OWNER_RESCUE_CURVE` / `OWNER_RESCUE_POOL` exceptions and never counts rescued protocol legs as eligible revenue (`test_F04_curve_rescue_is_never_eligible_revenue`, `test_F04_pool_rescue_is_never_eligible_revenue`); runbook D14. The 7-day delay is meaningful only because `createGraduatedPool` is permissionless. The two fee rescues carry no delay.

## 4.5 Other privileged surfaces (digest; see the matrix for the complete list)

**Factory (`onlyOwner`, immediate unless stated).** `addLaunchConfig`, `updateLaunchConfig` (future launches; launches snapshot config); `setLaunchFee` (paid to the hook's **live** protocol recipient, classified non-revenue); `setLaunchEnabled(bool)` (global launch stop); `setWhitelistedLauncher`; `setPairTokenEconomics`, `setPairTokenApproved` (new launches only); `setMaxCreatorTaxBps` (ceiling 10%), `setSnipeTaxStartBps` (<= 99%), `setSnipeTaxSeconds` (<= 60 s), snapshotted at curve creation; `setGraduationExecutor`, `setLaunchDeployer` (one-time, `AlreadySet`); `setLaunchForwarder` (live; a forwarder may call `launchTokenFor` but M-ELIG still binds the **original deployer's** consent and canonical exemption list, and rejects a mismatched deployer: `test_forwarded_deployer_cannot_be_substituted`). `setBuybackEnabled(token, bool)`: creator may enable, owner may only disable.

**Hook (`onlyOwner`).** `setProtocolFeeShareBps` (<= 5,000 bps), `setBuybackBurnBps`, `setHookFeeBps` (<= 1,000 bps), `setMaxInternalPriceImpactBps`: future launches only (per-launch snapshots). `setProtocolFeeRecipient`: future launches' protocol leg **and the live launch-fee recipient**; it must stay the splitter for 70/20/10 eligibility and a change is surfaced as an alert and a governance warning. `setFeeSweepOperator`: chooses conversion/buyback price floors (F-05, sandwich exposure up to `maxInternalPriceImpactBps`, default 3%). `setFactory`, `setBuybackVault`: one-time.

**Eligibility stack.** `ForgeLaunchAuthorizer.setEligibilityAuthority(address)` `onlyOwner`, immediate, **address(0) accepted** (launch kill switch: all launches revert `AuthorityRevoked`). `ForgeBindingRegistry.setEligibilityAuthority(address)` `onlyOwner`, immediate, **zero rejected**. `ForgeBindingRegistry.invalidatePendingOps(uint64 repoId)`: authority **or** owner; revokes the active binding and moves the op-log head to an unpredictable barrier. `applyBindingOp(BindingOp, signature)`: anyone may relay an authority-signed op. `setForgeFactory`: one-time.

*Source-derived observation for the auditor (not a documented finding):* the factory's `launchAuthorizer` is immutable, so a factory-owner action alone cannot bypass M-ELIG. But the **authorizer owner** can call `setEligibilityAuthority(newKey)` with no timelock, and the **registry owner** can do the same on the registry; with both keys under one governance Safe, governance can install an authority key it controls, bind any repo id to any wallet and issue attestations. A launch would still need a creator-consent signature from the named wallet (which governance could also control). The only constraints are the 3-day attestation freshness, monitoring, and the owner's own timelock. `docs/MODIFICATION-REGISTER.md` and `docs/THREAT-MODEL-W02.md` state M-ELIG is "not bypassable by" owner powers; that is accurate for the factory-owner functions and for the authority key's *absence* (kill switch), but not for key *rotation*. Whether the two ownerships should be separated is a design question for the audit.

**Splitter (`onlyOwner`).** `setForgeFactory` (one-time), `setAssetApproved(asset, bool)` (source-derived: wired factory must list the asset in `approvedPairTokens`, with non-zero `phantomQuote` and `graduationThreshold`, matching `decimals()`; Forge launch tokens and EOAs refused), `setPullsPaused(bool)` (never blocks claims), `proposeTreasuryRecipient` / `cancelTreasuryRecipientChange` (+ permissionless `executeTreasuryRecipientChange` after 3 d), `proposeRevenueAttestor` / `cancelRevenueAttestorChange` (+ permissionless `executeRevenueAttestorChange`), `revokeRevenueAttestor()`, `releaseNonRevenue`.

`revokeRevenueAttestor()` is atomic (PR #5 Correction A, finding W05-06): it clears the attestor, discards any pending rotation (event `RevenueAttestorChangeCancelled`), pauses pulls (`PullsPausedUpdated(true)`) and emits `EmergencyRevocation(revokedAttestor, discardedPending)`. Claims (`claimTreasury`, escrow creator claims) are never blocked. Existing ceilings are **not** erased. Recovery needs a new `proposeRevenueAttestor` + the 3-day timelock **and** an explicit owner `setPullsPaused(false)`. Tests: `test-forge/W05EmergencyRevocation.t.sol` (11 tests, RAN: 11 passed). **Note:** no CI workflow selects this suite (KNOWN-DISCREPANCIES D9).

**Vault / locker.** `setFactory` one-time. There is no unlock function for the locked position NFT (`PonsV2LaunchLocker`: only `lockPosition`, `lockTokenSupply`, `isLocked`) and no owner path to release vested tokens other than the beneficiary's `release`.

**Permissionless but economically relevant.** `PonsV2FeeEscrow.credit` / `creditToken` (anyone may credit any recipient key, with no on-chain record of provenance beyond the `depositor` event field), `graduate`, `createGraduatedPool`, `pullRevenue`, `recordUnattributed`, `executeCreatorFeeRecipientChange`, `executeTreasuryRecipientChange`, `executeRevenueAttestorChange`, `authorizeEligibleRevenue` (needs the attestor signature), `applyBindingOp` (needs the authority signature).

## 4.6 What each authority cannot do (source-checked, tested)

- The attestor cannot mint, reach creator funds, withdraw, or exceed `escrowClaimed + escrow balance` held for the splitter key (`CeilingExceedsEscrow`); nonces are strictly sequential, so its nonce space cannot be exhausted (`W05AttestorCompromise.t.sol`, 7 tests, RAN: 7 passed).
- The splitter owner cannot withdraw allocated treasury or reserve liabilities; the reserve has no exit; `FINCO_BURN_ENABLED` is `constant false`.
- No contract has a path to the locked LP position or to mint token supply (`PonsV2LauncherToken` has fixed supply, no privileges, per `docs/SECURITY-REVIEW.md`; not re-derived here).
