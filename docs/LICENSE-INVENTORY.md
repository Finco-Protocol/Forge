# License & Source-Provenance Inventory

Per-file/per-component license inventory of every source tree in this
repository, produced by Workflow 01 (2026-10-08). Method: SPDX header scan
of all 123 tracked files, plus byte-level blob-hash comparison of every
vendored file against the upstream tagged release it matches.

**Headline:** the first-party PONS contracts are uniformly MIT, but the V2
dependency tree **links BUSL-1.1 Uniswap v4 code** (`Pool.sol`,
`Position.sol`) into a protocol component (the graduation preflight), and
one vendored file (`BaseHook.sol`) has no verifiable public upstream. A
commercial fork requires legal review of both before any production use.

## 1. First-party contracts — all MIT

### contractsV1/src (V1 — legacy engine, not the Forge candidate)

| File | SPDX | Notes |
| --- | --- | --- |
| `PonsLaunchFactory.sol` | MIT | |
| `PonsLauncherToken.sol` | MIT | |
| `interfaces/ILaunchpad.sol` | MIT | Uniswap V3 interface lineage |
| `libraries/PonsLiquidityMath.sol` | MIT | |
| `libraries/PonsTickMath.sol` | **GPL-2.0-or-later** | Uniswap V3 TickMath lineage; carried intact per upstream README. GPL — viral if copied into proprietary code; V1-only, not in the V2 build path |

### contractsV2/src/v2 (V2 — the Forge candidate) — 15 files, all MIT

| File | SPDX |
| --- | --- |
| `PonsV2LaunchFactory.sol` | MIT |
| `PonsV2LaunchDeployer.sol` | MIT |
| `PonsV2BondingCurve.sol` | MIT |
| `PonsV2LauncherToken.sol` | MIT |
| `PonsV2GraduationGuard.sol` | MIT |
| `PonsV2GraduationExecutor.sol` | MIT |
| `PonsV2LaunchLocker.sol` | MIT |
| `PonsV2BuybackVault.sol` | MIT |
| `hooks/PonsV2MemeHook.sol` | MIT |
| `interfaces/ILaunchpadV2.sol` | MIT |
| `interfaces/ILaunchpadV2Graduation.sol` | MIT |
| `libraries/PonsV2BondingCurveMath.sol` | MIT (adapted from BootstrapPool.sol, code4n4 2025-01-iq-ai — contest code, MIT header retained) |
| `libraries/PonsV2GraduationMath.sol` | MIT |
| `testing/migr/PonsMigrationSettlement.sol` | MIT (standalone concept, not wired to the launch path) |
| `testing/warp/PonsWarpOriginVault.sol` | MIT (standalone concept, not wired to the launch path) |

**Do not infer the whole system is MIT from these headers.** The MIT
first-party code is compiled and deployed together with the vendored
dependencies below; the deployed system's licensing follows the
combination.

## 2. Vendored dependencies — integrity + license per component

Byte-identical counts are from `git hash-object` comparison against the
matching upstream tree (see method note at bottom).

### OpenZeppelin Contracts (`contractsV2/lib/openzeppelin-contracts/`, 24 files)

- **License:** MIT (per-file SPDX + upstream LICENSE).
- **Version:** v5.5.0 tree; three files match the newer v5.6.0 revisions
  (`Math.sol`, `SafeCast.sol` — comment/gas-level changes; `SafeERC20.sol`
  — adds `tryGetDecimals`, additive).
- **Integrity:** 21/24 byte-identical to OpenZeppelin v5.5.0; the 3
  exceptions are byte-identical to upstream v5.6.0-era revisions. **No
  behavioral modification detected in any vendored OZ file.**
- Oddity (cosmetic, not code): two markdown easter-egg files and two JPEGs
  sit inside the vendored tree (`sweet/toto.*`, `introspection/truth.md`)
  — narrative content only, no code impact.

### Uniswap v4-core (`contractsV2/lib/v4-core/`, 40 files: interfaces, libraries, types)

- **License:** MIT per-file **except `libraries/Pool.sol` and
  `libraries/Position.sol`, which carry `BUSL-1.1` upstream and here**.
  Verified: current Uniswap v4-core main (46c6834698c4, 2026-04-02) ships
  those two files as BUSL-1.1 — the Pons copies are faithful, the BUSL
  originates with Uniswap, not with Pons.
- **Integrity:** 40/40 byte-identical to v4-core main @ `46c68346`.
- **Why it matters:** `PonsV2GraduationGuard` links `Pool.tickSpacingToMaxLiquidityPerTick`
  and the guard/factory/hook all compile against v4 types. FINCO's
  commercial fork would build on BUSL-1.1 source. Uniswap's BUSL carries a
  Change Date (conversion to GPL) and usage-grant language that must be
  reviewed by counsel before any production/commercial use. The deployed
  PoolManager on Robinhood Chain is Uniswap's own deployment; the license
  question here concerns the **source we vendor and compile**, which the
  workflow flags for legal review.

### Uniswap v4-periphery (`contractsV2/lib/v4-periphery/`, 21 files incl. permit2 interfaces)

- **License:** MIT (upstream LICENSE: "Copyright 2023 Universal Navigation
  Inc.", MIT text).
- **Version:** current periphery main (9969eec, 2026-09-19); `Actions.sol`
  matches a newer revision than the rest (adds SUBSCRIBE/UNSUBSCRIBE —
  additive constants).
- **Integrity:** 20/21 byte-identical; `Actions.sol` differs only by the
  additive action constants. **No behavioral modification detected.**

### Permit2 interfaces (`contractsV2/lib/v4-periphery/lib/permit2/`, 2 files)

- **License:** MIT.
- **Integrity:** 2/2 byte-identical to Uniswap/permit2 master (cc56ad0,
  2023-09-29). Interfaces only; the deployed Permit2
  (`0x000000000022D473030F116dDEE9F6B43aC78BA3`) is Uniswap's canonical
  deployment, verified on chain 4663.

### v4-hooks-public (`contractsV2/lib/v4-hooks-public/src/base/BaseHook.sol`, 1 file)

- **License:** MIT SPDX header.
- **Provenance: UNRESOLVED.** No public repository named "v4-hooks-public"
  exists, and the file does not byte-match the BaseHook in Uniswap's
  v4-template or hook libraries we compared. Content matches the canonical
  Uniswap BaseHook pattern (IHooks + ImmutableState, `HookNotImplemented`,
  address-flag validation) and no behavioral modification is apparent from
  reading, but **no upstream blob exists to hash-verify it**. Recommendation:
  replace with a pinned, hash-verified copy of a public BaseHook before
  production (tracked in `docs/ROADMAP.md`).

### forge-std (`contractsV2/lib/forge-std/`, added by this PR — test-only)

- **License:** MIT OR Apache-2.0 (dual).
- v1.17.0, pinned as a git submodule. **Never compiled into production
  artifacts** — test harness only.

## 3. Non-code files inside dependency trees

| File | Assessment |
| --- | --- |
| `contractsV1/lib/.../sweet/toto.jpg` / `toto.md` | Personal easter egg (a pet tribute). No code. Cosmetic supply-chain hygiene issue. |
| `contractsV1/lib/.../introspection/truth.md` | ASCII-art narrative ("Ponsora"). No code. |
| `contractsV2/lib/v4-core/.../callback/oz.jpg` / `ozz.md` | Author easter egg including a personal Ethereum address. No code. |
| `contractsV2/src/v2/testing/migr/*.{md,png}`, `testing/warp/*.{md,png}` | Concept documents for two proposed (undeployed) Solana-bridge products. The accompanying `.sol` files compile but are standalone and not wired to the launch path. |
| `pons-beta/pons-beta.md` | Product documentation (app map, deployed addresses, audit status). Primary source of deployment facts used in `docs/ROBINHOOD-CHAIN-VALIDATION.md`. |

None of these affect compilation or deployed behavior; they are recorded
because unknown files inside dependency trees are a supply-chain hygiene
signal a commercial fork should not inherit silently.

## 4. Missing from the repository (provenance gaps)

| Missing piece | Consequence |
| --- | --- |
| `PonsV2FeeEscrow` source (deployed at `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e`) | The fee escrow that holds protocol+creator revenue has no published source. Only the `IPonsV2FeeEscrow` interface exists here. |
| `PonsV2LaunchAndBuy` router source (deployed at `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948`) | The atomic launch-and-buy router (documented in `pons-beta.md`, discussed in upstream issue #26 as "deleted rather than renamed") is absent. |
| V2 deployment metadata (solc/settings for the live V2 factory) | Byte-exact rebuild of the deployed stack is impossible; the Hackerbane audit reports the live factory was compiled with solc 0.8.35. |
| LICENSE file at repository root | README §License asserts MIT-for-first-party, but no root LICENSE exists for the fork to inherit. Forge should add one (MIT for first-party, with explicit third-party notices). |

## 5. Legal-review flags for a commercial fork

1. **BUSL-1.1 (`Pool.sol`, `Position.sol`)** linked into
   `PonsV2GraduationGuard`/hook build — review Uniswap's BUSL use grant,
   Change Date, and whether FINCO's modifications are permitted works.
2. **GPL-2.0-or-later** (`PonsTickMath.sol`) — V1 only; keep out of any
   proprietary tree, or obtain/replace it (V3 TickMath has MIT
   reimplementations).
3. **BaseHook.sol** — re-source from a verifiable upstream before
   production.
4. **First-party MIT** — usable commercially; preserve copyright/attribution
   notices. `PonsV2BondingCurveMath` notes adaptation from an MIT
   code4rena reference — attribution retained.

## Method note

Vendored-file comparison used `git hash-object` on each of the 68 vendored
`.sol` files against shallow clones of: OpenZeppelin v5.0.2 / v5.1.0 /
v5.5.0, Uniswap v4-core main, Uniswap v4-periphery main, Uniswap/permit2
master, and Uniswap v4-template. Result: **66/68 byte-identical** to their
matching upstream; 4 OZ/periphery files match newer upstream revisions
(additive/comment-level); 1 file (BaseHook.sol) has no verifiable public
upstream. Clones were made 2026-10-08.
