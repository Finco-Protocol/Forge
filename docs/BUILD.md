# Reproducible Build

This repository shipped with **no build system**: no `foundry.toml`, no
hardhat config, no package manifest, no tests. `contract-meta.json` records
only the V1 deployment's settings (solc 0.8.30, optimizer 300 runs,
cancun). Workflow 01 added the Foundry harness in this PR.

## Toolchain

| Component | Version |
| --- | --- |
| Foundry (forge/cast/anvil) | v1.8.5 |
| solc | 0.8.30 (pinned; satisfies `^0.8.26` V2 pragmas and matches V1's recorded metadata) |
| via_ir | true (required, see below) |
| evm_version | cancun |
| optimizer | 300 runs |

**Assumption recorded:** the V2 deployment metadata is NOT recorded in this
repository. `0.8.30`/300-runs is taken from the only recorded metadata
(V1's `contract-meta.json`); a third-party audit of the live V2 factory
(Hackerbane HB-AR-2026.2) reports the deployed V2 factory was verified with
solc **0.8.35** on 2026-08-04. Exact-byte reproduction of the deployed V2
bytecode from this repository is therefore impossible today (see F-01/F-02
in `docs/SECURITY-REVIEW.md`).

## Profiles

| Profile | Contents | Result at HEAD |
| --- | --- | --- |
| `default` | Full V2 tree **including** `PonsV2LaunchFactory.sol` | **FAILS — by design.** Canary for the upstream compile break |
| `testable` | V2 tree minus the factory, plus `test/` | **PASSES** — 87 tests, 0 failures |
| `v1` | Full V1 tree (`contractsV1/`) | **PASSES** (compiles; no tests written — V1 is not the engine candidate) |

### Commands

```bash
foundryup                            # install toolchain
forge build                          # canary: EXPECTED to fail (see below)
forge build --profile testable       # the passing harness
forge test  --profile testable       # 87 tests, 2 invariant suites
forge build --profile v1             # V1 generation compiles
```

## Why the full build fails (upstream defect, not a harness issue)

`forge build` fails with the exact upstream error:

```
Error (9582): Member "exemptFromSnipeTax" not found or not visible after
argument-dependent lookup in contract PonsV2BondingCurve.
   --> contractsV2/src/v2/PonsV2LaunchFactory.sol:749:13
```

`PonsV2LaunchFactory` calls `exemptFromSnipeTax(...)` on the concrete
`PonsV2BondingCurve` type at lines 749, 844 and 846, and tracks
`snipeTaxStartBps`/`snipeTaxSeconds` state, but the curve in this tree
contains **no snipe-tax logic at all** (zero matches for "snipe"/"exempt").
Fixing the tree in this PR would require inventing launch-economics code —
expressly out of scope. A second defect hides behind the first:
`LaunchDeployment` is constructed with a `salt` field that the deployer's
struct does not declare, and the deployer uses plain `new` (no CREATE2),
contradicting both the factory's own docs and the deterministic addresses
of the deployed system.

The deployed factory (Robinhood Chain `0x7eD598Bc…EC7e`) exposes live
`snipeTaxStartBps()` (9900) and `snipeTaxSeconds()` (3), proving the
deployed system contains snipe-tax logic this repository's curve lacks.
**The published source is not the source of the deployed bytecode.**
Corroboration: upstream issue #10 and the Hackerbane audit, which reviewed
a Blockscout-verified snapshot instead of git HEAD for the same reason.

CI therefore runs the full build as a `continue-on-error` **canary job**
that fails loudly with these errors and flips green if upstream ever
repairs the tree (at which point the canary should be converted into a
gate).

### Stack-too-deep note

Without `via_ir = true`, both generations fail legacy codegen with
"stack too deep" (`PonsV2LaunchDeployer.deployLaunch` in V2;
`PonsLaunchFactory.launchToken` in V1). The deployer's own comment states
the 16-slot constraint is managed for "the mode `forge coverage` uses",
implying upstream's ordinary builds use the IR pipeline. `via_ir = true`
is a build-setting choice in the harness, not a source change.

## Test suite

87 tests + 2 invariant suites, all passing (`forge test --profile testable`).

| File | Covers |
| --- | --- |
| `test/PonsV2BondingCurve.t.sol` (25) | Curve buys/sells, fee+tax accrual on the quote leg, partial-fill clamp + refund, price-bound slippage, reserve accounting, ERC-20 and fee-on-transfer quote assets, sweeps (protocol/buyback/creator split, operator gating, fold-back), graduation (skip-buyback sweep, reserve handover, trading halt), rescue path, creator-control authorization |
| `test/PonsV2MemeHook.t.sol` (16) | Hook CREATE2 deployment at the exact permission-flag address (0x2044), pool registration validation + policy ceilings, afterSwap fee/tax take in the unspecified currency, creator vs operator sweep authority, internal conversion with floors, buyback into the vault, rescue path, `unlockCallback` trust boundary, policy setters |
| `test/PonsV2BuybackVault.t.sol` (12) | Locker authorization (hook-as-feePolicy and curve-via-factory), weighted-average vesting math, epoch terms (mid-epoch immutability, per-epoch re-seed, rotated creator recipient survival), release split through escrow, taxed-token deposit measured by what arrived |
| `test/PonsV2LaunchLocker.t.sol` (9) | One-time factory wiring, custody verification, permanent token locks, ERC-721 receiver gating |
| `test/PonsV2LauncherToken.t.sol` (6) | Full supply to curve, immutables, metadata, voluntary burn only |
| `test/PonsV2GraduationGuard.t.sol` (6) | V4 seed preflight: valid seeds, int128 caps, extreme proportions, price floor |
| `test/libraries/*` (12) | CPMM quote math incl. rounding/monotonicity fuzz, sqrtPrice derivation incl. Q192/Q128 paths and seed-price determinism |
| `test/CurveInvariants.t.sol` (2) | Randomized buy/sell/sweep: native balance == trackedQuote, token balance == trackedTokens, reserved allocation never sold through, terminal drained state after graduation |

Mocks (`test/mocks/`): `MiniPoolManager` (faithful mini V4: unlock dispatch,
exact-input CPMM swap, afterSwap hook-delta charged to the swapper, hook
self-swap skip, sync/settle/take flash accounting, slot0 via `extsload`),
`MockFeeEscrow`, `MockFeePolicy`, `MockLaunchRecord`, `MockERC20` (optional
transfer tax), `HookDeployer` (CREATE2). `forge-std` v1.17.0 is the only
added dependency (pinned submodule).

## Untestable behaviors (recorded, not hidden)

Everything that lives in or behind `PonsV2LaunchFactory` cannot be tested
because the factory does not compile:

- launch-config validation and the economics pin (`expectedEconomics`),
- whitelist / `canLaunch` gating and `launchFee` handling,
- CREATE2 launch namespacing (currently also absent from the deployer),
- the full two-phase graduation orchestration
  (`graduate` → Swept → `createGraduatedPool` → PoolCreated),
- `forceSweptGraduation` / `rescueSweptGraduation` (7-day) /
  `rescueCurveFees` owner paths,
- creator-fee-recipient self-service transfer and the 3-day timelock
  override, and buyback enable/disable authorization,
- `launchTokenFor` forwarder attribution,
- end-to-end Permit2 approval dance and PositionManager mint (executor is
  unit-reachable but its callers are not),
- the launch-second snipe tax and exemption list (absent from this tree).

These are enumerated in CI annotations and in
`docs/SECURITY-REVIEW.md` finding F-01.
