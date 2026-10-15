# W05 — Contract Authority Matrix

_Generated from `apps/forge-web/config/authority-matrix.json` by `scripts/w05/authority-matrix-md.ts`; do not edit by hand. The JSON is drift-tested against the compiled ABIs (every state-changing function must be classified) and every privileged row is proven refused for a stranger on a deployed stack (`test/unit/w05-authority-matrix.test.ts`, `test/integration/w05-authority-enforcement.test.ts`)._

## Scope and identity

- **Contract / source identity:** the Forge-owned stack compiled by `forge build --profile forge` (solc 0.8.35, optimizer 200, via_ir, cancun). Source parity with the deploy-time PONS tree is proven by `provenance/verify-parity.sh`; addresses exist only in sandboxes. No Forge contract is deployed on Robinhood Chain 4663.
- **Owner / pending owner:** every `Ownable2Step` contract is owned by one account chosen at deployment. Sandbox: a single Anvil key. Production target: a Safe (>=3 owners, strict-majority threshold) behind a self-administered timelock (>=2 days) — **operator evidence required (release item B03)**; nothing has been transferred.
- **Upgradeability:** none. No proxy, no `delegatecall`, no `selfdestruct` in any listed contract; behaviour changes require a new deployment and a new factory/hook wiring.
- **Custody exposure:** `PonsV2FeeEscrow` holds all claimable creator/protocol fees; the splitter holds treasury and reserve liabilities and non-revenue; the factory holds swept graduation reserves until seeding or rescue; the buyback vault holds locked project tokens; the locker holds the permanently locked LP position.
- **Timelocks that exist on chain:** creator-fee-recipient override (3 d notice + 3 d window), treasury recipient and revenue attestor changes (3 d + 3 d), graduation rescue (7 d after sweep), signed registry operations (<=10 min). Every other owner function is **immediate**; under a timelock owner it inherits the owner's delay (finding W05-03).

## PonsV2LaunchFactory

Ownership: Ownable2Step · Upgradeable: no

| Function | Caller | Category | Timelock | Emergency | Monitoring events | Note |
| --- | --- | --- | --- | --- | --- | --- |
| `acceptOwnership()` | pending-owner | governance | Ownable2Step two-step |  | `OwnershipTransferred` |  |
| `transferOwnership(address)` | owner | governance | none (two-step) |  | `OwnershipTransferStarted` | renounceOwnership is disabled |
| `addLaunchConfig((uint256,uint256,uint256,uint256,uint24,int24,bool))` | owner | launch-policy | none |  | `LaunchConfigAdded` | future launches only |
| `updateLaunchConfig(uint256,(uint256,uint256,uint256,uint256,uint24,…` | owner | launch-policy | none |  | `LaunchConfigUpdated` | future launches only; launches snapshot config |
| `setLaunchFee(uint256)` | owner | fee-policy | none |  | `LaunchFeeUpdated` | paid to the hook's LIVE protocolFeeRecipient; non-revenue |
| `setLaunchEnabled(bool)` | owner | emergency | none | **yes** | `LaunchEnabledUpdated` | global launch stop |
| `setWhitelistedLauncher(address,bool)` | owner | launch-policy | none |  | `WhitelistedLauncherUpdated` |  |
| `setPairTokenEconomics(address,uint256,uint256,uint8)` | owner | quote-asset-policy | none |  | `PairTokenEconomicsUpdated` |  |
| `setPairTokenApproved(address,bool)` | owner | quote-asset-policy | none |  | `PairTokenApprovalUpdated` | new launches only |
| `setMaxCreatorTaxBps(uint256)` | owner | fee-policy | none |  | `MaxCreatorTaxUpdated` | cap for future launches |
| `setSnipeTaxStartBps(uint256)` | owner | fee-policy | none |  | `SnipeTaxStartBpsUpdated` | snapshotted at curve init |
| `setSnipeTaxSeconds(uint256)` | owner | fee-policy | none |  | `SnipeTaxSecondsUpdated` | snapshotted at curve init |
| `setGraduationExecutor(address)` | owner | wiring-once | one-time (AlreadySet) |  | `GraduationExecutorSet` |  |
| `setLaunchDeployer(address)` | owner | wiring-once | one-time (AlreadySet) |  | `LaunchDeployerSet` |  |
| `setLaunchForwarder(address)` | owner | wiring | none |  | `LaunchForwarderSet` | forwarder may call launchTokenFor |
| `launchToken((string,string,string,string,(string,string,string,stri…` | authorized-creator | launch | n/a |  | `TokenLaunched` | M-ELIG: creator consent + eligibility attestation checked by ForgeLaunchAuthorizer |
| `launchToken((string,string,string,string,(string,string,string,stri…` | authorized-creator | launch | n/a |  | `TokenLaunched` | M-ELIG |
| `launchTokenFor((string,string,string,string,(string,string,string,s…` | launch-forwarder | launch | n/a |  | `TokenLaunched` | forwarder set by owner; still M-ELIG checked |
| `transferCreatorFeeRecipient(address,address)` | creator-fee-recipient | recipient-change | none (self-service) |  | `CreatorFeeRecipientUpdated` | current recipient only |
| `setBuybackEnabled(address,bool)` | creator-or-owner-disable | fee-policy | none |  | `BuybackEnabledUpdated` | owner may only DISABLE |
| `setCreatorFeeRecipient(address,address)` | owner | recipient-change | 3 days notice + 3 days window |  | `CreatorFeeRecipientChangeProposed` | F-03 standing owner power over creator fee routing |
| `executeCreatorFeeRecipientChange(address)` | anyone-after-timelock | recipient-change | enforced (3d + 3d) |  | `CreatorFeeRecipientUpdated` | F-03 execution; permissionless once matured |
| `cancelCreatorFeeRecipientChange(address)` | owner | recipient-change | none |  | `CreatorFeeRecipientChangeCancelled` | creator cannot cancel |
| `graduate(address)` | anyone | graduation | n/a |  | `LaunchSwept` | when the curve is ready |
| `forceSweptGraduation(address)` | owner | rescue | none | **yes** | `LaunchForceSwept` | F-04 class: halts a curve into Swept |
| `createGraduatedPool(address)` | anyone | graduation | n/a |  | `PoolGraduated` | permissionless; closes the rescue window |
| `rescueCurveFees(address)` | owner | rescue | none | **yes** |  | F-04: pays split directly, escrow bypassed; protocol leg non-revenue. Monitored via the CURVE event FeesRescued |
| `rescueSweptGraduation(address,address)` | owner | rescue | 7 days after sweep (GRADUATION_RESCUE_DELAY) | **yes** | `LaunchGraduationRescued` | F-04: owner-chosen recipient for holders' reserves; HIGH owner trust |

## ForgeLaunchAuthorizer

Ownership: Ownable2Step · Upgradeable: no

| Function | Caller | Category | Timelock | Emergency | Monitoring events | Note |
| --- | --- | --- | --- | --- | --- | --- |
| `acceptOwnership()` | pending-owner | governance | Ownable2Step two-step |  | `OwnershipTransferred` |  |
| `transferOwnership(address)` | owner | governance | none (two-step) |  | `OwnershipTransferStarted` |  |
| `renounceOwnership()` | owner | governance | none |  | `OwnershipTransferred` | W05 finding: renounce is NOT disabled here; renouncing freezes the eligibility authority forever |
| `setForgeFactory(address)` | owner | wiring-once | one-time (FactoryAlreadySet) |  | `FactorySet` |  |
| `setEligibilityAuthority(address)` | owner | signer-rotation | none | **yes** | `EligibilityAuthorityUpdated` | address(0) = launch kill switch |
| `requireAuthorizedLaunch((address,address,uint64,uint256,address,byt…` | forge-factory | launch | n/a |  | `LaunchAuthorized` | factory-only |
| `requireAuthorizedLaunchCall(bytes,address,bytes32)` | forge-factory | launch | n/a |  | `LaunchAuthorized` | factory-only |

## ForgeBindingRegistry

Ownership: Ownable2Step · Upgradeable: no

| Function | Caller | Category | Timelock | Emergency | Monitoring events | Note |
| --- | --- | --- | --- | --- | --- | --- |
| `acceptOwnership()` | pending-owner | governance | Ownable2Step two-step |  | `OwnershipTransferred` |  |
| `transferOwnership(address)` | owner | governance | none (two-step) |  | `OwnershipTransferStarted` |  |
| `renounceOwnership()` | owner | governance | none |  | `OwnershipTransferred` | W05 finding: renounce is NOT disabled; renouncing freezes authority rotation |
| `applyBindingOp((uint64,address,uint64,uint64,uint64,bytes32,string,…` | authority-signature | eligibility | signed op deadline <= 10 min |  | `OperationApplied`, `Bound`, `Revoked` | relayed by anyone; authority EIP-712 signature |
| `invalidatePendingOps(uint64)` | authority-or-owner | emergency | none | **yes** | `PendingOpsInvalidated` | barrier against parked signatures |
| `setEligibilityAuthority(address)` | owner | signer-rotation | none | **yes** | `AuthorityUpdated` | signer compromise response |

## PonsV2MemeHook

Ownership: Ownable2Step · Upgradeable: no

| Function | Caller | Category | Timelock | Emergency | Monitoring events | Note |
| --- | --- | --- | --- | --- | --- | --- |
| `acceptOwnership()` | pending-owner | governance | Ownable2Step two-step |  | `OwnershipTransferred` |  |
| `transferOwnership(address)` | owner | governance | none (two-step) |  | `OwnershipTransferStarted` | renounceOwnership is disabled |
| `setFactory(address)` | owner | wiring-once | one-time (AlreadySet) |  | `FactorySet` |  |
| `setBuybackVault(address)` | owner | wiring-once | one-time (AlreadySet) |  | `BuybackVaultSet` |  |
| `setProtocolFeeShareBps(uint256)` | owner | fee-policy | none |  | `ProtocolFeeShareUpdated` | future launches only (snapshot) |
| `setBuybackBurnBps(uint256)` | owner | fee-policy | none |  | `BuybackBurnBpsUpdated` | future launches only |
| `setHookFeeBps(uint256)` | owner | fee-policy | none |  | `HookFeeBpsUpdated` | future launches only |
| `setMaxInternalPriceImpactBps(uint256)` | owner | fee-policy | none |  | `MaxInternalPriceImpactUpdated` |  |
| `setProtocolFeeRecipient(address)` | owner | recipient-change | none |  | `ProtocolFeeRecipientUpdated` | future launches' protocol leg + LIVE launch-fee recipient; must stay the splitter |
| `setFeeSweepOperator(address)` | owner | operator | none |  | `FeeSweepOperatorUpdated` | F-05: operator chooses swap floors |
| `registerPool((address,address,uint24,int24,address),address,address…` | forge-factory | graduation | n/a |  | `PoolRegistered` | factory-only |
| `setCreatorFeeRecipient(bytes32,address)` | forge-factory | recipient-change | inherits factory |  | `CreatorFeeRecipientUpdated` | factory-only |
| `setBuybackEnabled(bytes32,bool)` | forge-factory | fee-policy | inherits factory |  | `BuybackEnabledUpdated` | factory-only |
| `sweepPoolFees(bytes32,uint256,uint256)` | operator-or-creator | fees | n/a |  | `PoolFeesSwept` | creator only when no internal swap is needed |
| `rescuePoolFees(bytes32)` | owner | rescue | none | **yes** | `PoolFeesRescued` | F-04: direct split, escrow bypassed; never touches a native quote bucket |
| `unlockCallback(bytes)` | pool-manager | callback | n/a |  |  | PoolManager only |
| `beforeInitialize(address,(address,address,uint24,int24,address),uin…` | pool-manager | callback | n/a |  |  | V4 hook entry; PoolManager only |
| `afterInitialize(address,(address,address,uint24,int24,address),uint…` | pool-manager | callback | n/a |  |  | not enabled (permission bit off) |
| `beforeAddLiquidity(address,(address,address,uint24,int24,address),(…` | pool-manager | callback | n/a |  |  | not enabled |
| `afterAddLiquidity(address,(address,address,uint24,int24,address),(i…` | pool-manager | callback | n/a |  |  | not enabled |
| `beforeRemoveLiquidity(address,(address,address,uint24,int24,address…` | pool-manager | callback | n/a |  |  | not enabled |
| `afterRemoveLiquidity(address,(address,address,uint24,int24,address)…` | pool-manager | callback | n/a |  |  | not enabled |
| `beforeSwap(address,(address,address,uint24,int24,address),(bool,int…` | pool-manager | callback | n/a |  |  | not enabled |
| `afterSwap(address,(address,address,uint24,int24,address),(bool,int2…` | pool-manager | callback | n/a |  | `HookFeeCollected` | V4 hook entry; PoolManager only |
| `beforeDonate(address,(address,address,uint24,int24,address),uint256…` | pool-manager | callback | n/a |  |  | not enabled |
| `afterDonate(address,(address,address,uint24,int24,address),uint256,…` | pool-manager | callback | n/a |  |  | not enabled |

## PonsV2FeeEscrow

Ownership: none (immutable wiring) · Upgradeable: no

| Function | Caller | Category | Timelock | Emergency | Monitoring events | Note |
| --- | --- | --- | --- | --- | --- | --- |
| `credit(address)` | anyone | escrow | n/a |  | `Credited` | permissionless by design; third-party credits are UNATTRIBUTED |
| `creditToken(address,address,uint256)` | anyone | escrow | n/a |  | `CreditedToken` | permissionless by design |
| `claim()` | self | escrow | n/a |  | `Claimed` | pays msg.sender only |
| `claim(uint256)` | self | escrow | n/a |  | `Claimed` | pays msg.sender only |
| `claimToken(address)` | self | escrow | n/a |  | `ClaimedToken` | pays msg.sender only |
| `claimToken(address,uint256)` | self | escrow | n/a |  | `ClaimedToken` | pays msg.sender only |

## ForgeProtocolRevenueSplitter

Ownership: Ownable2Step · Upgradeable: no

| Function | Caller | Category | Timelock | Emergency | Monitoring events | Note |
| --- | --- | --- | --- | --- | --- | --- |
| `acceptOwnership()` | pending-owner | governance | Ownable2Step two-step |  | `OwnershipTransferred` |  |
| `transferOwnership(address)` | owner | governance | none (two-step) |  | `OwnershipTransferStarted` | renounceOwnership is disabled |
| `authorizeEligibleRevenue((address,address,address,uint256,uint64,ui…` | attestor-signature | revenue | deadline + blockhash evidence |  | `EligibleRevenueAuthorized` | TRUSTED attestor; W05: sequential nonce, ceiling <= escrow claimed + held |
| `pullRevenue(address,uint256)` | anyone | revenue | n/a |  | `RevenueAllocated` | bounded by attested ceiling |
| `recordUnattributed(address)` | anyone | revenue | n/a |  | `NonRevenueReceived` | records surplus as non-revenue |
| `claimTreasury(address,uint256)` | treasury-recipient | treasury | n/a |  | `TreasuryClaimed` | never the reserve |
| `releaseNonRevenue(address,uint256)` | owner | treasury | none |  | `NonRevenueReleased` | only to the treasury recipient |
| `setForgeFactory(address)` | owner | wiring-once | one-time (FactoryAlreadySet) |  | `ForgeFactorySet` |  |
| `setAssetApproved(address,bool)` | owner | quote-asset-policy | none |  | `AssetApprovalUpdated` | approval source-derived from the factory |
| `setPullsPaused(bool)` | owner | emergency | none | **yes** | `PullsPausedUpdated` | stops pulls, never claims |
| `proposeTreasuryRecipient(address)` | owner | recipient-change | 3 days notice + 3 days window |  | `TreasuryRecipientChangeProposed` |  |
| `executeTreasuryRecipientChange()` | anyone-after-timelock | recipient-change | enforced (3d + 3d) |  | `TreasuryRecipientUpdated` |  |
| `cancelTreasuryRecipientChange()` | owner | recipient-change | none |  | `TreasuryRecipientChangeCancelled` |  |
| `proposeRevenueAttestor(address)` | owner | signer-rotation | 3 days notice + 3 days window |  | `RevenueAttestorChangeProposed` |  |
| `executeRevenueAttestorChange()` | anyone-after-timelock | signer-rotation | enforced (3d + 3d) |  | `RevenueAttestorUpdated` |  |
| `cancelRevenueAttestorChange()` | owner | signer-rotation | none |  | `RevenueAttestorChangeCancelled` |  |
| `revokeRevenueAttestor()` | owner | emergency | none (immediate) | **yes** | `RevenueAttestorUpdated`, `EmergencyRevocation` | atomic: clears the attestor, discards any pending rotation AND pauses pulls (claims unaffected) |

## PonsV2BuybackVault

Ownership: Ownable2Step · Upgradeable: no

| Function | Caller | Category | Timelock | Emergency | Monitoring events | Note |
| --- | --- | --- | --- | --- | --- | --- |
| `acceptOwnership()` | pending-owner | governance | Ownable2Step two-step |  | `OwnershipTransferred` |  |
| `transferOwnership(address)` | owner | governance | none (two-step) |  | `OwnershipTransferStarted` | renounceOwnership is disabled |
| `setFactory(address)` | owner | wiring-once | one-time (AlreadyInitialized) |  | `FactorySet` |  |
| `lock(address,uint256,address,address,uint16)` | authorized-locker | vesting | n/a |  | `Locked` | curve or hook of a Forge launch |
| `release(address)` | vest-beneficiary | vesting | linear 5-year vest |  | `Released` | creator or protocol recipient |
| `updateCreatorRecipient(address,address)` | forge-factory | recipient-change | inherits factory (F-03) |  | `CreatorRecipientUpdated` | factory-only |

## PonsV2LaunchLocker

Ownership: Ownable2Step · Upgradeable: no

| Function | Caller | Category | Timelock | Emergency | Monitoring events | Note |
| --- | --- | --- | --- | --- | --- | --- |
| `acceptOwnership()` | pending-owner | governance | Ownable2Step two-step |  | `OwnershipTransferred` |  |
| `transferOwnership(address)` | owner | governance | none (two-step) |  | `OwnershipTransferStarted` | renounceOwnership is disabled |
| `setFactory(address)` | owner | wiring-once | one-time (AlreadyInitialized) |  | `FactorySet` |  |
| `lockPosition(address,uint256)` | forge-factory | graduation | permanent lock |  | `PositionLocked` | no unlock function exists |
| `lockTokenSupply(address,uint256)` | forge-factory | graduation | permanent lock |  | `TokenSupplyLocked` |  |

## PonsV2GraduationExecutor

Ownership: none (immutable wiring) · Upgradeable: no

| Function | Caller | Category | Timelock | Emergency | Monitoring events | Note |
| --- | --- | --- | --- | --- | --- | --- |
| `mintFullRangePosition(address,(address,address,uint24,int24,address…` | forge-factory | graduation | n/a |  |  | factory-only |

## PonsV2LaunchDeployer

Ownership: none (immutable wiring) · Upgradeable: no

| Function | Caller | Category | Timelock | Emergency | Monitoring events | Note |
| --- | --- | --- | --- | --- | --- | --- |
| `deployLaunch((address,address,address,address,(address,uint16,uint1…` | forge-factory | launch | n/a |  |  | factory-only |

