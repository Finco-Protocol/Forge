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

- **`contractsV2-forge/src/v2/forge/ForgeProtocolRevenueSplitter.sol`** (6,383 B runtime):
  - It is the escrow key the hook's `protocolFeeRecipient` names. `pullRevenue(asset, amount)` is permissionless: it claims only the splitter's **own** escrow balance (the escrow pays `msg.sender`), measures the actual balance delta, and allocates it.
  - **Rounding:** the reserve's cumulative entitlement is `floor(lifetimeRevenue(asset) / 3)` and the treasury takes the remainder. The reserve never exceeds an exact third, there is no per-pull drift, and treasury plus reserve equals revenue exactly.
  - **Native inflows:** any native inflow other than the escrow payment a pull is waiting for is non-revenue. `LaunchFee` is recorded when the sender is the wired factory; everything else is `UnattributedNative`.
  - **Direct ERC-20 transfers:** they show up as surplus and are recorded by the permissionless `recordUnattributed`.
  - **Claims:** `claimTreasury` (treasury recipient only) supports partial claims. `releaseNonRevenue` (owner only) can send **only** to the treasury recipient, and only from the non-revenue bucket.
  - **Governance:** treasury-recipient rotation is timelocked (3 days of notice plus a 3-day execution window). Asset approval refuses EOAs and Forge launch tokens. A pause stops pulls only, never claims. Renouncing ownership is disabled.
  - **Reserve:** no reserve withdrawal, swap or burn function exists, and `FINCO_BURN_ENABLED` is a `constant false`.
  - **Conservation invariant (per asset):** `balance ≥ treasuryLiability + reserveLiability + nonRevenueHeld`, with the surplus recorded as non-revenue.
- **`IFincoBurnReserveExecutor.sol`:** an architectural interface only. It is not implemented, deployed or referenced. See §6.

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
- **Statements** keep these figures distinct: realised revenue pulled, escrow-credited but not pulled, non-revenue held (launch fee, graduation residual, unattributed), vest releases to the splitter key, third-party escrow credits, accrued-but-unswept buckets (live reads, labelled estimates) and vesting balances.
- **Currency:** amounts are always per asset, in base units with the asset's own decimals. No exchange rate is applied anywhere.

## 4. API and UI

| Endpoint | Access | Purpose |
| --- | --- | --- |
| `GET /api/finance/creator` | Session + bound wallet | Per-asset credited, tax included, claimed and claimable (indexed vs on-chain); per-launch snapshot, eligibility, earned base/tax, curve vs hook origin, accrued (live), buyback vest; claim history and pending submissions |
| `GET /api/finance/treasury` | Public | Overview, per-launch breakdown, per-asset statements, reconciliation, allocation and claim history, exceptions, reserve status |
| `GET /api/finance/governance` | Public | Current policy, roles, pending changes, owner-power exposure, authorization matrix, policy-change process, history, warnings |
| `POST /api/finance/claims/prepare` | CSRF-protected | Returns an **unsigned** transaction to the canonical escrow (`claim` / `claimToken`), or to `claimTreasury` for the treasury recipient. The recipient's own wallet signs; Forge never custodies keys and offers no impersonation path. |
| `POST /api/finance/claims/submitted` | CSRF-protected | Records the transaction hash; it must be the caller's own transaction. Status is `PENDING`, `MINED_AWAITING_INDEXER`, `CONFIRMED_INDEXED`, or `FAILED` with recovery guidance. |

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
| Third-party escrow credits | The escrow's `credit` / `creditToken` are permissionless. A third-party credit to the splitter's **escrow key** cannot be told apart from a fee credit **on chain**, so `pullRevenue` allocates it. The ledger separates it by depositor and reports it as an exception (`THIRD_PARTY_CREDIT_TO_SPLITTER`). Closing this on chain would require escrow changes, and the escrow is the canonical, unchanged contract. |
| Graduation residual | The executor's residual transfer arrives as a direct transfer. It is classified off chain by sender. Under the W02 mini mocks it is large; in production it is rounding dust. |
| Hook tax conversion | A hook sweep that converts memecoin-denominated creator tax cannot be split exactly between base and tax; it is reported unsplit. |
| Ledger cost | The ledger is recomputed per request from `chain_events`, which is O(events). Production should materialise it (W05). |
| Mock pool manager | The W02 mini pool manager does not hold seeded native ETH. Tests top up its balance to match its own reserve accounting before a native take. This is a test-harness limitation only. |
