# License & Source-Provenance Inventory

Per-file/per-component license and provenance inventory of every source
tree in this repository. Originally produced by Workflow 01 (2026-10-08);
**reconciled and corrected by Correction A (2026-10-08)** — the earlier
revision understated the vendor file counts (68/70 vs the true 89) and
characterized the non-identical OZ files imprecisely. This revision is
generated from the full classification in `scripts/vendor-pins.tsv`, which
CI verifies on every run.

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
combination. Root-level notices: [`LICENSE`](../LICENSE) and
[`NOTICE`](../NOTICE).

## 2. Vendored dependency ledger (exact, mutually exclusive categories)

Every tracked vendored Solidity file carries a pin row in
`scripts/vendor-pins.tsv`; `scripts/check-vendored-deps.sh` re-verifies
each row against the pinned upstream reference on every CI run and fails on
any drift, new file, or deleted file.

**Tracked vendor `.sol` files: 89** (V1 lib: 18, V2 lib: 71; forge-std is a
separate submodule, not counted). Mutually exclusive categories:

| Category | V1 | V2 | Total | Meaning |
| --- | --- | --- | --- | --- |
| `BYTE_IDENTICAL` | 3 | 69 | **72** | `git hash-object` equals the pinned upstream reference |
| `WHITESPACE_ONLY` | 15 | 1 | **16** | differs from the pinned upstream reference by whitespace only (`diff -w` clean — semantically identical) |
| `UNRESOLVED` | 0 | 1 | **1** | no public upstream located (`BaseHook.sol`); content hash pinned |
| **Total** | **18** | **71** | **89** | |

Non-Solidity vendor files (not code, listed for completeness): 5 —
`toto.jpg`, `toto.md`, `truth.md` (V1 lib), `oz.jpg`, `ozz.md` (V2 lib) —
all easter-egg/narrative content, no code impact. forge-std is a submodule
pinned at `f3dae6e6ee381f25eb6a246f7da9b85c91a68219` (v1.17.0, test-only).

### 2.1 OpenZeppelin Contracts — 38 files (V1 18, V2 20) — MIT

- **Byte-identical (22):** to released revisions — v5.0.2 (6), v5.1.0 (6),
  v5.5.0 (8), v5.6.0 (2).
- **Whitespace-only (16):** to v5.0.2 (2), v5.1.0 (3), v5.5.0 (7), v5.6.0
  (2), and master commit `dab8611521b481c8801ef7811eec5f9661869ce1` (2).
  These are formatter-normalized copies of exact upstream revisions;
  `diff -w` against the pinned revision is empty.
- **`SafeERC20.sol` (both generations) — provenance note:** the vendored
  content includes upstream's `tryGetDecimals` helper, which exists in **no
  OpenZeppelin release** (v5.5.0–v5.7.0 and main all differ). Blob-history
  search proved it byte-identical (V2) / whitespace-identical (V1) to
  OpenZeppelin **master commit `dab86115`** ("Use IERC20 as input type in
  tryGetDecimals (#6486)", 2026-04-23) — an authentic mid-release upstream
  revision, **not a PONS modification**. (Correction A supersedes the
  earlier "v5.6.0-era additive revision" characterization.)
- Upstream commits referenced: tags v5.0.2 / v5.1.0 / v5.5.0 / v5.6.0,
  master `dab86115`. **No behavioral modification detected in any vendored
  OZ file.**

### 2.2 Uniswap v4-core — 34 files (V2) — MIT except 2× BUSL-1.1

- **License:** MIT per-file **except `libraries/Pool.sol` and
  `libraries/Position.sol`, which carry `BUSL-1.1` upstream and here**.
  Verified: Uniswap v4-core ships those two files as BUSL-1.1 — the PONS
  copies are faithful; the BUSL originates with Uniswap.
- **Integrity:** 34/34 byte-identical to v4-core commit
  `46c6834698c48bc4a463a86d8420f4eb1d7f3b75` (2026-04-02).
- **Why it matters:** `PonsV2GraduationGuard` links
  `Pool.tickSpacingToMaxLiquidityPerTick`; FINCO's commercial fork would
  build on BUSL-1.1 source. Counsel must review Uniswap's BUSL use grant
  and Change Date before commercial use.

### 2.3 Uniswap v4-periphery — 14 files (V2) — MIT

- **13 files byte-identical** to commit `9969eec44cfdf07e24b41de47f40276a58401976`
  (2026-09-19).
- **`Actions.sol`** byte-identical to commit
  `363226d9e1e2180b67bf6857023dbaad751010c5` (2026-05-27, PR #476) — an
  exact earlier upstream revision carrying the `SUBSCRIBE`/`UNSUBSCRIBE`
  constants (pinned by blob-history search; the newer `9969eec` revision
  reworked the file).
- **No behavioral modification detected.**

### 2.4 Uniswap Permit2 interfaces — 2 files (V2) — MIT

Byte-identical to Uniswap/permit2 commit `cc56ad0f3439c502c246fc5cfcc3db92bb8b7219`
(2023-09-29). Interfaces only; the deployed Permit2
(`0x000000000022D473030F116dDEE9F6B43aC78BA3`) is canonical, verified on
chain 4663.

### 2.5 `v4-hooks-public/BaseHook.sol` — 1 file — **UNRESOLVED**

MIT SPDX header; content matches the canonical Uniswap BaseHook pattern
(IHooks + ImmutableState, `HookNotImplemented`, address-flag validation)
and no behavioral modification is apparent from reading, but **no upstream
repository or commit matches this file's content**. It is pinned to its
current content hash (`bd6e08e0…`) so any edit is detected, and provenance
must be established — or the file replaced from a verifiable source —
before production (docs/ROADMAP.md G3).

### 2.6 forge-std — submodule — MIT OR Apache-2.0 (test-only)

Pinned at `f3dae6e6ee381f25eb6a246f7da9b85c91a68219` (v1.17.0). Never
compiled into production artifacts; excluded from the 89-file count.

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
| Root LICENSE / NOTICE before Correction A | Addressed by this correction: `LICENSE` (MIT for Forge additions + upstream first-party MIT attribution, with explicit third-party carve-outs) and `NOTICE` (per-component third-party notices incl. BUSL/GPL). Third-party BUSL/GPL components are **not** blanket-licensed as MIT. |

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

## Method note (Correction A)

Classification method, 2026-10-08:

1. Enumerate tracked vendor files: `git ls-files contractsV1/lib
   contractsV2/lib`, filtered to `.sol` → 89 files. (forge-std is a
   submodule; its files are not part of this repository's tree.)
2. Compare each file's `git hash-object` blob against pinned upstream
   references: shallow clones of OpenZeppelin tags v5.0.2, v5.1.0, v5.5.0,
   v5.6.0 (plus v5.6.1/v5.7.0 checked for SafeERC20), Uniswap v4-core
   `46c68346`, v4-periphery `9969eec`, Uniswap/permit2 `cc56ad0`.
3. Files matching no release were searched against the **full upstream
   object database / commit history** (`git log --all --find-object`,
   `cat-file --batch-all-objects`) to distinguish "authentic mid-release
   upstream revision" (pin to the exact commit) from "modified"
   (no upstream blob exists).
4. Byte-different-but-semantically-identical files were characterized with
   `diff -w`; every OZ file classified `WHITESPACE_ONLY` has an empty
   `diff -w` against its pinned reference.
5. Result: 72 BYTE_IDENTICAL + 16 WHITESPACE_ONLY + 1 UNRESOLVED = 89.
   Zero unexplained modifications in any vendored file.
