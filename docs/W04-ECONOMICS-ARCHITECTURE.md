# W04 — Economics, Revenue Distribution & Treasury V1 (sandbox)

Status: **financial sandbox**. `PRODUCTION_BLOCKED=true` · `FINCO_BURN_ENABLED=false` · `FORGE_FEE_POLICY_AUTHORITY_UNPROVEN=true`. Nothing here is deployed; no real funds move.

Companion documents: the flow-by-flow authority review is in `docs/W04-FEE-AUTHORITY.md`; threats are mapped to tests in `docs/THREAT-MODEL-W04.md`; the change list is `docs/MODIFICATION-REGISTER.md` §8; production blockers are in `docs/W04-W05-HANDOVER.md`.

## 1. Model

For an **eligible base fee** F, meaning one whose launch snapshot has a 30% protocol share and names the Forge splitter as recipient:

| Share | Recipient | Path |
| --- | --- | --- |
| 70% | Creator | `PonsV2FeeEscrow` under the creator's own key, claimed by the creator |
| 30% | Forge protocol | `PonsV2FeeEscrow` under the **splitter's** key, pulled by `ForgeProtocolRevenueSplitter` |
| → 20 points | Forge treasury | Splitter treasury liability; the treasury recipient claims it |
| → 10 points | FINCO reserve | Splitter reserve liability, with **no exit** |

Never part of 70/20/10:

- **Creator tax:** 100% to the creator.
- **Launch fee, graduation residual, owner rescues, donations:** held by the splitter as non-revenue.
- **Buyback-vest releases:** paid in the launch token, which the splitter refuses.
- **Original PONS fees:** outside Forge authority.

With buyback-and-lock enabled, the creator's 70% becomes 35% cash plus 35% buyback, which vests over 5 years. Releases are then split 70/30 in the launch token. The UI reports this effective split instead of claiming a flat 70%.

## 2. On-chain changes

The only on-chain addition is a **new, external** component. No existing contract changed, and the factory bytecode is unchanged at 24,470 B.

- **`contractsV2-forge/src/v2/forge/ForgeProtocolRevenueSplitter.sol`** (10,862 B runtime):
  - It is the escrow key the hook's `protocolFeeRecipient` names. `pullRevenue(asset, amount)` is permissionless: it claims only the splitter's **own** escrow balance (the escrow pays `msg.sender`), measures the actual balance delta, and allocates it.
  - **Revenue provenance (Correction A):** a pull may only debit the escrow while `escrowClaimed(asset) + amount ≤ eligibleCeiling(asset)`. Third-party credits to the splitter's escrow key therefore stay in the escrow and can never enter 70/20/10. See §2a.
  - **Supported assets (Correction A):** native ETH is always supported. An ERC-20 can be approved only when the wired Forge factory currently lists it in `approvedPairTokens`, its `pairTokenEconomics` are configured (`phantomQuote` and `graduationThreshold` non-zero), and the token's own `decimals()` equals the factory's recorded scale. Launch tokens, EOAs and unsupported ERC-20s are refused, and approval fails closed while no factory is wired. A later factory de-listing does not revoke the splitter's approval, so existing launches' revenue is not stranded. Revoking stops pulls only; allocated liabilities stay claimable.
  - **Rounding:** the reserve's cumulative entitlement is `floor(lifetimeRevenue(asset) / 3)` and the treasury takes the remainder. The reserve never exceeds an exact third, there is no per-pull drift, and treasury plus reserve equals revenue exactly.
  - **Native inflows:** any native inflow other than the escrow payment a pull is waiting for is non-revenue. `LaunchFee` is recorded when the sender is the wired factory; everything else is `UnattributedNative`.
  - **Direct ERC-20 transfers:** they show up as surplus and are recorded by the permissionless `recordUnattributed`.
  - **Claims:** `claimTreasury` (treasury recipient only) supports partial claims. `releaseNonRevenue` (owner only) can send **only** to the treasury recipient, and only from the non-revenue bucket.
  - **Governance:** treasury-recipient rotation is timelocked (3 days of notice plus a 3-day execution window). Asset approval refuses EOAs and Forge launch tokens. A pause stops pulls only, never claims. Renouncing ownership is disabled.
  - **Reserve:** no reserve withdrawal, swap or burn function exists, and `FINCO_BURN_ENABLED` is a `constant false`.
  - **Conservation invariant (per asset):** `balance ≥ treasuryLiability + reserveLiability + nonRevenueHeld`, with the surplus recorded as non-revenue.
- **`IFincoBurnReserveExecutor.sol`:** an architectural interface only. It is not implemented, deployed or referenced. See §6.

### 2a. Revenue provenance: the eligible-revenue ceiling (Correction A)

**Finding.** The canonical escrow's `credit` / `creditToken` are permissionless and keep no on-chain record of who credited what. The original splitter claimed its whole escrow balance, so a third party crediting the splitter's escrow key had that credit allocated 70/20/10. Reproduced against the real escrow at `f3b8b13`: a 0.1 ETH base fee (0.03 ETH protocol leg) plus a 1 ETH third-party credit produced `RevenueAllocated.received = 1.03 ETH`, an over-allocation of 1 ETH (treasury 0.686…, reserve 0.343…).

**Correction.** The escrow is canonical and stays unchanged, so the bound is applied at the splitter:

| Element | Rule |
| --- | --- |
| Ceiling | Per asset, a cumulative `eligibleCeiling`. `pullRevenue` reverts `ExceedsVerifiedRevenue` above `eligibleCeiling − escrowClaimed`; `amount = 0` pulls `min(escrow balance, headroom)`. |
| Raising it | `authorizeEligibleRevenue(EligibleRevenue, signature)`, relayable by anyone. The EIP-712 struct binds the domain (chain id and splitter address), the escrow, the wired factory, the asset, the **cumulative** amount, a strictly increasing per-asset nonce, a deadline, and an evidence block number and hash. |
| Fail-closed checks | No attestor; wrong escrow or factory; factory not wired; unapproved asset; expired deadline; evidence block not strictly in the past, older than 256 blocks, zero hash, or a hash that differs from `blockhash` (a reorganised evidence block); stale or replayed nonce; decreasing ceiling; signer is not the attestor. |
| Attestor role | `revenueAttestor` must differ from the owner, the treasury recipient and the splitter (checked at construction, on rotation and on treasury-recipient changes). Rotation uses the same 3-day notice and 3-day window as the treasury recipient. `revokeRevenueAttestor()` is immediate, atomic and fails closed: no new ceilings, any pending rotation is discarded and pulls are paused in the same transaction (PR #5 Correction A); a replacement needs a NEW proposal and the full timelock, and pulls resume only by an explicit owner unpause. |
| Units | The ceiling is in escrow-debit units (the `Credited` / `CreditedToken` amounts, already measured by the escrow); allocation still uses the measured receipt, so fee-on-transfer assets stay conservative. |

**Trust boundary (explicit; not trustless).** The ceiling is an off-chain attestation. The attestor service (`apps/forge-web/src/server/finance/attestor.ts`) recomputes it deterministically from finalised, indexed canonical events only:

> Σ escrow credits to the splitter key whose **depositor** is a Forge curve, or the Forge hook together with its same-transaction `PoolFeesSwept` (ledger class `PROTOCOL_BASE_FEE`), for launches whose **frozen** snapshot names the splitter at 30%, in blocks ≤ the indexer checkpoint.

Before signing it checks that the on-chain attestor, escrow and factory match the deployment, that the recomputed amount does not exceed `escrowClaimed + escrow balance` at the evidence block, and that the evidence is inside the blockhash window. It also checks the local EIP-712 digest against the contract's `eligibleRevenueDigest` (ABI/EIP-712 parity). A faulty or compromised attestor can at worst let the splitter pull third-party credits already sitting under its own escrow key. It cannot mint, cannot reach creator funds, cannot withdraw, and is bounded by the escrow balance.

**Custody.** Production signing is disabled: `REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED = false`, and the only signer is the local-test signer, which refuses every chain except 31337 and 1337. `FORGE_REVENUE_ATTESTOR_PRIVATE_KEY` is optional; without it no ceilings are signed and pulls fail closed. The key is separate from the authority, evidence and relayer keys (enforced at start-up). W05 must approve KMS/HSM custody.

## 3. Off-chain ledger (`apps/forge-web/src/server/finance`)

- **Source of truth:** the W03 indexer's `chain_events`. W04 adds the hook, the canonical escrow, the buyback vault and the splitter to its exact allowlist; no second store exists.
- **Determinism:** `ledger.ts` is a **pure, deterministic projection**. Events are de-duplicated by `(blockHash, logIndex)` and sorted by `(block, logIndex)`, so duplicate or reordered delivery gives an identical result, and a reorg is simply a smaller event set (inherited W03 rollback). This is unit-tested.
- **Attribution:**
  - An escrow credit belongs to a launch **only** through its depositor: a Forge curve (`TokenLaunched`), or the hook combined with the same-transaction `PoolFeesSwept` (`PoolRegistered` maps a pool id to its token).
  - Legs are assigned by sweep order: the curve credits the protocol leg first, the hook credits the creator leg first. Assigning by order keeps fee-on-transfer assets correct.
  - Creator tax is separated using the per-trade `tax` accumulated since the previous sweep. A hook sweep that converted memecoin-denominated tax is reported **unsplit**.
  - Anything else is `UNATTRIBUTED` and never assigned to a project.
- **Per-project treasury and reserve figures** are the immutable 2:1 rule applied to **exactly attributed** protocol credits, and are labelled "derived". The authoritative split is the contract's own cumulative per-asset allocation.
- **Reconciliation:**
  - On-chain state is read **at the indexer checkpoint block**, so indexed and on-chain figures are directly comparable.
  - Escrow balance per (recipient, asset) is compared with credits minus claims.
  - The splitter's `ledger(asset)` and `reconcile(asset)` are compared with indexed allocations, claims and non-revenue.
  - Status is one of `RECONCILED`, `RECONCILED_WITH_UNRECORDED_SURPLUS` or `MISMATCH`.
- **Provenance (Correction A):** per asset, the treasury report gives `verifiedEligibleRevenue` (recomputed by the attestor's rule), the attested ceiling, verified escrow claimed, headroom and all escrow credits to the splitter key, broken into the classes `PROVEN_ELIGIBLE`, `UNATTRIBUTED` (third-party credits), `NOT_ELIGIBLE_POLICY` and `VEST_RELEASE`. The asset's status is one of:
  - `PROVEN_ELIGIBLE`: the attested ceiling equals verified eligible revenue;
  - `PROVENANCE_BLOCKED`: verified revenue is not yet attested (or no attestor is configured), so it cannot be pulled;
  - `RECONCILIATION_MISMATCH`: the ceiling exceeds verified evidence, pulls exceed the ceiling, receipts exceed escrow debits, or the indexed and on-chain ceilings differ. It is also raised as an exception.
- **Statements** keep these figures distinct: realised revenue pulled, escrow-credited but not pulled, non-revenue held (launch fee, graduation residual, unattributed), vest releases to the splitter key, third-party escrow credits, accrued-but-unswept buckets (live reads, labelled estimates) and vesting balances.
- **Currency:** amounts are always per asset, in base units with the asset's own decimals. No exchange rate is applied anywhere.

## 4. API and UI

| Endpoint | Access | Purpose |
| --- | --- | --- |
| `GET /api/finance/creator` | Session + bound wallet | Per-asset credited, tax included, claimed and claimable (indexed vs on-chain); per-launch snapshot, eligibility, earned base/tax, curve vs hook origin, accrued (live), buyback vest; claim history and pending submissions |
| `GET /api/finance/treasury` | Public | Overview, per-launch breakdown, per-asset statements, reconciliation, allocation and claim history, exceptions, reserve status |
| `GET /api/finance/governance` | Public | Current policy, roles, pending changes, owner-power exposure, authorization matrix, policy-change process, history, warnings |
| `POST /api/finance/claims/prepare` | CSRF-protected | Returns an **unsigned** transaction to the canonical escrow (`claim` / `claimToken`), or to `claimTreasury` for the treasury recipient. The recipient's own wallet signs; Forge never custodies keys and offers no impersonation path. |
| `POST /api/finance/claims/submitted` | CSRF-protected | Records a claim transaction hash with `kind`, `asset` and optional `amount` (0 = full balance). When the transaction is visible its contents are verified: chain, sender = the session's bound wallet, the canonical escrow or splitter, an exact claim selector (`claim()`, `claim(uint256)`, `claimToken(address)`, `claimToken(address,uint256)`, or `claimTreasury(address,uint256)`), the ABI-decoded asset and amount, and zero value. A mismatch is refused (`NOT_YOUR_TRANSACTION` 403; `WRONG_RECIPIENT_CONTRACT`, `WRONG_SELECTOR`, `WRONG_ASSET`, `WRONG_AMOUNT`, `WRONG_CHAIN`, `UNEXPECTED_VALUE` 422). A hash that is not visible is stored as `UNVERIFIED_PENDING` and is never treated as a claim. Status is `UNVERIFIED_PENDING`, `PENDING_CONTENTS_VERIFIED`, `MINED_AWAITING_INDEXER`, `FAILED`, `REJECTED`, or `CONFIRMED_INDEXED`. The last requires a successful receipt **and** the canonical indexed `Claimed` / `ClaimedToken` / `TreasuryClaimed` event for this wallet, asset and transaction. Re-submitting the same hash is idempotent; different details for the same hash are refused (`DUPLICATE_SUBMISSION_MISMATCH`). |

On the UI side, the W03 Dashboard gains an "Earnings & claims" panel, and there is a new public `/treasury` page with four tabs: Overview, Launches, Accounting and Governance.

## 5. Policy change process

1. Governance publishes the proposed policy (share, split, recipient) and its effective block.
2. A **new** splitter version is deployed and reviewed. The 2:1 split and `POLICY_VERSION` are immutable per splitter.
3. The hook owner calls `setProtocolFeeRecipient` / `setProtocolFeeShareBps`. **Only launches created afterwards** snapshot the change.
4. Existing launches keep their frozen snapshot and recipient. Nothing is silently reconfigured.
5. Each launch is marked eligible or not from its own snapshot, failing closed.

## 6. FINCO burn reserve

The reserve is a liability only. No token purchase, DEX swap, burn or automatic conversion exists, and no FINCO token address is assumed.

Activating it would require all of the following:

- a canonical FINCO token,
- a separately reviewed executor implementing `IFincoBurnReserveExecutor`,
- a price-protected and audited conversion route,
- a timelocked multisig governance decision recorded on chain,
- a **new** splitter version,
- independent financial and security review.

The original PONS buyback vault, which vests project tokens over five years, is **not** the FINCO burn mechanism.

## 7. Known limits

| Area | Limit |
| --- | --- |
| Third-party escrow credits | Closed for allocation by Correction A (§2a): such credits are never attested, so they stay in the escrow under the splitter key and are reported as `UNATTRIBUTED`. The residual is the **trusted attestor**: provenance is attested off chain, not proven on chain. Proving it on chain would require an escrow change, and the escrow is the canonical, unchanged contract. |
| Graduation residual | The executor's residual transfer arrives as a direct transfer. It is classified off chain by sender. Under the W02 mini mocks it is large; in production it is rounding dust. |
| Hook tax conversion | A hook sweep that converts memecoin-denominated creator tax cannot be split exactly between base and tax; it is reported unsplit. |
| Ledger cost | W05: materialized fold snapshots (see docs/W05-DATABASE-LEDGER.md); per-request cost still O(events) in decode, measured 2.2x faster at 100k events. |
| Mock pool manager | The W02 mini pool manager does not hold seeded native ETH. Tests top up its balance to match its own reserve accounting before a native take. This is a test-harness limitation only. |
