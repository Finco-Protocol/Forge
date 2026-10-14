# W04 — Fee Authority & Revenue Classification Matrix

Status: **sandbox only**. Retained flags: `PRODUCTION_BLOCKED=true`, `FINCO_BURN_ENABLED=false`, `FORGE_FEE_POLICY_AUTHORITY_UNPROVEN=true`.

This matrix was traced from the Forge-owned sources (`contractsV2-forge/src/v2`), which are the recovered deploy-time PONS V2 contracts plus the W02/W03 M-ELIG changes. It is not based on documentation claims. The deploy-time tree (`contractsV2-deployed/`) and the original PONS factory on chain 4663 were not modified and are **outside Forge authority**.

## How to read this matrix

Each flow is described by eight attributes, labelled A to H:

| | Attribute |
| --- | --- |
| **A** | The asset that actually moves. |
| **B** | The source contract and the recipient. |
| **C** | Who controls the policy. |
| **D** | When the parameters freeze. |
| **E** | Who can change the beneficiary. |
| **F** | Whether Forge governance holds the authority (Forge stack only). |
| **G** | The events that prove the flow. |
| **H** | Whether the flow is eligible for 70/20/10. |

Abbreviations used in the tables:

- **Snapshot**: the `FeePolicySnapshot` that a launch freezes into its curve at launch (`protocolFeeRecipient`, `protocolFeeShareBps`, `buybackBurnBps`, `hookFeeBps`, `maxInternalPriceImpactBps`) and into its hook pool at graduation.
- **Quote**: the launch's quote asset. This is native ETH, or an owner-approved ERC-20 with stored economics.

## 1. Flow matrix

### Launch-time flows

| # | Flow | A. Asset | B. Source → recipient | C. Policy controller | D. Frozen when | E. Beneficiary changeable by | F. Forge authority | G. Evidence events | H. 70/20/10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Launch fee | Native ETH | Factory `_payLaunchFee` → `memeHook.protocolFeeRecipient()`. This is the **live** recipient, not the snapshot, paid by direct call with no escrow. | Factory owner (`setLaunchFee`) | Never; the current value is charged at each launch | Hook owner (`setProtocolFeeRecipient`) | Yes on the Forge stack (sandbox key); not proven for production | Factory `LaunchFeeUpdated`; splitter `NonRevenueReceived(LaunchFee)` | **No**: a separate class held as non-revenue |
| 2 | Bonding-curve base trading fee (`curveFeeBps`) | Quote | Curve `_sweepFees` → escrow `credit(protocolFeeRecipient)` (protocol leg) and `credit(deployer)` (creator leg) | Factory owner (launch config `curveFeeBps`) | At launch (curve immutable `feeBps`) | Protocol leg: frozen. Creator leg: see #13 | Yes (Forge stack) | `CurveBuy` / `CurveSell` (`fee`), `FeesSwept`, escrow `Credited*` (depositor = curve) | **Yes**, when the snapshot share is 30% and the recipient is the splitter |
| 3 | Snipe tax | Quote | Added to the base-fee bucket (`_accrueFees(fee + snipeTax, …)`) and split exactly like #2 | Factory owner (`setSnipeTaxStartBps` / `setSnipeTaxSeconds`) | At curve initialisation (snapshotted from the factory) | As #2 | Yes | `SnipeTaxCharged`, included in `CurveBuy.fee` | **Yes**. The contract makes it part of the base fee; it is reported separately as a component. |
| 4 | Creator tax (`creatorTaxBps`) | Quote | Curve or hook → escrow creator key, **combined** with the creator base leg in one credit | The creator, capped by the owner's `maxCreatorTaxBps` | At launch (immutable) | As #13 | Ceiling only | `CurveBuy` / `CurveSell` (`tax`), `HookFeeCollected` (`taxAmount`) | **No**: 100% to the creator, excluded |

### Splits of the base fee

| # | Flow | A. Asset | B. Source → recipient | C. Policy controller | D. Frozen when | E. Beneficiary changeable by | F. Forge authority | G. Evidence events | H. 70/20/10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | Protocol fee share (30% default) | Quote | Credited to the snapshot `protocolFeeRecipient` (the splitter in the W04 sandbox) | Hook owner (`setProtocolFeeShareBps`, at most `MAX_PROTOCOL_FEE_SHARE_BPS`) | At launch; again at graduation, when the pool is registered with the **launch** snapshot | Hook owner, for **future** launches only | Yes (Forge stack) | `FeesSwept` / `PoolFeesSwept` (`protocolAmount`), escrow `Credited*` | **Yes**: the splitter allocates 2/3 to treasury and 1/3 to reserve |
| 6 | Creator fee share (70% default) | Quote | Escrow creator key | Implied by #5 | At launch | As #13 | Yes | `FeesSwept` / `PoolFeesSwept` (`creatorAmount`) | **Yes**: this is the "70" |
| 7 | Buyback-and-lock | Quote → memecoin | `buybackBurnBps` (50%) of the **creator** bucket buys the memecoin, which is locked in `PonsV2BuybackVault` for 5 years | Hook owner sets the bps for future launches. The creator enables or disables it per launch; the owner may only disable. | The bps is frozen at launch; the flag is toggleable going forward | Vault creator beneficiary follows #13 | Yes | `BuybackLocked`, `PoolFeesSwept.tokensLocked`, vault `Locked` | **No**. With buyback on, the creator receives 35% cash plus 35% vested tokens, not 70% cash; the dashboard shows the effective split. |

### Accrual and conversion

| # | Flow | A. Asset | B. Source → recipient | C. Policy controller | D. Frozen when | E. Beneficiary changeable by | F. Forge authority | G. Evidence events | H. 70/20/10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 8 | Pre-graduation accrual | Quote | Curve buckets `quoteFeeBalance`, `creatorTaxBalance`, `buybackQuoteBalance` until a sweep | Sweep by the creator (when no buyback) or the sweep operator. Graduation sweeps without buyback. | n/a | n/a | n/a | Live reads only | Reported as **accrued / unswept**, never as realised revenue |
| 9 | Post-graduation hook fee (`hookFeeBps`) | Either pool currency | Hook `_afterSwap` → pending buckets → `sweepPoolFees` → escrow (creator credited first, then protocol) | Hook owner (`setHookFeeBps`, future launches) | At pool registration (launch snapshot) | As #5 and #13 | Yes | `HookFeeCollected`, `PoolFeesSwept`, escrow `Credited*` (depositor = hook) | **Yes**: the quote-denominated portion, and the memecoin portion once converted |
| 10 | Quote conversion (memecoin → quote) | Memecoin → quote | Hook internal swap during `sweepPoolFees` | The fee sweep operator, who sets `minConversionQuoteOut` | n/a | n/a | Operator role (hook owner sets it) | `PoolFeesSwept`, `PoolConversionSkipped` | Base fee yes. A creator credit that includes converted tax is reported as **UNSPLIT**. |

### Escrow, rescues and recipient changes

| # | Flow | A. Asset | B. Source → recipient | C. Policy controller | D. Frozen when | E. Beneficiary changeable by | F. Forge authority | G. Evidence events | H. 70/20/10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 11 | Fee escrow credits and claims | Any | `PonsV2FeeEscrow` aggregates balances per (recipient, asset). `credit` / `creditToken` are **permissionless**. `claim*` pays `msg.sender` only. | None (no owner) | n/a | Only the recipient can claim | n/a | `Credited`, `CreditedToken`, `Claimed`, `ClaimedToken` | n/a. A third-party credit to the splitter key is **UNATTRIBUTED**. |
| 12 | Owner fee rescues (F-04) | Quote or memecoin | Factory `rescueCurveFees` (no timelock) and hook `rescuePoolFees` pay the regular split **directly**, bypassing the escrow | Factory or hook owner | n/a | n/a | Owner power | Curve `FeesRescued`, hook `PoolFeesRescued` | **No**. The protocol leg arrives as an unattributed direct transfer. |
| 13 | Creator fee recipient change (F-03) | n/a | Factory `transferCreatorFeeRecipient` (creator, immediate) or `setCreatorFeeRecipient` → `executeCreatorFeeRecipientChange` (owner, **3 days of notice plus a 3-day window**) | Creator / factory owner | n/a | The creator, **and the factory owner (standing power)** | Owner power | `CreatorFeeRecipientChangeProposed`, `CreatorFeeRecipientUpdated`, vault `CreatorRecipientUpdated` | n/a; shown in governance views |

### Vesting, graduation and out-of-scope flows

| # | Flow | A. Asset | B. Source → recipient | C. Policy controller | D. Frozen when | E. Beneficiary changeable by | F. Forge authority | G. Evidence events | H. 70/20/10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 14 | Vesting releases | Memecoin (launch token) | `vault.release` → escrow: protocol `protocolFeeShareBps` and creator remainder | Creator or protocol recipient may trigger | Split frozen at the first lock | The creator recipient follows #13 | Yes | Vault `Released`, escrow `CreditedToken` (depositor = vault) | **No**. The splitter can never approve a Forge launch token (`AssetIsLaunchToken`). |
| 15 | Graduation residual ("dust") | Quote and memecoin | `PonsV2GraduationExecutor._sweepResidualBalance` → snapshot `protocolFeeRecipient`, direct transfer | n/a | n/a | n/a | n/a | Splitter `NonRevenueReceived` with `from` = executor | **No**. A separate class, `graduationResidual`. |
| 16 | Emergency reserve release | Quote and memecoin | Factory `rescueSweptGraduation` → an owner-chosen recipient, after a 7-day delay | Factory owner | n/a | Owner | Owner power | `LaunchGraduationRescued` | **No**. These are holders' reserves, not revenue. |
| 17 | Original PONS protocol fees | Any | Original PONS factory on 4663 and `contractsV2-deployed` | PONS | n/a | n/a | **No** | n/a | **No**. Out of scope, never touched. |

## 2. Revenue classes used by the ledger

| Class | Meaning | Eligible for 70/20/10 |
| --- | --- | --- |
| `PROTOCOL_BASE_FEE` | Escrow credit to the snapshot protocol recipient, attributed via depositor (a Forge curve or the hook) and the same-transaction sweep event | Yes, if the launch snapshot is 30% and the recipient is the splitter |
| `CREATOR_FEE` (base / tax) | Escrow credit to the creator recipient, split by the per-trade `tax` accumulated since the last sweep | The base part is the "70"; the tax is excluded |
| `VEST_RELEASE_PROTOCOL` / `VEST_RELEASE_CREATOR` | Buyback-vault releases (the launch token) | No |
| `UNATTRIBUTED_CREDIT` | Any escrow credit whose depositor is not a Forge curve, the hook or the vault | No |
| Splitter `LaunchFee` | ETH from the factory | No |
| Splitter `graduationResidual` | Direct transfer from the graduation executor | No |
| Splitter `UnattributedNative` / `UnattributedToken` | Every other direct transfer (rescues, donations) | No |

## 3. Policy conclusion

- **Snapshot parameters:** the Forge-owned stack's default protocol share is exactly **30%**, and `protocolFeeRecipient` is part of the per-launch snapshot. Pointing the hook's `protocolFeeRecipient` at a Forge-owned splitter **before** launches therefore routes exactly the protocol leg of those launches' base fees to it. No financial mathematics changes.
- **The creator's 70%** stays in the canonical escrow under the creator's own key.
- **Eligibility is per launch:** a launch whose snapshot differs (another share, or another recipient) is shown with its **actual** split, and the 70/20/10 claim fails closed for it.
- **Out of scope:** original PONS fees are outside Forge authority.
- **Authority not yet proven:** `FORGE_FEE_POLICY_AUTHORITY_UNPROVEN` remains `true`, because in the sandbox every owner is a single local key, not a reviewed governance authority.
