# Independent Security Review — PONS V2

Workflow 01 independent review of the PONS V2 engine as published at
upstream commit `18da08d944ee4bed41d43dada3f4c29f5f524e57` (2026-10-08).
Reviewer: FINCO Forge engineering (independent of Pons Labs). Method:
full read of all 15 first-party V2 files (~4,900 LoC), 87-test Foundry
harness (see `docs/BUILD.md`), blob-level vendored-dependency diff, live
on-chain state reads against Robinhood Chain, and retrieval of all
locatable external audit material.

**Verdict up front:** the on-paper architecture is unusually defensively
written for this product class, but it **cannot currently be responsibly
built on**: the published source does not compile and demonstrably is not
the source of the deployed system, the fee escrow and launch router are
not published at all, and no audit of any of it has been published.

---

## 1. System map (deployable contracts and trust relationships)

```
PonsV2LaunchFactory (Ownable2Step) ── the trust root for launch orchestration
│  owner powers: launch configs, launch fee, whitelist gate, pair-token
│  approval + economics, snipe-tax terms, maxCreatorTax, deployer/executor
│  wiring, forceSweptGraduation, rescueCurveFees, rescueSweptGraduation,
│  buyback disable, creator-fee-recipient override (3d timelock + 3d window)
├─ PonsV2LaunchDeployer   onlyFactory; deploys curve+token pair (no CREATE2 in this tree)
├─ PonsV2GraduationExecutor onlyFactory; Permit2 dance + full-range mint; dust sweeps
├─ PonsV2GraduationGuard  stateless preflight mirroring V4 rejections
├─ PonsV2LaunchLocker     onlyFactory; permanent custody; NO withdrawal path
├─ PonsV2MemeHook (Ownable2Step, IPonsV2FeePolicy) ── second trust root
│  owner powers: protocol share (≤50%), hook fee (≤10%), buyback share,
│  price-impact bound, protocol recipient, fee-sweep operator (live)
│  per-pool (frozen at registerPool): fee/tax/split terms, creator
├─ PonsV2BuybackVault (Ownable2Step) ── 5-year linear vest, epoch model
├─ PonsV2BondingCurve (per launch, onlyFactory admin surface)
│  immutable at launch: fee/tax/split/threshold/phantom reserve
│  live: creator recipient (factory-gated), buyback flag, fee buckets
└─ PonsV2LauncherToken (per launch) ── fixed supply to curve, no privileges
   [deployed but NOT in this repo: PonsV2FeeEscrow, PonsV2LaunchAndBuy router]
```

External dependencies: Uniswap v4 PoolManager + PositionManager + Permit2
on chain 4663 (addresses verified live — see
`docs/ROBINHOOD-CHAIN-VALIDATION.md`).

---

## 2. Findings register

Severity uses normal engineering convention. "Confirmed present" means
verified against the exact current source (not inferred from reports).

### F-01 · BLOCKING · Published source does not compile and is not the source of the deployed system

- **Evidence (reproduced in this repo's CI):**
  `Error (9582): Member "exemptFromSnipeTax" not found … in contract
  PonsV2BondingCurve` at `PonsV2LaunchFactory.sol:749` (also 844, 846).
  The factory carries `snipeTaxStartBps`/`snipeTaxSeconds` owner functions
  and a `LaunchDeployment.salt` field the deployer struct does not
  declare; the deployer uses plain `new`, not CREATE2.
- **Deployed-vs-source divergence, independently verified on chain:** the
  live factory (`0x7eD5…EC7e`) returns `snipeTaxStartBps() = 9900`,
  `snipeTaxSeconds() = 3` — the deployed curve demonstrably contains
  snipe-tax machinery absent from this tree.
- **Corroboration:** upstream issue #10 (identical report, still open);
  Hackerbane audit HB-AR-2026.2 states git HEAD `79e99efd…` "does not
  compile to the live V2 factory" and reviewed a Blockscout snapshot.
- **Disposition:** BLOCKING for any further financial-contract work.
  Requires upstream to publish the deploy-time source (curve with snipe
  tax, CREATE2 deployer, escrow, router) and a byte-level verification
  against the deployed bytecode. Until then, nothing reviewed here can be
  claimed to describe production behavior.

### F-02 · HIGH · Core deployed components are unpublished

`PonsV2FeeEscrow` (holds all protocol/creator fee balances) and
`PonsV2LaunchAndBuy` (atomic launch-and-buy router, per upstream issue #26
"deleted rather than renamed") have no published source; the V2 deployment
metadata (solc/settings) is also absent. Every trust claim that routes
through the escrow is unverifiable. Disposition: blocking prerequisite to
F-01's resolution; FINCO must not treat fee custody as reviewed.

### F-03 · HIGH (owner trust) · Protocol owner can redirect any launch's creator fees

`setCreatorFeeRecipient` + permissionless `executeCreatorFeeRecipientChange`
(the 3-day timelock + 3-day execution window) is a **standing power over
creator revenue**, not a narrow lost-key recovery: the code documents this
explicitly. A hostile owner Safe can retarget the fee stream of every
launch, pre- and post-graduation (curve, hook, and buyback vest all
follow). Confirmed present at current source; identical to Hackerbane
HACK-01 (remediation PENDING). Disposition: acceptable only with an
acknowledged, monitored, preferably multisig/timelocked owner; FINCO must
not represent creator revenue as owner-independent.

### F-04 · HIGH (owner trust) · Owner-gated reserve/fee escape hatches

Four owner paths bypass the happy path: `forceSweptGraduation` (sweeps a
ready-but-unseedable curve), `rescueSweptGraduation` (swept reserves to an
arbitrary recipient after 7 days), `rescueCurveFees` and
`rescuePoolFees` (direct payouts bypassing the escrow). The 7-day delay on
reserve rescue is meaningful only because `createGraduatedPool` is
permissionless; the fee rescues are unbounded by any delay. Confirmed
present; identical to Hackerbane HACK-02 (PENDING). Disposition: same as
F-03 — these are recovery powers whose safety is exactly the owner's
honesty plus monitoring.

### F-05 · MEDIUM · Fee-sweep operator can sandwich the protocol's own conversions

`sweepFees`/`sweepPoolFees` gate all price-sensitive internal swaps behind
a single operator address (owner-set, live-rotatable) and treat that
operator's `min*Out` arguments as the real defense; the code says so in
plain text. A malicious or compromised operator can choose permissive
floors and extract up to `maxInternalPriceImpactBps` (default 3%) per
conversion on every pool/curve. Disposition: documented by upstream;
requires an operator key as protected as the owner key, plus
independent-price floor computation off-chain.

### F-06 · MEDIUM · Anti-snipe surface is unreviewable in this tree

The docs describe a 99%→0% decaying launch-second tax with up to 32
exempted wallets; the deployed factory proves the tax exists (F-01), but
the shipped curve contains none of it. The most user-visible economic
protection — including a privileged-trading surface (exemptions) — cannot
be reviewed from the published source, and the deployed bytecode has not
been compared to anything. Disposition: blocked behind F-01.

### F-07 · MEDIUM · No published audit covers the current code

As of 2026-10-08: the three audits the project announces (SB Security,
Dingbats, Pashov Audit Group) have **no published Pons reports** anywhere
locatable (checked pashov/audits index, SB-Security/audits report list,
aggregators); Pons' own docs say "No audit has closed. Treat v2 as
unaudited." The only completed public review is Hackerbane HB-AR-2026.2
(draft v0.5, 2026-10-05; window 2026-09-03→13; scope: V1+V2 live trees via
Blockscout snapshot, reviewed commit `79e99efd…`): **0 Critical, 2 High,
10 Medium, 16 Low, 12 Informational; remediation PENDING**, and it is not
cited by the project's own materials. Disposition: treat the engine as
unaudited; announced/ongoing audits carry no assurance weight.

### F-08 · MEDIUM (ecosystem) · Documented mass extraction on launches

Public reporting (~2026-09-28, Wazz/@WazzCrypto; carried by CryptoPotato,
TheStreet, CryptoTimes, MitchellLake) describes ~$18.43M extracted across
53 Robinhood Chain launches, "nearly all" created via Pons V2, using
70–200-wallet bundles. Mechanism attribution to the 32-wallet snipe-tax
exemption appears only in secondary coverage — **UNVERIFIED mechanism,
press-verified event**. Disposition: an engine whose launch window was
massively farmed in production needs its snipe/exemption path audited
(see F-06) before FINCO points real issuance at it.

### F-09 · MEDIUM (licensing) · BUSL-1.1 code linked into the build

`v4-core`'s `Pool.sol` and `Position.sol` are BUSL-1.1 **upstream and
here** (faithfully vendored — see `docs/LICENSE-INVENTORY.md` §2); the
graduation preflight links them. Legal review required before commercial
use. (Also: `PonsTickMath.sol` GPL-2.0-or-later — V1 only.)

### F-10 · LOW · Reverting fee recipients can deny launches

`_payLaunchFee` reverts the whole launch if the (owner-set) protocol
fee recipient's ETH transfer fails; Hackerbane flagged the analogous
config-fragility class (their M). Confirmed present. Disposition: keep
the recipient a plain payable; monitor.

### F-11 · LOW · Docs drift on launch gating

`pons-beta.md` says launching is "whitelisted wallets only" while the
live factory returns `canLaunch(anyone) = true` (2026-10-08). Operator
may re-close at any time; record as documentation drift, not a defect.

### F-12 · INFORMATIONAL · Vault epoch re-seeds protocol terms from locker arguments

A fresh vesting epoch takes `protocolRecipient`/`protocolFeeShareBps`
from the locking call. In production both arguments are launch-frozen
immutables, so divergence requires a compromised authorized locker
(hook/curve). Verified by test
(`test_protocolTermsImmutableWithinEpochAndReseededPerEpoch`).

### F-13 · INFORMATIONAL · Curve buy slippage is a price bound, not a quantity bound

`minTokensOut` is reinterpreted under partial fills ("price paid no worse
than the caller's own implied price"); documented in-code and covered by
tests. Callers should compute floors off an independent price.

### F-14 · INFORMATIONAL · Supply-chain hygiene

Easter-egg markdown/JPEG files inside vendored dependency trees
(`toto.*`, `truth.md`, `oz.jpg`, `ozz.md`); `BaseHook.sol` with no
verifiable public upstream; markdown inside `src/v2/testing/` describing
two undeployed Solana-bridge concepts. No code impact found; replace/
prune in any production tree.

### F-15 · CONSIDERED AND DISMISSED · Forced fee conversion via `unlockCallback`

We specifically probed whether an arbitrary caller could drive
`PonsV2MemeHook.unlockCallback` through `PoolManager.unlock` to dump the
hook's pending-fee inventory without operator gating. Dismissed: v4-core's
`unlock` only ever calls back into the **unlocker's own** callback, so the
hook's callback is reachable only via its own `sweepPoolFees`
(operator/creator gated); additionally v4 skips a pool's hooks when the
hook itself is the caller (covered by test
`test_unlockCallback_revertsForNonPoolManager` and the mock's hook-skip
semantics).

### Also reviewed, no finding beyond documentation

Reentrancy posture (guards on buy/sell/sweep/release/lock; `graduate`
deliberately unguarded with flag-ordering rationale — sound as written;
quote-asset callback re-entry handled by the second `graduated` check);
reserve conservation (tracked vs live balances defeat donation attacks —
covered by invariants); graduation seed determinism (reserved-allocation
identity — covered by tests); buyback vault vesting math (weighted-average
clock — covered); locker has genuinely no exit path; token has no admin
surface; `renounceOwnership` disabled everywhere by design
(centralization is explicit, not accidental).

---

## 3. Fee-policy mutability matrix

| Surface | Pre-graduation curve | Post-graduation pool | Mutability |
| --- | --- | --- | --- |
| protocolFeeShareBps / buybackBurnBps / hookFeeBps / impact bound | immutable snapshot | frozen at `registerPool` | owner changes affect **future launches only** ✓ |
| creator tax | immutable | frozen at registration | never changes ✓ |
| creator fee recipient | factory-gated, self-service | factory-gated | creator any time; owner via 3d timelock (F-03) |
| buyback flag | factory-gated | factory-gated | creator may enable; owner may only disable ✓ |
| protocol fee recipient (hook state) | n/a | read at `_payLaunchFee`/rescue **live** | owner-change affects future launch fees immediately (documented) |
| feeSweepOperator | read live | read live | owner-rotatable for liveness (F-05) |

## 4. External audit ledger (exact scope)

| Report | Date | Scope/commit | Results | Status |
| --- | --- | --- | --- | --- |
| Hackerbane "Pons Family Launchpad" HB-AR-2026.2 (draft v0.5) | 2026-09-13 → v0.5 2026-10-05 | V1 factory `0xA5aA…1feB` (verified 2026-07-13, solc 0.8.30) + V2 factory `0x7eD5…EC7e` (verified 2026-08-04, solc 0.8.35); reviewed commit `79e99efd9d4fab7138b1a5524b907b2f5aae6586` — **does not compile to live**, review used Blockscout snapshot | 0 C / 2 H / 10 M / 16 L / 12 I; H-01 = F-03, H-02 = F-04 | **Remediation PENDING** |
| SB Security (announced) | — | no published Pons report found | — | claimed in progress |
| Dingbats (announced) | — | no published Pons report found | — | claimed in progress |
| Pashov Audit Group (announced) | — | no published Pons report found (client logo only) | — | claimed in progress |

Deployed-bytecode comparison: the only available evidence is Hackerbane's
Blockscout snapshot + this review's on-chain reads (factory owner, config
count, snipe-tax getters, fee policy, wiring, code sizes — all in
`docs/ROBINHOOD-CHAIN-VALIDATION.md`). A source↔bytecode match has **not**
been established by anyone.

## 5. Disposition summary

No finding was marked resolved without independent verification. F-01 and
F-02 are engineering blockers. F-03/F-04/F-05 are standing trust
requirements that FINCO must accept explicitly, with operational controls,
before any financial-contract development on this engine.
