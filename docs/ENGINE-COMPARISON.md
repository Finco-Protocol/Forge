# Engine Comparison — PONS V2 vs Clanker v3.1 vs fly69 (Robinhood adaptation)

Workflow 01 comparison, 2026-10-08. Sources: direct read-only inspection of
`ponsdotdev/pons-labs` @ `18da08d` (this fork), `clanker-devco/v3.1-contracts`
@ `6a399e38` (tag v3.1), `fly69-fun/contracts` @ `5abdc9d` (3 commits,
2026-07-21), plus the audit/intelligence gathering recorded in
`docs/SECURITY-REVIEW.md`.

**Correction to the working premise:** neither alternative is a Uniswap V4
engine. Clanker v3.1 and fly69 both launch tokens into **1%-fee Uniswap V3
pools** with the full supply seeded as a single-sided position and the LP
NFT permanently locked. "Graduation" does not exist on-chain in either.

## Side-by-side

| Dimension | PONS V2 | Clanker v3.1 | fly69 (Clanker fork) |
| --- | --- | --- | --- |
| Venue model | bonding curve → full-range **V4** pool + singleton hook | V3 1% pool from block 1 | V3 1% pool from block 1 |
| Financial contracts | 8 (factory, deployer, curve, token, guard, executor, locker, vault) + hook | 4 (factory, token, vault, locker) + deployer lib | same 4 + deployer lib |
| Robinhood compatibility | purpose-built for 4663; wiring verified live | none (Base/Abstract/Monad; Superchain-oriented) | demonstrated: 4663 pinned addresses, fork tests vs live RPC, Sourcify-verified deploys (factory + locker checked) |
| Test reproducibility | none upstream; **Forge adds 87 passing tests** | **zero tests, no CI** | 38 test functions / 9 files incl. a live-4663 fork E2E; fresh clone needs submodules + a manually placed v3-core |
| Source ↔ deployment | **source does not compile; escrow + router unpublished; not the deployed source** (F-01/F-02) | published source matches the documented v3.1 deployment era; Base factory `0x2A787b…` | published; fork diff vs upstream is small and documented in-repo |
| Licensing | MIT first-party; **BUSL-1.1 v4-core `Pool`/`Position` linked**; GPL tickmath in V1; BaseHook untraceable | MIT first-party; vendored v3-core carries BUSL-1.1 (TickMath GPL is the only import used) | MIT throughout; no vendored v3-core |
| Audit coverage | **none published**; one third-party draft audit (Hackerbane) with 2 High owner-trust findings, remediation pending | 0xMacro A-1 (2025-03-18), scope = all of v3.1 `src/`, 0 High/Critical; (newer clanker trees: 0xMacro A-3 + Guardian 2026-08 with 20 High, 30 acknowledged) | **upstream audit only — none of the six fork changes are audited** |
| Fee allocation | quote-denominated; protocol/creator/buyback split snapshotted per launch; capped creator tax; escrow claims | 20% team (fixed) + creator 1–80% + interface; zero legs fall back to team recipient (misroute footgun) | same, minus the fallback footgun; WETH-only payouts; owner-tunable launch fee |
| Initial liquidity requirement | quote accumulates on the curve; pool seeds from swept reserves (no upfront quote beyond the threshold) | 0 quote tokens (single-sided full-supply position) | same; platform-standard start tick ≈ 3 WETH FDV at 1B supply |
| Owner powers | extensive but timelock/delay-bounded in part (fee-recipient override 3d, reserve rescue 7d); renounce disabled | `initialize()` re-callable → full routing hot-swap; kill switch; locker sweeps; team-leg redirect | same minus `deployTokenZeroSupply`; plus launch-fee config |
| Maintenance burden | high while F-01/F-02 open (source ≠ deployment) | effectively frozen upstream | small repo, stale submodule pin, private-monorepo references |
| Failure/exploit surface | larger (curve + hook + escrow + vault + executor + guard); strong in-code defensive posture; operator/owner MEV surface on sweeps (F-05) | smallest; known footguns documented by its own audit; liquidity permanently locked (also a property) | between the two; `_swapToWeth` uses `amountOutMinimum=0` (deliberate, documented) |
| GitHub-verification integration effort | needs factory-level gating (permissionless `launchToken`); curve/launch economics frozen per launch make an EIP-712 gate clean to add | same insertion point in `deployToken`; permissionless → must be in-contract | same; fly69 already demonstrates in-contract launch-gating (fee pull + recipient validation) |

## Weighted assessment (weights chosen for FINCO's goal: GitHub-verified
fair-launch tokens with protocol fee capture and an eventual buyback/burn,
on Robinhood Chain)

| Criterion (weight) | PONS V2 | Clanker v3.1 | fly69 |
| --- | --- | --- | --- |
| Robinhood Chain fit (20%) | 9 | 2 | 7 |
| Security assurance today (20%) | 2 | 7 | 4 |
| Source trust & reproducibility (15%) | 2 | 7 | 6 |
| Feature fit: curve, fees, buyback machinery (15%) | 9 | 4 | 5 |
| Licensing cleanliness for commercial use (10%) | 4 | 4 | 7 |
| Build/test posture (10%) | 3 (with Forge harness: 7) | 1 | 6 |
| Integration effort for the GitHub gate (10%) | 7 | 6 | 7 |
| **Weighted total** | **4.9** | **4.6** | **5.8** |

(0–10 scale per cell; totals are weight-normalized.)

## Recommendation

**PONS V2 remains the preferred engine on product merit — it is the only
candidate with a bonding curve, quote-denominated fee splits, a buyback
vault, and verified V4 wiring on chain 4663 — but it must not receive any
further financial-contract development until the blockers close.** The
scored comparison has fly69 marginally ahead *today* purely on
assurance/provenance grounds (published source, Sourcify-verified deploys,
38 tests), yet fly69 is itself an **unaudited three-commit fork** whose
V3 model lacks every financial mechanic FINCO specified, and adopting it
would mean building the curve/fee/buyback stack ourselves anyway.

This is **not** a recommendation to switch to Clanker: Clanker v3.1 is
Base-oriented, audited at its upstream commit, but feature-poor for
FINCO's requirements and no more V4-native than fly69.

**ENGINE_REVIEW outcome: FOUNDATION_CONDITIONAL** (see the PR
description): PONS V2 preferred; the explicitly listed corrections in
`docs/SECURITY-REVIEW.md` (F-01, F-02 mandatory; F-03–F-08 accepted-with-
controls) gate all subsequent financial-contract work.
