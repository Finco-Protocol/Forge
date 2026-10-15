# W04 → W05 Handover — Economics & Treasury

W04 delivers a **financial sandbox**:

- a Forge-owned protocol revenue splitter,
- a deterministic financial ledger over the W03 indexer,
- reconciliation,
- creator earnings and claims, and a public treasury and governance dashboard.

It does **not** activate production fee routing. `PRODUCTION_BLOCKED=true`, `FINCO_BURN_ENABLED=false`, `FORGE_FEE_POLICY_AUTHORITY_UNPROVEN=true`.

## Production activation blockers

| Id | Blocker | Needed |
| --- | --- | --- |
| AUDIT | No external audit of the splitter, the ledger attribution rules, or the W02/W03 M-ELIG stack | Independent financial and security audit |
| GOV | Splitter, hook and factory owners are single sandbox keys | Timelocked multisig governance, independently reviewed; then `FORGE_FEE_POLICY_AUTHORITY_UNPROVEN` can be reconsidered |
| F-03 | Factory owner can redirect any launch's creator fee recipient (3 days of notice plus a 3-day window) | A governance decision: keep (disclosed), narrow, or remove in a new factory version |
| F-04 | Rescue hatches (`rescueCurveFees`, `rescuePoolFees`, `rescueSweptGraduation`) with no or short timelock | Governance policy, monitoring and disclosure. Rescued protocol legs arrive as unattributed non-revenue. |
| ESCROW-CREDIT | The escrow's permissionless `credit` lets third parties credit the splitter key. Correction A keeps such credits out of 70/20/10 with an attested eligible-revenue ceiling, but provenance is **attested, not proven** on chain. | Keep the trusted attestor (with the custody below) or adopt a reviewed escrow change that records provenance on chain. The escrow is canonical, so the latter needs its own review. |
| ATTESTOR | Revenue-attestor key is a sandbox key; `REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED=false`; the local-test signer refuses non-dev chains | KMS/HSM custody separated from the treasury and governance keys, monitoring of `EligibleRevenueAuthorized`, an incident runbook (`revokeRevenueAttestor`), and independent review of the attestation rule (`finance/attestor.ts`) |
| CUSTODY | No production treasury custody (KMS/HSM or multisig) for the treasury recipient | Custody design and approval |
| BURN | No FINCO token, conversion route or burn executor | A separate FINCO token track. A new splitter version with a reviewed `IFincoBurnReserveExecutor` and governance approval. |
| DEPLOY | No Forge stack on Robinhood 4663; no production V4 acceptance | W05 deployment plan, including hook address mining against the real PoolManager |
| QUOTE | No ERC-20 quote assets approved for a production Forge factory | Asset review: no fee-on-transfer, no rebasing, no blocklists, or explicit handling |
| LEDGER-SCALE | The ledger is recomputed from `chain_events` per request | Materialised projection plus Postgres for production |
| LEGAL | Revenue distribution, treasury and reserve terms, creator disclosures | Legal review |
| LICENSE | BUSL-1.1 (v4-core Pool/Position) legal-review gate carried forward | Legal review |

## Operating notes (sandbox)

- **Pulling revenue:** anyone may call `pullRevenue(asset, 0)`. Pulls never touch creator funds, and never exceed the attested eligible-revenue ceiling. The worker attests new eligible revenue after each indexing pass (sandbox key only). Treasury → Accounting shows the provenance status per asset.
- **Attestor incidents:** `revokeRevenueAttestor()` (owner) is atomic since PR #5 Correction A: it stops new ceilings, discards any pending rotation and pauses pulls (claims unaffected). A replacement needs a NEW proposal and the 3-day timelock, and pulls resume only through an explicit owner `setPullsPaused(false)`.
- **Claims:**
  - Creators claim with `PonsV2FeeEscrow.claim` / `claimToken` from their own wallet. The UI prepares the transaction; the wallet signs it. A reported hash counts only once its contents and the canonical claim event are verified.
  - The treasury recipient claims with `claimTreasury`.
- **Recording unattributed surplus:** call `recordUnattributed(asset)` when the reconciliation shows `RECONCILED_WITH_UNRECORDED_SURPLUS`.
- **Policy changes** follow `docs/W04-ECONOMICS-ARCHITECTURE.md` §5. Never repoint an existing launch; snapshots are immutable.

## W05 outcome (see `W05-*.md`)

W05 hardened the stack and added release gating; it did **not** make anything production-ready. Closed: W05-01 (attestor bounds), materialized ledger/Postgres mode, KMS adapters (disabled), genuine-V4 local lifecycle, deploy tooling (dry-run only), monitoring + 15 drills. Still open and visible in `release/readiness-manifest.json`: B01–B08 operator items, C01–C06 external audit/legal items, F-03/F-04 owner powers (disclosed, not approved), Robinhood fork tests (CI-only; the ArbOS block semantics were MEASURED there and fixed via ArbSys, W05-05 — confirm the CI probe passes), hook CREATE2 production salt. Release gate cannot report production readiness.
