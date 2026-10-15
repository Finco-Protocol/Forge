# 10. Reproduction

Commands are taken from `.github/workflows/{ci,w02,w03,w05,security-toolchain}.yml`, `foundry.toml` and `apps/forge-web/package.json`. Nothing here deploys, broadcasts or writes to a chain. Tool versions are those pinned by CI; the sandbox in which this dossier was prepared used Foundry at `/tmp/fdry` (forge 1.8.5), which is a path detail of that sandbox, not a requirement.

## 10.1 Toolchain

| Tool | Version (source) | Used for |
| --- | --- | --- |
| Foundry (forge, cast, anvil) | `v1.8.5` (`FOUNDRY_VERSION` in every workflow; `foundry-rs/foundry-toolchain`) | all Solidity builds and tests, the app's local chain |
| solc | `0.8.35` for profiles `forge` and `deployed` (exact: `0.8.35+commit.47b9dedd`, checksum-pinned in `provenance/verify-parity.sh`); `0.8.30` for `default`, `testable`, `v1` | Foundry downloads it on first build |
| Node.js | 22 (`NODE_VERSION`); `engines.node >= 22` | app, scripts |
| pnpm | `10.28.0` (`PNPM_VERSION`) | app dependencies (`apps/forge-web/pnpm-lock.yaml`, `--frozen-lockfile`) |
| PostgreSQL | 16 (service image pinned by digest in `w05.yml`) | `pnpm test:pg` only |
| Playwright | `@playwright/test 1.56.1`, Chromium | `pnpm test:e2e` |
| Slither / Aderyn / Semgrep | 0.11.6 / 0.6.8 / 1.181.0 (`security-toolchain.yml`) | scanners (not an audit) |
| gitleaks | 8.28.0 | secret scan (`w03.yml`) |

Foundry profile summary (`foundry.toml`): `forge` = solc 0.8.35, optimizer 200, via-IR, cancun, ipfs metadata, `src=contractsV2-forge/src`, `test=test-forge`, `out=out/forge`, `libs=[contractsV2-deployed/lib]`; invariant defaults `runs=64 depth=32`; fuzz `runs=256`.

## 10.2 Get the exact source

```bash
git clone https://github.com/Finco-Protocol/Forge.git && cd Forge
git checkout f4fa5e8a02f77958a0552ccaa411f3f1b39b5c1f
git submodule update --init --recursive      # forge-std v1.17.0 (f3dae6e6...), needed by test-forge/ and script/
```

Verify the source inventory (no network needed, `git` and Node required):

```bash
cd apps/forge-web && pnpm install --frozen-lockfile && cd ..
apps/forge-web/node_modules/.bin/tsx scripts/w06/audit-manifest.ts --check      # AUDIT_MANIFEST_OK files=157 lines=30009
# independent check of any file against the pinned commit:
git show f4fa5e8a02f77958a0552ccaa411f3f1b39b5c1f:contractsV2-forge/src/v2/forge/ForgeBindingRegistry.sol | sha256sum
```

If you build a later commit, expect `--check` to fail until the manifest is regenerated (`tsx scripts/w06/audit-manifest.ts`) and re-reviewed.

## 10.3 Foundry builds

```bash
forge build --profile forge        # the Forge-owned stack + tests; needed by the app tests (out/forge)
forge build --profile deployed     # the recovered deploy-time tree (parity baseline)
forge build --profile v1           # V1 generation (compiles; no tests)
forge build --profile testable     # upstream V2 minus the factory + W01 tests
forge build                        # CANARY: expected to FAIL (finding F-01). CI classifies it:
bash scripts/canary-classify.sh "$?" canary.log   # only CANARY_VERDICT=UPSTREAM_V2_FACTORY_BLOCKED is accepted
git checkout -q foundry.lock       # CI does this after profile builds that touch the lockfile
```

## 10.4 Foundry test suites (what CI selects, and the full set)

Run from the repository root.

| Suite (contract) | File | Command | CI job |
| --- | --- | --- | --- |
| W01 regression (curve, vault, hook, locker, token, math, invariants) | `test/` | `forge test --profile testable -vvv` | `ci.yml` build-and-test; `w02.yml` |
| M-ELIG authorization `ForgeLaunchAuthTest` | `test-forge/ForgeLaunchAuth.t.sol` | `forge test --profile forge --match-contract ForgeLaunchAuthTest -vvv` | `w02.yml` |
| Lifecycle + anti-snipe `ForgeLifecycleTest`, `ForgeSnipeTaxTest` | `ForgeLifecycle.t.sol`, `ForgeSnipeTax.t.sol` | `forge test --profile forge --match-contract "ForgeLifecycleTest\|ForgeSnipeTaxTest" -vvv` | `w02.yml` |
| Calldata authorization / EIP-170 `ForgeLaunchCallTest` | `ForgeLaunchCall.t.sol` | `forge test --profile forge --match-contract ForgeLaunchCallTest -vvv` | `w03.yml` |
| Revenue: splitter unit+fuzz, invariants, lifecycle | `ForgeRevenueSplitter.t.sol`, `ForgeRevenueLifecycle.t.sol` | `forge test --profile forge --match-contract "ForgeRevenueSplitterTest\|ForgeRevenueSplitterInvariantTest\|ForgeRevenueLifecycleTest" -vv` | `w03.yml`, `w05.yml` |
| Owner powers F-03/F-04, compromised attestor | `W05OwnerPowers.t.sol`, `W05AttestorCompromise.t.sol` | `forge test --profile forge --match-contract "W05OwnerPowersTest\|W05AttestorCompromiseTest" -vv` | `w05.yml` |
| Emergency attestor revocation `W05EmergencyRevocationTest` | `W05EmergencyRevocation.t.sol` | `forge test --profile forge --match-contract W05EmergencyRevocationTest -vv` | **none** (D9); run it explicitly |
| Everything in `test-forge/` | | `forge test --profile forge` | not run unfiltered by any workflow |

Note: `ForgeLaunchCallTest` inherits `ForgeLifecycleTest`, so selecting it also re-runs the 4 lifecycle tests.

## 10.5 Gates other than tests

```bash
bash scripts/check-vendored-deps.sh            # DEPENDENCY_INTEGRITY_OK  (contractsV1/lib + contractsV2/lib, 89 files)
bash provenance/tree-integrity-gate.sh .       # TREE_INTEGRITY_OK        (contractsV2-deployed, 103 sources)
bash provenance/verify-parity.sh               # recompile with solc 0.8.35 and byte-compare with on-chain runtime (fetches a pinned compiler)
bash scripts/test-parity-gate.sh               # negative tests: the parity gate must fail on tampering
bash scripts/test-vendor-checker.sh            # negative tests V1-V10
bash scripts/test-canary-classifier.sh         # negative tests A-G
bash scripts/test-lint-gate.sh ; bash scripts/test-security-lint-gate.sh
forge fmt --check test-forge
forge lint --profile forge test-forge --json    # see w02.yml for the strict parsers (perl scripts/check-*.pl)
```

## 10.6 App test projects (`apps/forge-web`)

```bash
cd apps/forge-web
pnpm install --frozen-lockfile
# repo root first: forge build --profile forge   (the app reads out/forge; then: git checkout -q foundry.lock)
pnpm typecheck && pnpm lint
pnpm test                    # vitest project "unit"   (includes test/unit/w06-audit-manifest.test.ts, w05-authority-matrix, w05-release-gate, ledger, signer, typed-data, ...)
pnpm abi:check               # committed ABIs match out/forge
pnpm size:check              # EIP-170 gate: every Forge runtime <= 24,576 B, factory margin >= 64 B
pnpm test:integration        # project "integration": real contracts on a standard Anvil, through the real API; serial
pnpm build && pnpm exec playwright install --with-deps chromium && pnpm test:e2e   # Playwright against the production build
pnpm test:v4                 # project "v4": genuine Uniswap v4 PoolManager/PositionManager/Permit2 on a fresh Anvil
pnpm test:pg                 # project "pg": needs FORGE_TEST_DATABASE_URL (and FORGE_TEST_REQUIRE_PG=1 to make it mandatory)
pnpm db:backup-rehearsal     # needs FORGE_REHEARSAL_ADMIN_URL and PG_BIN (PostgreSQL 16 client tools)
# Read-only against the live chain (CI-only; needs network access to the Robinhood RPC):
FORGE_FORK_RPC_URL=https://rpc.mainnet.chain.robinhood.com pnpm test:fork
FORGE_FORK_RPC_URL=https://rpc.mainnet.chain.robinhood.com pnpm test:v4:fork     # local Anvil fork; every transaction is local; A07e steps 7-9 are deferred
# Release gate (cannot report production readiness):
pnpm release:manifest && pnpm release:gate       # see w05.yml "release-gate" for the exact collect-ci/evaluate pipeline
# Dry-run deployment tooling (never broadcasts; DEPLOY_WRITE_ENABLED=false):
pnpm w05:deploy-plan plan --env robinhood-4663 --out m.json && pnpm w05:deploy-plan verify --manifest m.json
```

Vitest projects are defined in `apps/forge-web/vitest.config.ts`: `unit`, `integration`, `fork`, `v4`, `v4-fork`, `pg`.

## 10.7 Scanners (not an audit)

See `SECURITY-SCANNER-RESULTS.md` 8.6. The baseline gate: `node security/report.mjs --root . --commit "$(git rev-parse HEAD)" --out-dir security-report --baseline security/baseline.json --slither slither.json --aderyn aderyn.json --semgrep semgrep.json --versions slither=0.11.6,aderyn=0.6.8,semgrep=1.181.0`.

## 10.8 What was actually run while preparing this dossier

Stated plainly. Anything not in this table was **not** executed by the dossier author.

| # | Command (summarized) | Result |
| --- | --- | --- |
| 1 | `git rev-parse HEAD` in the worktree | `f4fa5e8a02f77958a0552ccaa411f3f1b39b5c1f` |
| 2 | `PATH=/tmp/fdry:$PATH FOUNDRY_PROFILE=forge forge build --skip test --skip script --out <scratch> --cache-path <scratch>` | succeeded with solc 0.8.35 (warnings from vendored OpenZeppelin `error` identifier); runtime sizes in `ROBINHOOD-CHAIN-RISKS.md` 7.4 (factory 24,470 B; splitter 11,680 B) |
| 3 | `forge test` (profile `forge`) with `--match-contract "W05EmergencyRevocationTest\|W05OwnerPowersTest\|W05AttestorCompromiseTest\|ForgeRevenueSplitterTest\|ForgeRevenueSplitterInvariantTest\|ForgeRevenueLifecycleTest\|ForgeLaunchAuthTest\|ForgeLaunchCallTest\|ForgeLifecycleTest\|ForgeSnipeTaxTest"`, in a `git archive` copy of the SHA with forge-std (v1.17.0, `f3dae6e6`) copied in from another checkout because the submodule is empty in the worktree | **129 passed, 0 failed, 0 skipped over 10 suites**: W05AttestorCompromise 7, W05EmergencyRevocation 11, W05OwnerPowers 11, ForgeLaunchAuth 35, ForgeRevenueSplitter 37, ForgeRevenueLifecycle 8, ForgeRevenueSplitterInvariant (3 invariant functions; forge reports the suite as 1 test) , ForgeLifecycle 4, ForgeLaunchCall 14 (10 own + 4 inherited), ForgeSnipeTax 1 |
| 4 | `tsx scripts/w06/audit-manifest.ts`, then `--check`, then regenerate and `cmp` | wrote 156 files / 29,735 lines; `AUDIT_MANIFEST_OK`; byte-identical on regeneration |
| 5 | Every manifest sha256 compared with `git show f4fa5e8a:<path> \| sha256sum` | 156/156 identical |
| 6 | `vitest run --project unit test/unit/w06-audit-manifest.test.ts` | 10 tests passed; `tsc --noEmit` reported no errors in the script or the test |
| 7 | `bash scripts/check-vendored-deps.sh` | `DEPENDENCY_INTEGRITY_OK` (89 files: 72 byte-identical, 16 whitespace-only, 1 unresolved) |
| 8 | `bash provenance/tree-integrity-gate.sh .` | `TREE_INTEGRITY_OK (103 sources verified across 8 compile sets + 14 allowlisted additions)` |
| 9 | `cmp` of `contractsV2-deployed/src/v2/**` vs `contractsV2-forge/src/v2/**` | 14 of 15 identical; the factory differs (49 diff lines) |
| 10 | `node -e` calling `security/report.mjs` `baselineAcceptance` / `triageStatus` on `security/baseline.json` | `UNREVIEWED`, `granted:false`; 302 entries, 0 open high |

**Not run:** `provenance/verify-parity.sh` and the other negative-test scripts, `forge test --profile testable` (W01 regression), `forge build --profile deployed|v1`, `pnpm size:check`/`abi:check`, integration / E2E / v4 / pg / fork / v4-fork suites, any scanner, the release gate, anything that needs the network or Docker. Statements in the dossier about those rest on the repository's own documents and CI configuration and are tagged DOC or CI-ONLY.
