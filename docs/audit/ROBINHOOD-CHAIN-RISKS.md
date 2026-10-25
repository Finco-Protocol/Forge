# 7. Robinhood Chain (4663) risks and evidence status

Sources: `docs/ROBINHOOD-CHAIN-VALIDATION.md` (live reads on 2026-10-08), `docs/W05-ROBINHOOD-V4-DEPLOYMENT.md`, `apps/forge-web/config/networks/robinhood-4663.json`, `release/readiness-items.json`, and the splitter source. No Forge contract is deployed on 4663. Flags: `PRODUCTION_BLOCKED=true`, `DEPLOY_WRITE_ENABLED=false`; the deploy tool refuses chain 4663 regardless of other settings.

Evidence classes: **SOURCE** (read at the SHA), **RAN** (executed for this dossier), **ONCHAIN (DOC)** (a live RPC read recorded in a repository document; this dossier made no network call), **CI-ONLY** (needs the live RPC, executed by CI according to the docs and not re-run here), **NOT VERIFIED**.

## 7.1 ArbSys block evidence (the one place the contracts depend on chain internals)

**Finding W05-05 (fixed).** Chain 4663 is an Arbitrum Orbit chain. CI against the real RPC measured the EVM `block.number` seen by contracts as the **parent-chain** number (26,193,299) while the RPC's L2 block was 88,673,151 (`test/v4-fork/arbos-block-semantics.test.ts` header; `release/security-findings.json`). The original splitter evidence check (`block.number` / `blockhash`) could therefore never match RPC-derived evidence and reverted `StaleEvidence` for every attestation.

**Current behaviour** (`ForgeProtocolRevenueSplitter._evidenceView(uint64 n) -> (head, hash)`, SOURCE):

1. `ARB_SYS = address(0x64)`; `staticcall` `arbBlockNumber()`. If the call succeeds and returns exactly 32 bytes, `head = arbBlockNumber()`.
2. Only when `n < head` **and** `head - n <= MAX_EVIDENCE_AGE_BLOCKS (256)`, `staticcall` `arbBlockHash(n)`; `hash` is set only if that call succeeds with 32 bytes, otherwise `hash` stays zero.
3. If ArbSys does not answer (no code at `0x64`, or a malformed return), the native opcodes are used: `head = block.number`, `hash = blockhash(n)`.
4. `authorizeEligibleRevenue` then requires `evidenceBlock < head`, `head - evidenceBlock <= 256`, `evidenceBlockHash != 0` and `evidenceBlockHash == hash`; otherwise `StaleEvidence`.

Points an auditor should test or challenge:

- **Fallback is a silent semantic switch.** Any failure of the ArbSys call (including out-of-gas in a static call) selects the EVM-opcode branch, whose numbering on 4663 would not match L2 evidence. On the live chain that fails closed (mismatch -> `StaleEvidence`), but the same code on a non-Arbitrum chain relies on `blockhash`'s own 256-block rule. Tests exist for both branches with an etched ArbSys double: `ForgeRevenueSplitterTest.test_H_reorged_or_stale_evidence_refused` (EVM branch), `test_H2_arbsys_chain_accepts_l2_numbered_evidence`, `test_H2_arbsys_chain_refuses_l1_numbered_evidence_and_bad_windows` (RAN: pass).
- **The real property is asserted only by a CI probe**, not by the Solidity tests: `arbBlockNumber() == RPC block` and `arbBlockHash(N-1) == RPC hash` via read-only `eth_call` (release item `A07c_ARBSYS_LIVE_READONLY_SEMANTICS`, CI-ONLY, marked verified in the manifest). This dossier did not re-run it.
- **Window length in wall-clock time is NOT VERIFIED.** The window is 256 *L2 blocks*. The block time of 4663 is not recorded in the repository; if blocks are sub-second the window is tens of seconds. The off-chain attestor keeps a margin of 200 blocks (`MAX_EVIDENCE_LAG_BLOCKS = 200n`) and a 600 s authorization TTL (`AUTHORIZATION_TTL_SECONDS`). Whether an attestation can be signed *and landed* inside the window under real latency is not demonstrated by any test in this repository.
- **`ForgeBindingRegistry.invalidatePendingOps` mixes `blockhash(block.number - 1)` into the barrier digest** so that no operation can be pre-signed against it (`keccak256(abi.encode(BARRIER_TAG, chainid, repoId, seq, parent, blockhash(block.number - 1)))`). The repository's own W05-05 measurement says EVM `block.number` / `blockhash` on 4663 do not follow L2 numbering. Whether `blockhash(block.number - 1)` is unpredictable (non-zero, not derivable in advance) on 4663 is **NOT VERIFIED**. If it were predictable, the barrier digest could be computed in advance, and the unpredictability argument in the registry natspec would not hold; the practical exposure is limited to an authority key that signs ahead (the barrier itself only ever narrows eligibility). Worth a targeted test on a real Orbit node.
- `block.timestamp` is used for every timelock and expiry (windows of minutes to days). Sequencer timestamp skew is assumed immaterial for those windows; not independently analysed.
- **Finality is undecided.** `FORGE_CONFIRMATIONS` defaults to `0` (`apps/forge-web/src/server/config.ts`); the production reorg window for an Orbit chain (soft finality vs L1 batch finality) is an open W05/operator decision (`docs/W03-W04-HANDOVER.md` item FINALITY). The ledger and attestor sign only up to the indexer checkpoint, so this setting directly bounds how reorg-safe an attestation is.

## 7.2 Chain 4663 assumptions

| Assumption | Class | Notes |
| --- | --- | --- |
| Chain id 4663; Arbitrum Orbit L2 settling to Ethereum; ETH gas | ONCHAIN (DOC) (`cast chain-id`; Orbit status indirect) | `docs/ROBINHOOD-CHAIN-VALIDATION.md` |
| Official RPC `https://rpc.mainnet.chain.robinhood.com` | ONCHAIN (DOC) | The dev sandbox cannot reach it (proxy 403 per `docs/W05-ROBINHOOD-V4-DEPLOYMENT.md`); every live check is CI-ONLY |
| EIP-170 enforced (24,576 B) | assumed standard | The existing `test:fork` probe covers contract-size behaviour (CI-ONLY); gas costs and size-limit behaviour beyond that are NOT VERIFIED (`W05-ROBINHOOD-V4-DEPLOYMENT.md` "What is NOT proven locally") |
| Native quote asset is ETH | SOURCE | Only native ETH is a source-proven quote asset; ERC-20 quotes: none approved, none verified |
| PUSH0 / `cancun` EVM features available | NOT VERIFIED on 4663 | The deploy-time PONS contracts compiled with `cancun` run on 4663 (parity evidence shows the deployed code), which is indirect support only |
| Deterministic-deployment proxy `0x4e59b44847b379578588920ca78fbf26c0b4956c` exists | CI-ONLY (`A07a`, read-only `eth_getCode`); the W05 doc listed it UNVERIFIED before that item was added; present locally on Anvil | Needed to CREATE2 the hook |
| Hook address mask: low 14 bits `== 0x2044` (`beforeInitialize` 0x2000 + `afterSwap` 0x0040 + `afterSwapReturnDelta` 0x0004) | SOURCE (`getHookPermissions`); local mining and acceptance by the genuine PoolManager are LOCAL-PROVEN per the W05 docs (DOC) | No production salt exists; it depends on the real constructor args (`B08_PRODUCTION_HOOK_SALT`, Class B) |
| Uniswap v4 stack | ONCHAIN (DOC) | table below |
| Block time, gas price behaviour, sequencer outage handling, forced-inclusion path | NOT VERIFIED | not documented |

## 7.3 Source-proven and on-chain-read addresses

None of these are Forge deployments.

| Item | Address | Class |
| --- | --- | --- |
| Uniswap v4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951`, 24,009 B | ONCHAIN (DOC) size; code identity CI-ONLY (`fork-runtime.test.ts`) |
| Uniswap v4 PositionManager | `0x58daec3116aae6d93017baaea7749052e8a04fa7`, 23,877 B | same |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3`, 9,152 B | same (canonical address) |
| Universal Router | `0x8876789976decbfcbbbe364623c63652db8c0904` | `UNVERIFIED`; not used by the Forge path |
| ArbSys precompile | `0x0000000000000000000000000000000000000064` | SOURCE constant in the splitter; live semantics per `A07c` (CI-ONLY) |
| Original PONS V2 factory | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` | Parity-proven against `contractsV2-deployed` per committed evidence (see `PROVENANCE-AND-LICENSING.md` 2.3). **Never indexed by Forge**; launches through it carry no Forge authorization |
| Original hook / escrow / vault / locker / deployer / executor / guard / router | listed in `PROVENANCE-AND-LICENSING.md` 2.3 | same |

The Forge section of `robinhood-4663.json` is all `null` and `NOT_DEPLOYED`. A first-time reader should treat any statement that "Forge is on Robinhood Chain" as wrong.

## 7.4 EIP-170 runtime sizes (RAN)

Measured for this dossier: `PATH=/tmp/fdry:$PATH FOUNDRY_PROFILE=forge forge build --skip test --skip script` at `f4fa5e8a` (solc 0.8.35, via-IR, 200 runs, cancun, ipfs metadata; forge 1.8.5 as pinned in CI), then `deployedBytecode.object` length / 2 from each artifact. Limit 24,576 B.

| Contract | Runtime bytes | Margin to 24,576 | In `size:check` list? |
| --- | ---: | ---: | --- |
| `PonsV2LaunchFactory` | **24,470** | **106** | yes |
| `PonsV2LaunchDeployer` | 20,906 | 3,670 | yes |
| `PonsV2MemeHook` | 15,167 | 9,409 | yes |
| `ForgeProtocolRevenueSplitter` | **11,680** | 12,896 | yes |
| `PonsV2BondingCurve` (per launch; embedded in the deployer's creation code) | 10,229 | 14,347 | no |
| `ForgeLaunchAuthorizer` | 8,127 | 16,449 | yes |
| `ForgeBindingRegistry` | 6,126 | 18,450 | yes |
| `PonsV2LaunchAndBuy` | 4,639 | 19,937 | no |
| `PonsV2BuybackVault` | 4,602 | 19,974 | yes |
| `PonsV2GraduationExecutor` | 4,402 | 20,174 | yes |
| `PonsV2LauncherToken` (per launch) | 3,248 | 21,328 | no |
| `PonsV2GraduationGuard` | 2,896 | 21,680 | no |
| `PonsV2LaunchLocker` | 1,969 | 22,607 | no |
| `PonsV2FeeEscrow` | 1,932 | 22,644 | yes |

- The factory figure and margin match `docs/MODIFICATION-REGISTER.md` section 7 (24,470 B, 106 B under) and `ForgeLaunchCallTest.test_factory_runtime_within_eip170` (RAN: pass). The gate `pnpm size:check` (`apps/forge-web/scripts/size-gate.ts`) fails any listed runtime above 24,576 B and requires a factory margin of at least `FORGE_FACTORY_MIN_MARGIN` (default 64 B). It checks nine contracts (not the curve, token, guard, locker or router); it was not run here (it reads `out/forge`; the equivalent numbers above come from a separate build).
- **The splitter runtime is 11,680 B, not 11,220 B** (a figure that appears nowhere in the repository and does not match the build). Older documents give 6,383 B (W04), 10,862 B (W04 Correction A), 11,501 B (W05) and 11,680 B (PR #5 Correction A); the last is current (KNOWN-DISCREPANCIES D1/D2).
- A margin of 106 B is thin. Any change to the factory or to compiler settings that adds roughly 100 B makes it undeployable on a standard EVM chain. The curve and token are deployed by CREATE2 inside the deployer, not as standalone runtimes; the deployer's runtime (20,906 B) already contains both creation codes.
- Corroboration for the unmodified contracts: the measured runtimes of the hook (15,167 B), escrow (1,932 B), vault (4,602 B) and locker (1,969 B) equal the on-chain code sizes recorded in `docs/ROBINHOOD-CHAIN-VALIDATION.md`, and the deployer (20,906 B) equals `code_bytes 20853 + metadata_tail 53` in `provenance/PonsV2LaunchDeployer/verify-result.txt`. Size equality is a sanity check, not parity evidence.
- Compiler settings are unchanged from the deploy-time build, and no bytecode parity is claimed for the Forge factory.

## 7.5 `A07e_ROBINHOOD_FORK_REVENUE_CLAIMS_LIFECYCLE` is NOT VERIFIED

`release/readiness-items.json` marks A07e `deferred` with steps 7-9 (revenue attestation + splitter pull, treasury claim, creator claim) of the genuine-V4 lifecycle. A deferred item can never pass: it reports `NOT_VERIFIED`, forces the gate state `EVIDENCE_INCOMPLETE`, and any `ciJobs` mapping on it fails the gate (`DEFERRED_ITEM_HAS_CI_MAPPING`). It closes only by a reviewed manifest change that replaces it with a real, mapped job.

**Why.** The local Anvil fork of 4663 emulates ArbOS. `0x64` is a precompile that `anvil_setCode` cannot replace (observed `PrecompileError` in CI), so neither real ArbSys nor a test double can serve the splitter's evidence read on that fork, and gas/L1 accounting differs from the harness's assumptions. The skipped steps are a single constant (`apps/forge-web/test/v4/fork-deferred.ts`) checked against the manifest by a unit test.

**What does cover those steps, and what does not.**

| Evidence | Covers | Does not cover |
| --- | --- | --- |
| `A06_GENUINE_V4_LOCAL`: fresh Anvil with genuine PoolManager / PositionManager / Permit2 artifacts (all 10 lifecycle steps) | steps 1-10 with genuine v4 code, locally | any property of the real chain |
| `ForgeRevenueSplitterTest.test_H2_*` (RAN) | the splitter's ArbSys branch, with an etched double | real ArbOS |
| `A07a` / `A07b` / `A07c` (CI-ONLY) | runtime identity, steps 1-6 and 10 on a fork, ArbSys read-only semantics | steps 7-9 on the fork or the live chain |
| `B09_ROBINHOOD_PRODUCTION_WRITE_ACCEPTANCE` | nothing: **NOT PERFORMED** (Class B, no mainnet writes) | production write behaviour |

An Anvil fork never proves production behaviour. The release gate therefore cannot reach `ENGINEERING_PASS` in the sense of "everything tested": it means "everything that was executed passed".

## 7.6 Other chain-specific risks to put in front of an auditor

1. **Hook CREATE2 mining** against the real PoolManager / escrow / splitter / owner arguments has not been done; the mining tool is deterministic from salt 0 upward and refuses build-setting mismatches (`scripts/w05/hook-mine*.ts`).
2. **Graduation depends on the real PositionManager and Permit2.** Genuine-artifact tests pass locally (graduation residual 148 wei with genuine PositionManager versus large residual with mocks, per W05 docs); the same on 4663 is covered only for steps 1-6 and 10 on a fork.
3. **Quote assets:** only native ETH is source-proven; any ERC-20 quote needs the review in blocker `QUOTE`.
4. **Reorg depth and indexer confirmations** (`FINALITY`), see 7.1.
5. **RPC outage** fails closed for authorization signing (runbook D11); nothing in the contracts depends on an RPC.
6. **Chain halt / sequencer outage:** timelock and expiry clocks depend on `block.timestamp`; behaviour on resumption (e.g. an execution window elapsing during an outage) is not analysed anywhere in the repository.
