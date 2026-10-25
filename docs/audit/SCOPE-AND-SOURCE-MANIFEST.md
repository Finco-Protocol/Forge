# 1. Scope and source manifest

Status flags (unchanged, do not read this dossier as lifting any of them): `PRODUCTION_BLOCKED=true`, `FINCO_BURN_ENABLED=false`, `FORGE_FEE_POLICY_AUTHORITY_UNPROVEN=true`, `PRODUCTION_SIGNING_ENABLED=false`, `REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED=false`, `DEPLOY_WRITE_ENABLED=false`. Nothing in this repository is deployed by Forge; no Forge contract exists on Robinhood Chain (chain id 4663).

This is preparation material for a **future** independent audit. It is not an audit, an approval, or a statement of readiness.

## 1.1 Audited commit

| Item | Value |
| --- | --- |
| Baseline commit | `f4fa5e8a02f77958a0552ccaa411f3f1b39b5c1f` (`origin/main`, merge of PR #5; parents `96d5bea5…` and `b1389264…`, per `docs/W06-GAP-MATRIX.md`) |
| Upstream fork point | `ponsdotdev/pons-labs` `18da08d944ee4bed41d43dada3f4c29f5f524e57` (`FORK_PROVENANCE.md`) |
| Build profile that defines the Forge stack | `foundry.toml` `[profile.forge]`: solc 0.8.35, optimizer on, 200 runs, `via_ir = true`, `evm_version = "cancun"`, `bytecode_hash = "ipfs"`, `cbor_metadata = true`, `src = contractsV2-forge/src`, `libs = [contractsV2-deployed/lib]` |
| Deploy-time baseline profile | `[profile.deployed]` over `contractsV2-deployed`, identical compiler settings (the settings of the live PONS V2 deployment, per `docs/W02-SOURCE-RECOVERY.md`) |

The manifest is bound to that commit by a **one-time verification, not by the generator**: all 156 entries were checked against `git show f4fa5e8a…:<path> | sha256sum` when this dossier was prepared (156/156 identical). The 157th file, `test-forge/W06FinancialAcceptance.t.sol` (+279 lines), was added by W06 itself (a test, no production source); the other 156 are byte-identical to the baseline commit. A later commit that adds or edits a Solidity file under an audit root will make `--check` fail until the manifest is regenerated and re-reviewed; that is intended. Limitation (reported by review, accepted): `--check` compares the working tree with the committed manifest, not with `BASELINE_COMMIT`; if a baseline file were edited and the manifest regenerated, `--check` would pass. Reviewers must therefore compare the manifest hashes with `git show f4fa5e8a…:<path>` (REPRODUCTION step 5) rather than rely on `--check` alone.

## 1.2 The generated manifest

- File: `docs/audit/source-manifest.json` (sorted by path in byte order, no timestamps, sha256 of raw bytes, line counts).
- Generator: `scripts/w06/audit-manifest.ts`
  - `tsx scripts/w06/audit-manifest.ts` writes the file.
  - `tsx scripts/w06/audit-manifest.ts --check` regenerates in memory and exits 1 on any drift, listing added/changed/removed paths.
- Unit test: `apps/forge-web/test/unit/w06-audit-manifest.test.ts` (determinism, classification rules, sort/unique/no-timestamp invariants, the PONS/Forge boundary, the BUSL-1.1 flag, drift against the committed file).
- Line count definition: number of LF-terminated lines, plus one if the file does not end in LF.
- Enumeration: `git ls-files` under the audit roots, `*.sol` only. Untracked files are never listed.

### Totals (from the manifest)

| Class | Files | Lines |
| --- | ---: | ---: |
| `forge-owned` | 5 | 1591 |
| `pons-vendored-modified` | 1 | 1573 |
| `pons-vendored` | 29 | 8678 |
| `third-party-vendored` | 88 | 9996 |
| `test` | 19 | 6810 |
| `mock` | 14 | 1319 |
| `script` | 1 | 143 |
| **All** | **157** | **30110** |

## 1.3 Classification (how each class is decided)

| Class | Rule | Basis |
| --- | --- | --- |
| `forge-owned` | `contractsV2-forge/src/v2/forge/**` | Additive Forge contracts: `docs/MODIFICATION-REGISTER.md` sections 3, 8, 9 |
| `pons-vendored-modified` | `contractsV2-forge/src/v2/PonsV2LaunchFactory.sol` | The deploy-time PONS factory plus the M-ELIG change (register sections 2 and 7). The only PONS-derived file in the Forge tree that differs from `contractsV2-deployed` |
| `pons-vendored` | the rest of `contractsV2-forge/src/**`, and `contractsV2-deployed/src/**` | Deploy-time PONS V2 source recovered from Sourcify. For the Forge tree each file carries `deployedCounterpart`; the manifest records `identical` for all 14 of them (checked by byte comparison of sha256) |
| `third-party-vendored` | `contractsV2-deployed/lib/**` | OpenZeppelin, Uniswap v4-core, v4-periphery, Permit2 interfaces, `BaseHook.sol` |
| `test`, `mock`, `script` | `test-forge/**`, `test/**` (mocks under `*/mocks/`), `script/**` | Foundry harness and local deployment script |

Two classes you may expect but will not find: there is no "Forge-modified third-party" class (nothing vendored was edited; see `PROVENANCE-AND-LICENSING.md`) and no "deployed on chain by Forge" class (nothing is).

## 1.4 In scope, out of scope

**In scope for review** (priority order): `contractsV2-forge/src/v2/forge/*` (5 files), `contractsV2-forge/src/v2/PonsV2LaunchFactory.sol` (the M-ELIG diff versus deploy-time is 49 diff lines, see `PROVENANCE-AND-LICENSING.md` 2.2), the unmodified PONS contracts as they interact with the Forge additions (hook, escrow, vault, curve, executor, locker, deployer, guard), then the vendored libraries as compiled.

**Present in the Forge tree but not part of any deployment plan or authority matrix:** `PonsV2LaunchAndBuy.sol` (see `KNOWN-DISCREPANCIES.md` D11).

**Excluded from the manifest on purpose** (tracked `.sol` counts are in the JSON `excludedRoots`):

| Root | Tracked `.sol` | Why excluded |
| --- | ---: | --- |
| `contractsV1/` | 23 | V1 legacy engine; not the Forge candidate; builds only under `[profile.v1]` |
| `contractsV2/` | 86 | Upstream PONS V2 git HEAD. It does **not** compile as a whole (F-01; the default profile is a deliberate canary classified by `scripts/canary-classify.sh`), and it is superseded by the recovered deploy-time tree. Its `lib/` backs the `default` and `testable` profiles only |
| `contractsV2/lib/forge-std` | n/a | Git submodule (not tracked content), pinned to `f3dae6e6ee381f25eb6a246f7da9b85c91a68219` (v1.17.0), test-only. In this worktree the submodule directory is empty until `git submodule update --init` |

Off-chain code (`apps/forge-web`) is **not** part of the Solidity manifest. It is relevant to a contract auditor in three places only: EIP-712 parity (`apps/forge-web/src/shared/forge-typed-data.ts`, `src/server/finance/attestor.ts`), the attestor's eligible-revenue recomputation (`src/server/finance/ledger*.ts`), and signer custody (`src/server/signer/*`). See `THREAT-MODEL.md`.

## 1.5 Files

### Forge tree: `contractsV2-forge/src` (the stack the `forge` profile builds)

| File | Lines | sha256 (full, from manifest) | SPDX |
| --- | ---: | --- | --- |
| `contractsV2-forge/src/v2/PonsV2BondingCurve.sol` | 872 | `9e19cebed3b4ac659b9e3406fe3f8139ff8d59eb1da6e76bd9cbab915cd12684` | MIT |
| `contractsV2-forge/src/v2/PonsV2BuybackVault.sol` | 357 | `4f7dbac2094a0482796ef732ee3b1d75b472fff45aa98c803b72028a022bab76` | MIT |
| `contractsV2-forge/src/v2/PonsV2FeeEscrow.sol` | 148 | `dafb50350e0ee423e4bb57feda1af82a3bb388e76b2315788959e6ec429eea31` | MIT |
| `contractsV2-forge/src/v2/PonsV2GraduationExecutor.sol` | 209 | `c9d9a2585fd5dfb6afbce051a7966388ee304fc19e102593f413250e1be8ee75` | MIT |
| `contractsV2-forge/src/v2/PonsV2GraduationGuard.sol` | 125 | `d8f622ab113fd6d4319f09d6e053523bf6cd2a5dd2341446825edb05be60aaa2` | MIT |
| `contractsV2-forge/src/v2/PonsV2LaunchAndBuy.sol` | 222 | `24cefae1063a33d0c5027b116e317f98a0f3c4416ef3b6a1ea5a72170cfc86d3` | MIT |
| `contractsV2-forge/src/v2/PonsV2LaunchDeployer.sol` | 210 | `4d87005e44e9f377e3199b3c289511ac3017ab3dffe9e146d7fd5d403a387825` | MIT |
| `contractsV2-forge/src/v2/PonsV2LaunchFactory.sol` | 1573 | `5d407d8b146002c0a8dc63cc777cd6088c83ddbb95e8125eba29e41de11f898f` | MIT |
| `contractsV2-forge/src/v2/PonsV2LaunchLocker.sol` | 123 | `a3a105b93193d7de1a7194e9d05c0e66007b718f8b1a321cd25b86d523b371d9` | MIT |
| `contractsV2-forge/src/v2/PonsV2LauncherToken.sol` | 106 | `f3642bd24ecbcd902d7a09e9fa91100b0ac93723f0bfa41b66241c091b094c3e` | MIT |
| `contractsV2-forge/src/v2/forge/ForgeBindingRegistry.sol` | 322 | `098b1d961f570643a5b5c704850acddbdffa8d46dc8de8a12e7e61dfaa41109b` | MIT |
| `contractsV2-forge/src/v2/forge/ForgeLaunchAuthorizer.sol` | 458 | `aefea65156cb86454a1b18cef82fbb905148ef9e8abc5a5631e34554fc3387a3` | MIT |
| `contractsV2-forge/src/v2/forge/ForgeProtocolRevenueSplitter.sol` | 685 | `c2da7457717ed22dbb17469f424af783dc564d9a5d392dc8ffadcf33af19c92b` | MIT |
| `contractsV2-forge/src/v2/forge/IFincoBurnReserveExecutor.sol` | 33 | `f9ffa31943c7e2e066813fe8ef80a8675df2e0b27cf9cfa962e5d6529127afeb` | MIT |
| `contractsV2-forge/src/v2/forge/IForgeLaunchAuthorizer.sol` | 93 | `d22fcb604b74829535689bcf5dbb799fd18e873c4982561f4ab0166d84fa2d58` | MIT |
| `contractsV2-forge/src/v2/hooks/PonsV2MemeHook.sol` | 887 | `07c4a6adcf20272729a32802c7b856fda994b0b791b1593220e4ba7a5d3f2cc5` | MIT |
| `contractsV2-forge/src/v2/interfaces/ILaunchpadV2.sol` | 154 | `65f1dbd93808dedfd77c4a1f5e03ccd2e1b0a14e96d6265fadd60d6cea202f08` | MIT |
| `contractsV2-forge/src/v2/interfaces/ILaunchpadV2Graduation.sol` | 12 | `52e366d698eee7810321c92d8bdfa584caea0a6252afecb988edce5e0b96635a` | MIT |
| `contractsV2-forge/src/v2/libraries/PonsV2BondingCurveMath.sol` | 88 | `e4486d95391daf7b3925219766307d3c7c78db80304bd824241f379146e59e58` | MIT |
| `contractsV2-forge/src/v2/libraries/PonsV2GraduationMath.sol` | 63 | `f4b1f3f590817d82701f1001ba4e5df486cdd698e89adcab787dff6e1607839e` | MIT |

### Deploy-time baseline: `contractsV2-deployed/src` (Sourcify-recovered PONS V2)

| File | Lines | sha256 (full, from manifest) | SPDX |
| --- | ---: | --- | --- |
| `contractsV2-deployed/src/v2/PonsV2BondingCurve.sol` | 872 | `9e19cebed3b4ac659b9e3406fe3f8139ff8d59eb1da6e76bd9cbab915cd12684` | MIT |
| `contractsV2-deployed/src/v2/PonsV2BuybackVault.sol` | 357 | `4f7dbac2094a0482796ef732ee3b1d75b472fff45aa98c803b72028a022bab76` | MIT |
| `contractsV2-deployed/src/v2/PonsV2FeeEscrow.sol` | 148 | `dafb50350e0ee423e4bb57feda1af82a3bb388e76b2315788959e6ec429eea31` | MIT |
| `contractsV2-deployed/src/v2/PonsV2GraduationExecutor.sol` | 209 | `c9d9a2585fd5dfb6afbce051a7966388ee304fc19e102593f413250e1be8ee75` | MIT |
| `contractsV2-deployed/src/v2/PonsV2GraduationGuard.sol` | 125 | `d8f622ab113fd6d4319f09d6e053523bf6cd2a5dd2341446825edb05be60aaa2` | MIT |
| `contractsV2-deployed/src/v2/PonsV2LaunchAndBuy.sol` | 222 | `24cefae1063a33d0c5027b116e317f98a0f3c4416ef3b6a1ea5a72170cfc86d3` | MIT |
| `contractsV2-deployed/src/v2/PonsV2LaunchDeployer.sol` | 210 | `4d87005e44e9f377e3199b3c289511ac3017ab3dffe9e146d7fd5d403a387825` | MIT |
| `contractsV2-deployed/src/v2/PonsV2LaunchFactory.sol` | 1526 | `3813f2ad7dcc9d10c5f2e448c898e4dc7d6f1d4858785fdf15e1b98a91c73259` | MIT |
| `contractsV2-deployed/src/v2/PonsV2LaunchLocker.sol` | 123 | `a3a105b93193d7de1a7194e9d05c0e66007b718f8b1a321cd25b86d523b371d9` | MIT |
| `contractsV2-deployed/src/v2/PonsV2LauncherToken.sol` | 106 | `f3642bd24ecbcd902d7a09e9fa91100b0ac93723f0bfa41b66241c091b094c3e` | MIT |
| `contractsV2-deployed/src/v2/hooks/PonsV2MemeHook.sol` | 887 | `07c4a6adcf20272729a32802c7b856fda994b0b791b1593220e4ba7a5d3f2cc5` | MIT |
| `contractsV2-deployed/src/v2/interfaces/ILaunchpadV2.sol` | 154 | `65f1dbd93808dedfd77c4a1f5e03ccd2e1b0a14e96d6265fadd60d6cea202f08` | MIT |
| `contractsV2-deployed/src/v2/interfaces/ILaunchpadV2Graduation.sol` | 12 | `52e366d698eee7810321c92d8bdfa584caea0a6252afecb988edce5e0b96635a` | MIT |
| `contractsV2-deployed/src/v2/libraries/PonsV2BondingCurveMath.sol` | 88 | `e4486d95391daf7b3925219766307d3c7c78db80304bd824241f379146e59e58` | MIT |
| `contractsV2-deployed/src/v2/libraries/PonsV2GraduationMath.sol` | 63 | `f4b1f3f590817d82701f1001ba4e5df486cdd698e89adcab787dff6e1607839e` | MIT |

### Vendored libraries compiled by profile `forge`: `contractsV2-deployed/lib`

| Package (contractsV2-deployed/lib/) | Files | Lines |
| --- | ---: | ---: |
| `openzeppelin-contracts` | 37 | 5337 |
| `v4-core` | 34 | 3699 |
| `v4-hooks-public` | 1 | 216 |
| `v4-periphery` | 16 | 744 |

Per-file hashes, line counts and SPDX tags for these 88 files are in the JSON only. Exactly two are not MIT: `v4-core/src/libraries/Pool.sol` and `v4-core/src/libraries/Position.sol` (BUSL-1.1).

### Tests and script

| File | Lines | sha256 (full, from manifest) | SPDX |
| --- | ---: | --- | --- |
| `script/DeployForgeW02.s.sol` | 143 | `bec8115f367947e60a37c72f48ed6d43938d04805f0fdb919197dfa1cf8acc64` | MIT |
| `test-forge/ForgeLaunchAuth.t.sol` | 813 | `96871c0863d32745b115d3f4485dd524810bdae37d20a98fca4764599cc8b606` | MIT |
| `test-forge/ForgeLaunchCall.t.sol` | 158 | `84696c0a5d60eb08c2dfee9ada9f3fd4ff2b41bad808b0f36a8143682ca31694` | MIT |
| `test-forge/ForgeLifecycle.t.sol` | 473 | `75839ddbb38d7b50c86d7dd7574d792257b2fb5427ca2c8ee4197e25d8d58154` | MIT |
| `test-forge/ForgeRevenueLifecycle.t.sol` | 615 | `8dc8609f8e60fd26d04bb9dcb9df6cab1331d9b6f50fc16d3a81f0143fbb811f` | MIT |
| `test-forge/ForgeRevenueSplitter.t.sol` | 1173 | `cca97aa83307330d94382333ace52fa79630860a1bd4ebb88ab80c40dd6becc8` | MIT |
| `test-forge/ForgeSnipeTax.t.sol` | 240 | `05744fac09b6befdde74d16db4acf8e2006b8032e921b64ae16d430fa6683254` | MIT |
| `test-forge/W05AttestorCompromise.t.sol` | 198 | `71274a0c3a0954cbfbf2467deb18bcc6163891a7b6b9a0bf51c2df1af775d7d0` | MIT |
| `test-forge/W05EmergencyRevocation.t.sol` | 285 | `6815ac692dfd0d93c682c15fb5a71616d68b79dd448e1e4be4e3ae1ebdbd8a30` | MIT |
| `test-forge/W05OwnerPowers.t.sol` | 375 | `c4c5d844eb3c1ea96c39e21677acff792fe9ce49d64cc3e69260231aa4465e20` | MIT |
| `test-forge/W06FinancialAcceptance.t.sol` | 279 | `dc867a17547e718c2d3da5dc06d8c37ae98ab2646523abeaffe4cd38ee84f55e` | MIT |
| `test/CurveInvariants.t.sol` | 175 | `2dc49a9cec6e5c0ad0600c36cb27de3483f02f56ede9ce57f0b7ccb252104706` | MIT |
| `test/PonsV2BondingCurve.t.sol` | 660 | `ad131cb6ddc8d9db9a2fff9ac5fa2fadb7bda949e734c8f667a151baf4e1d781` | MIT |
| `test/PonsV2BuybackVault.t.sol` | 222 | `e5390e5289ace6059993eb5ef83a10d85378dd8195759eb218b4547d5fa9b062` | MIT |
| `test/PonsV2GraduationGuard.t.sol` | 58 | `f8ddd50ba89454e7681000472a0b1ef8333ebda327a6adb8c3cdd90acd53606b` | MIT |
| `test/PonsV2LaunchLocker.t.sol` | 116 | `8a1b053159ff3e6c10c02f26ba963894879bcbf6e948a64d56be31675d7d6a4d` | MIT |
| `test/PonsV2LauncherToken.t.sol` | 98 | `9be0fb07bdee3a7c2ba5c1a1d95bf5c70d02d3320bc641d8458425f786ae2905` | MIT |
| `test/PonsV2MemeHook.t.sol` | 565 | `19f467a13de57b92ebaa546f2228e8418d8b4eadce75074054a380a60344b4ef` | MIT |
| `test/libraries/PonsV2BondingCurveMath.t.sol` | 110 | `26067ff9d745c72bfd1e60202d893657243ca7f811d799eb528541df3852c83d` | MIT |
| `test/libraries/PonsV2GraduationMath.t.sol` | 101 | `1e4c29b3c14e98d64d886dd18b65eb58188d8498d2917a9c72015266b261aba6` | MIT |

### Mocks (test-only; never part of a deployable stack)

| File | Lines | sha256 (full, from manifest) | SPDX |
| --- | ---: | --- | --- |
| `test-forge/mocks/FeeOnTransferToken.sol` | 28 | `06068804374f4017fe47155d2a78b88d133c601e44c7113eb7758e75933c8a79` | MIT |
| `test-forge/mocks/ForgeTestToken.sol` | 14 | `91b3b4f0f6a2293922a2703af9ccb6edb9cdb55cac230aba694fe5201a8a267c` | MIT |
| `test-forge/mocks/HookDeployer.sol` | 17 | `c2ea64f8c4b4277834f1ea7a2aad4b61a23df13170313b6d2efb654632298aa9` | MIT |
| `test-forge/mocks/MiniPoolManager.sol` | 237 | `aa268a82f46658c5c665d6cae8c6e9536a93439d3cee59f1db8d3153fa69f0d6` | MIT |
| `test-forge/mocks/MiniPoolManagerW02.sol` | 51 | `c0cfa2698accae57b2577a06212f50e576fe0abcc99ec1c2a81784b751d40b78` | MIT |
| `test-forge/mocks/MiniPositionManager.sol` | 156 | `9b43205b95c96344a6fd55e023dfd29cbf5c16529dcc0a63ab67200356ba73b4` | MIT |
| `test-forge/mocks/MockFeeEscrow.sol` | 182 | `612b115e96efba98d6240e17898e120fb9c26696a08310003d59b5c3c0758c2e` | MIT |
| `test-forge/mocks/MockPermit2.sol` | 37 | `632df9f26f7e6e05e12b3afbee138c8367341ccc21e5f00d9ca1bc3bf461dbc1` | MIT |
| `test-forge/mocks/MockQuotePolicyFactory.sol` | 43 | `0e731488e03fcaf6376717419f78a8ff194d2b5518f106beef0d893682f6f8bf` | MIT |
| `test-forge/mocks/SandboxSwapRouter.sol` | 71 | `06d197ea6f84ef4f00691c8a28ca74938d4c0375edb03ad2fdc01988e17e46b8` | MIT |
| `test/mocks/HookDeployer.sol` | 17 | `c2ea64f8c4b4277834f1ea7a2aad4b61a23df13170313b6d2efb654632298aa9` | MIT |
| `test/mocks/MiniPoolManager.sol` | 237 | `aa268a82f46658c5c665d6cae8c6e9536a93439d3cee59f1db8d3153fa69f0d6` | MIT |
| `test/mocks/MockERC20.sol` | 47 | `b8806a173d7f4d919d9f00ddf89a4d90ca49a5288eb68ce697ccc1e2d3eb30dc` | MIT |
| `test/mocks/MockFeeEscrow.sol` | 182 | `62fc80269e3a1bcfd4a574e32cd3eb5bda35a912d8aa73eb60264de71ad0b635` | MIT |
