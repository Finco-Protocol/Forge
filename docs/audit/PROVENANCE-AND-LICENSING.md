# 2. Provenance and licensing

Everything below was re-derived from source and committed evidence at `f4fa5e8a02f77958a0552ccaa411f3f1b39b5c1f`. Where an older document disagrees with the source, the source wins and the disagreement is listed in `KNOWN-DISCREPANCIES.md`. Evidence tags: **SOURCE** = read in the tracked files; **RAN** = a command executed while preparing this dossier; **DOC** = stated by a repository document and not re-verified here.

## 2.1 Lineage

```
ponsdotdev/pons-labs @ 18da08d9…           upstream (MIT headers, Pons Labs, LLC)
   │  GitHub-native fork, 0 ahead / 0 behind at fork time          (FORK_PROVENANCE.md, DOC)
   ▼
Finco-Protocol/Forge
   ├─ contractsV1/, contractsV2/          upstream trees, retained unmodified (NOTICE, DOC;
   │                                      V2 HEAD does not compile: finding F-01)
   ├─ contractsV2-deployed/               deploy-time PONS V2 source recovered from Sourcify
   │                                      (W02; docs/W02-SOURCE-RECOVERY.md)
   └─ contractsV2-forge/                  Forge-owned stack = deployed tree + M-ELIG factory change
                                          + 5 additive Forge contracts
```

Why three V2 trees exist: the upstream git HEAD (`contractsV2/`) references `PonsV2BondingCurve.exemptFromSnipeTax` and a `LaunchDeployment.salt` field that do not exist in that tree, and its deployer uses plain `new` where the live system uses CREATE2 (F-01/F-02, `docs/SECURITY-REVIEW.md`, `docs/BUILD.md`). The live, working PONS V2 source was therefore recovered from Sourcify verification records into `contractsV2-deployed/` and byte-compared with on-chain code. The deploy-time tree carries pre-rename naming from a "RobinFunFi V2" codebase (e.g. the locker's Sourcify input); this is lineage evidence, not a defect (`docs/W02-SOURCE-RECOVERY.md`, risk W02-R4).

## 2.2 What Forge changed (verified against source)

### Zero divergence from the deploy-time tree (SOURCE, RAN)

`cmp` of every file under `contractsV2-deployed/src/v2/` against `contractsV2-forge/src/v2/` at this SHA: **identical for 14 of 15 files**, i.e. the curve, deployer, token, executor, guard, locker, vault, escrow, router (`PonsV2LaunchAndBuy`), hook, both interfaces and both libraries. The manifest records this per file as `deployedCounterpart: "identical"`. `docs/MODIFICATION-REGISTER.md` section 1 makes the same claim; it holds.

### The one modified PONS file: `PonsV2LaunchFactory.sol` (M-ELIG)

`diff contractsV2-deployed/src/v2/PonsV2LaunchFactory.sol contractsV2-forge/src/v2/PonsV2LaunchFactory.sol` reports 49 changed diff lines (1 removed, 48 added); the file grows from 1526 to 1573 lines. Elements, in file order:

1. `import {IForgeLaunchAuthorizer}`.
2. A **comment-only** edit: a line that read `//` now reads `//(` inside the `TokenParams.salt` natspec. It has no effect on bytecode semantics but is not described in the register (KNOWN-DISCREPANCIES D4).
3. Five new `TokenParams` fields appended: `uint64 githubRepoId`, `uint64 authorizationExpiresAt`, `uint64 authorizationNonce`, `bytes creatorSignature`, `bytes attestationPayload`.
4. `IForgeLaunchAuthorizer public immutable launchAuthorizer`, a new constructor parameter (9th of 10, before `initialLaunchFee`), a `ZeroAddress` check and the assignment.
5. Explanatory comments at the two exemption entry points (no code change).
6. In the private `_launchToken`, after the effective `creatorFeeRecipient` is resolved and before `launchDeployer.deployLaunch`:
   `launchAuthorizer.requireAuthorizedLaunchCall(msg.data, originalDeployer, economics);`

All three public launch entry points (`launchToken` x2 overloads, `launchTokenFor`) funnel through `_launchToken`, so the call sits below every entry. The W03 size remediation (register section 7) moved intent assembly out of the factory into the authorizer, which is why the diff is small. The authorizer address is `immutable`; governance can rotate the signing **key inside** the authorizer, not remove the check from the factory. See `PRIVILEGED-AUTHORITIES.md` for the consequence of that rotation power.

Not changed in the factory: `canLaunch` gating (still evaluated first, so `launchEnabled`/whitelist must also permit the call), fee maths, curve snapshotting, F-03/F-04 owner functions.

### Additive Forge contracts (SOURCE)

| File | Lines | Role |
| --- | ---: | --- |
| `forge/IForgeLaunchAuthorizer.sol` | 93 | M-ELIG interface (`LaunchIntent`, `requireAuthorizedLaunch`, `requireAuthorizedLaunchCall`, nonce view) |
| `forge/ForgeLaunchAuthorizer.sol` | 458 | Verifier: creator-consent + eligibility-attestation EIP-712 signatures, per-creator nonce, one-time factory wiring, authority rotation / kill switch |
| `forge/ForgeBindingRegistry.sol` | 322 | Repo-id -> creator binding ledger, hash-chained operation log, binding epoch, `invalidatePendingOps` barrier |
| `forge/ForgeProtocolRevenueSplitter.sol` | 685 | Escrow key the hook's `protocolFeeRecipient` names; 2:1 treasury:reserve allocation of **attested** eligible revenue |
| `forge/IFincoBurnReserveExecutor.sol` | 33 | Interface only; not implemented or referenced. `FINCO_BURN_ENABLED` is a `constant false` in the splitter |

### Vendored additions (SOURCE, RAN)

The authorizer/registry need OpenZeppelin cryptography and ERC-721 files that the deploy-time package did not contain. `provenance/forge-additions.txt` hash-pins **14** files under `contractsV2-deployed/lib/openzeppelin-contracts/contracts/` (`ECDSA`, `EIP712`, `MessageHashUtils`, `ShortStrings`, `Strings`, `Address`, `Multicall`, `SignedMath`, `ERC165`, `IERC5267`, `IERC1967`, `ERC721`, `IERC721Receiver`, `IERC721Metadata`). `bash provenance/tree-integrity-gate.sh .` returned `TREE_INTEGRITY_OK (103 sources verified across 8 compile sets + 14 allowlisted additions)` when run for this dossier (RAN).

### Build configuration

`foundry.toml` profiles `deployed` and `forge` (section 1 of `SCOPE-AND-SOURCE-MANIFEST.md`). The W01 profiles `default` (canary, expected to fail), `testable` and `v1` are unchanged.

### Script

`script/DeployForgeW02.s.sol`: local/test deployment using W02 mini V4 mocks; explicitly never pointed at chain 4663. It does not deploy the splitter. The production-shaped sequence (including the splitter and CREATE2 hook mining) is `apps/forge-web/scripts/w05/deploy-plan-lib.ts`, which is dry-run only (`DEPLOY_WRITE_ENABLED=false`).

## 2.3 Deploy-time parity evidence (what is and is not proven)

`provenance/<Contract>/` holds, per contract: `evidence.json` (address, Sourcify match id/tier, deploy tx), the live `onchain-runtime.hex`, `std-json-input.json`, and CI-regenerated `recompiled-runtime.hex` and `verify-result.txt`. `provenance/verify-parity.sh` recompiles with solc `0.8.35+commit.47b9dedd` (checksum-pinned) and classifies `EXACT` or `IMMUTABLE_PATCHED`; any other difference fails. **This script was not re-run for this dossier** (it fetches a pinned compiler binary); the committed `verify-result.txt` values below are DOC-level for this dossier, with the gate itself exercised in CI by `.github/workflows/w02.yml`.

| Contract | Address (chain 4663) | Sourcify tier | `verify-result.txt` |
| --- | --- | --- | --- |
| `PonsV2LaunchFactory` | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` | exact_match | RUNTIME-PARITY-PROVEN (114 immutable spans, 24,124 code bytes + 53 B metadata tail = 24,177 B) |
| `PonsV2LaunchDeployer` | `0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42` | exact_match | RUNTIME-PARITY-PROVEN |
| `PonsV2LaunchAndBuy` | `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948` | exact_match | RUNTIME-PARITY-PROVEN |
| `PonsV2MemeHook` | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` | match | RUNTIME-PARITY-PROVEN (69 spans) |
| `PonsV2FeeEscrow` | `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e` | match | RUNTIME-PARITY-PROVEN (0 spans) |
| `PonsV2BuybackVault` | `0x42df2a798f82289E177311362e8f5ccC45c1219c` | match | RUNTIME-PARITY-PROVEN |
| `PonsV2LaunchLocker` | `0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952` | match | RUNTIME-PARITY-PROVEN (std-json kept as `.local`, excluded from the tree-integrity union: the Sourcify input retains pre-rename naming; same bytecode verified through the factory compile set) |
| `PonsV2GraduationExecutor` | `0xC7819B64A1dAECD7eC19856d026cb14EfBd89046` | match | RUNTIME-PARITY-PROVEN |
| `PonsV2GraduationGuard` | `0xf5695117b99B6f6401e67d4195BD653628176C6C` | transitive | RUNTIME-PARITY-PROVEN (source rides in the factory compile set; no standalone Sourcify record) |
| `PonsV2LauncherToken` | none (per-launch CREATE2) | n/a | `SOURCE_PROVEN_ONLY`: **not** runtime-parity-proven |
| `PonsV2BondingCurve` | none (per-launch CREATE2) | n/a | no `provenance/` entry; its source is inside the deployer's creation code and the factory compile set |

Limits an auditor must keep in mind:

- Parity is a statement about **`contractsV2-deployed/`** versus the **original PONS deployment**. The Forge factory is intentionally different bytecode and has **no** on-chain counterpart; the other 14 Forge-tree files are source-identical to the deployed tree, but a Forge deployment would be a *new* deployment of them, built by the `forge` profile.
- The `forge` profile uses the same solc/optimizer/via-IR/cancun/ipfs settings as the deploy-time build, but no bytecode parity is claimed for it (`docs/MODIFICATION-REGISTER.md` section 7).
- `docs/W05-AUTHORITY-MATRIX.md` says "Source parity with the deploy-time PONS tree is proven by `provenance/verify-parity.sh`" for the Forge stack. Read that as: parity of the unmodified PONS contracts' *source*, with the factory the single exception (KNOWN-DISCREPANCIES D7).

## 2.4 Licensing

Sources: root `LICENSE`, `NOTICE`, `docs/LICENSE-INVENTORY.md`, SPDX headers (SOURCE), the `spdx` field of `source-manifest.json` (RAN).

| Component | License | Notes |
| --- | --- | --- |
| PONS V2 first-party Solidity (`contractsV2-deployed/src`, 14 unmodified Forge-tree files, the factory) | MIT (SPDX), (c) Pons Labs, LLC | `PonsV2BondingCurveMath.sol` is adapted from `BootstrapPool.sol` (code4n4, 2025-01-iq-ai contest code, MIT header retained, per LICENSE-INVENTORY) |
| Forge-owned additions (`contractsV2-forge/src/v2/forge/*`, tests, mocks, script) | MIT (every manifest entry other than the two BUSL-1.1 files carries `SPDX-License-Identifier: MIT`) | (c) FINCO Protocol |
| OpenZeppelin Contracts (37 files in `contractsV2-deployed/lib`) | MIT | Version mix; the Forge additions are pinned to the v5.0.0 headers the deploy-time package itself vendors |
| Uniswap v4-core (34 files) | MIT **except** `libraries/Pool.sol` and `libraries/Position.sol`: **BUSL-1.1** | Faithful copies; the BUSL originates with Uniswap |
| Uniswap v4-periphery + Permit2 interfaces (16 files) | MIT | |
| `v4-hooks-public/src/base/BaseHook.sol` | MIT header | **Upstream origin UNRESOLVED**: no public repository matched its content (NOTICE, LICENSE-INVENTORY). The copy in `contractsV2-deployed/lib` is byte-identical to the pinned one in `contractsV2/lib` (RAN: `cmp`) and is part of the Sourcify-verified deploy-time compile sets |
| `PonsTickMath.sol` | GPL-2.0-or-later | V1 only (`contractsV1/src`); outside the manifest and the Forge build path |
| forge-std | MIT OR Apache-2.0 | Test-only submodule, never compiled into a deployable artifact |

### BUSL-1.1 gate (open; legal review not done)

- Exactly two tracked Solidity files under the audit roots are not MIT, both BUSL-1.1: `contractsV2-deployed/lib/v4-core/src/libraries/Pool.sol` and `.../Position.sol` (manifest `spdx`, enforced by the unit test).
- They enter the Forge build because `PonsV2GraduationGuard.sol` imports `Pool` (`Pool.tickSpacingToMaxLiquidityPerTick`). `PonsV2GraduationGuard` is created inside the factory constructor (`graduationGuard = new PonsV2GraduationGuard()`).
- The BUSL use grant and Change Date are governed by the license text in those files and by Uniswap's terms. **No legal conclusion is drawn here.** Release items `C04_BUSL_LEGAL_REVIEW` (Class C, external approver) and finding `F-09` stay open in `release/readiness-items.json` / `release/security-findings.json`, and `release/approver-registry.json` is empty, so nothing can self-approve.
- The deployed Uniswap v4 PoolManager/PositionManager/Permit2 on chain 4663 are Uniswap's own deployments and are not redistributed here (`ROBINHOOD-CHAIN-RISKS.md`).

### Vendor-integrity ledger scope caveat

`scripts/vendor-pins.tsv` and `scripts/check-vendored-deps.sh` cover **89 files in `contractsV1/lib` and `contractsV2/lib`** (RAN: `DEPENDENCY_INTEGRITY_OK`; 72 byte-identical, 16 whitespace-only, 1 unresolved). The `forge` profile compiles `contractsV2-deployed/lib` (88 `.sol`), which is protected by a different mechanism: `provenance/tree-integrity-gate.sh` against the Sourcify compile sets plus `provenance/forge-additions.txt`. 71 of the 88 files are byte-identical to their counterparts in `contractsV2/lib` (RAN: `cmp`); the remaining 17 are the OpenZeppelin files above plus `Create2.sol`, `Errors.sol`, `LowLevelCall.sol`. The counts in `NOTICE` and `docs/LICENSE-INVENTORY.md` describe `contractsV2/lib`, not the compiled tree (KNOWN-DISCREPANCIES D6).
