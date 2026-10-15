# W05 — Robinhood Chain Uniswap V4 integration and deployment tooling

Status: `PRODUCTION_BLOCKED=true`, `FINCO_BURN_ENABLED=false`,
`FORGE_FEE_POLICY_AUTHORITY_UNPROVEN=true`,
`REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED=false`,
`DEPLOY_WRITE_ENABLED=false`. Nothing here broadcasts to chain 4663.

Evidence classes: `LOCAL-PROVEN` (a command run in the dev container, listed
below), `CI-ONLY` (needs the Robinhood RPC, which is blocked from the dev
container (proxy 403, re-checked while writing this); written but **not yet
run**), `ONCHAIN_VERIFIED` (carried from `docs/ROBINHOOD-CHAIN-VALIDATION.md`,
2026-10-08), `UNVERIFIED`.

## 1. Integration facts

| Item | Value | Class |
| --- | --- | --- |
| Chain id | 4663 | ONCHAIN_VERIFIED (earlier run); re-asserted by CI fork tests |
| PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951`, 24,009 B | ONCHAIN_VERIFIED size; code identity CI-ONLY (`fork-runtime.test.ts`) |
| PositionManager | `0x58daec3116aae6d93017baaea7749052e8a04fa7`, 23,877 B | same |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3`, 9,152 B | same |
| Quote asset | native ETH only (`address(0)`) | SOURCE_PROVEN; ERC-20 quotes UNVERIFIED, none approved |
| Hook mask | low 14 bits of the hook address == `0x2044` | SOURCE_PROVEN; LOCAL-PROVEN by mining and by the genuine PoolManager accepting the pool |
| Deterministic-deployment proxy `0x4e59…956c` | **UNVERIFIED on 4663** | CI-ONLY (`fork-runtime.test.ts`, read-only `eth_getCode` against the real RPC). Present locally on Anvil. |
| Genuine artifacts | `@uniswap/v4-core@1.0.2` (solc 0.8.26, runs 44444444, via_ir), `@uniswap/v4-periphery@1.0.3` (PositionManager runs 30000) | LOCAL-PROVEN: PoolManager runtime is 24,009 B locally = on-chain size |

### Finality / reorg notes (from repo docs and source)
- The splitter reads the evidence head and block hash in `_evidenceView`
  (`ForgeProtocolRevenueSplitter.sol`): through the ArbSys precompile (`0x64`,
  `arbBlockNumber()` / `arbBlockHash(n)`) when it answers, otherwise through
  the EVM opcodes (`block.number` / `blockhash`). It accepts evidence only if
  the evidence block is below that head, within 256 blocks of it, and its hash
  equals the signed hash. The attestor fills these from RPC `eth_getBlock` at
  the indexer checkpoint (`src/server/finance/attestor.ts`).
- **Resolved by measurement (finding W05-05):** 4663 is an Arbitrum Orbit
  chain and, as measured by CI against the real RPC, the EVM `block.number`
  there is the parent-chain number (26,193,299 vs RPC block 88,673,151), so the
  original opcode-based check could never match RPC evidence. With ArbSys the
  live read-only probe `test/v4-fork/arbos-block-semantics.test.ts` asserts
  `arbBlockNumber() == RPC block` and `arbBlockHash(N-1) == RPC hash`; this is
  item `A07c_ARBSYS_LIVE_READONLY_SEMANTICS` (verified). Not verified: the
  splitter's end-to-end behaviour on a local fork or the live chain (see the
  evidence classification below, `A07e` and `B09`).
- `FORGE_CONFIRMATIONS` / reorg window for Orbit (sequencer soft finality vs
  L1 batch finality) remain a W05 decision recorded in
  `docs/W03-W04-HANDOVER.md` (FINALITY); not decided here.

## 2. What the genuine-V4 tests prove (LOCAL-PROVEN)

`pnpm test:v4` runs a fresh Anvil with the genuine artifacts (no mini mocks;
Permit2 is the runtime embedded in Uniswap's `DeployPermit2` placed at the
canonical address with its two constructor-time immutables re-bound to the
chain, which is what its constructor would compute) and the real Forge stack.

`test/v4/lifecycle-suite.ts` (11 tests): wiring and runtime identity of every
V4 contract vs its artifact (immutables masked); hook mask and CREATE2 address
via the 0x4e59 proxy; repo binding + authorized launch; curve buys and sweep;
graduation through the genuine PositionManager and Permit2 into a locked
full-range position (liquidity read from StateView equals the position's);
real swaps through the genuine PoolManager using Uniswap's own `PoolSwapTest`
router producing hook fees; creator `sweepPoolFees`; operator-only memecoin
conversion; attested ceiling (key `ANVIL_KEYS[4]`, digest cross-checked with the
splitter's `eligibleRevenueDigest`) then `pullRevenue` with a third-party
credit left in escrow; treasury claim; creator escrow claim; supply conservation.
`test/v4/app-pipeline.test.ts`: the W03/W04 app (API launch, indexer, ledger,
the worker's own attestor, treasury report) over the genuine stack, ends
`RECONCILED`. `test/v4/deploy-plan-dryrun.test.ts`, `hook-mine-cli.test.ts`,
`fork-guards.test.ts`: tooling and guard rails.

Behavioural difference observed vs the mocks: graduation residual is 148 wei
with the genuine PositionManager (the W02 mocks left a large residual).

**No incompatibility between the Forge stack and genuine V4 was found.** No
test is skipped or weakened.

### What is NOT proven locally
- That the code on 4663 equals these artifacts (CI-ONLY: `fork-runtime.test.ts`).
- That the deterministic-deployment proxy exists on 4663 (CI-ONLY).
- `block.number`/`blockhash` semantics on 4663 (CI-ONLY, see above).
- The same lifecycle on a fork of 4663 (`test:v4:fork`, CI-ONLY).
- Gas costs and the chain's contract-size limit behaviour beyond the existing
  `test:fork` probe.

## 3. Tools and commands (from `apps/forge-web`)

```
forge build --profile forge            # repo root; then: git checkout -q foundry.lock
pnpm test:v4                           # local-genuine suite (also hook-mine / deploy-plan CLI tests)
FORGE_FORK_RPC_URL=https://rpc.mainnet.chain.robinhood.com pnpm test:v4:fork   # CI only
pnpm w05:genuine-v4 [--mode local-genuine|fork] [--out f] [--keep]
pnpm w05:hook-mine --pool-manager 0x… --escrow 0x… --recipient 0x… --owner 0x… [--deployer 0x…] [--salt 0x…] [--out f]
pnpm w05:deploy-plan plan --env robinhood-4663 --out m.json
pnpm w05:deploy-plan verify --manifest m.json
pnpm w05:deploy-plan dry-run [--env local-genuine|fork-4663]
pnpm w05:deploy-plan write …           # always refused (exit 3)
```

Fork mode throws without `FORGE_FORK_RPC_URL`. It only sends transactions to
the local Anvil (`isLocalAnvilFork` requires a loopback host and
`anvil_nodeInfo.forkConfig.forkUrl`); `deploySandbox` accepts chain 4663 only
under that check (tested in `fork-guards.test.ts`).

### Hook mining
Salts are searched from 0 upward, so identical inputs give identical output.
The tool reads the exact `out/forge` artifact, compares `foundry.toml`
`[profile.forge]` with the artifact's solc metadata (solc 0.8.35, optimizer
200 runs, via_ir, cancun, ipfs metadata hash) and exits 1 on mask or
settings mismatch. Example (synthetic constructor args, deployer 0x4e59…956c):
salt `0x…3be0` -> `0xc657D1823709A72d7B05C40ef240ec16522b6044` (15,329 iterations).
The final address depends on the real escrow/splitter/owner addresses, which do
not exist yet on 4663, so no production salt is claimed.

### Deployment manifest
Contains environment, build manifest with creation/runtime keccak per
contract, dependency-ordered steps with constructor args and CREATE-predicted
addresses, hook CREATE2 evidence, roles (pairwise distinct, enforced),
fee-recipient = splitter check, quote assets, runtime/role/treasury checks,
smoke tests S01-S10, Ownable2Step hand-over (`transferOwnership` by deployer,
`acceptOwnership` by governance) and sign-off checklist; plus a keccak content
hash. `verify` recomputes it and re-derives addresses, args, hook evidence, role
separation and artifact drift. The `robinhood-4663` manifest uses
**placeholder** roles (labelled; nobody holds the keys), so it is
`NOT_EXECUTABLE` by construction. `DRY_RUN` executed all 35 steps and 64 checks
on local-genuine (LOCAL-PROVEN).

WRITE refusals (all unit-tested): `DEPLOY_WRITE_ENABLED=false`; chain 4663
refused regardless; confirmation token bound to the manifest hash; chain
mismatch; invalid/tampered manifest; placeholder roles; PRODUCTION_BLOCKED.

## 4. Rollback and emergency
A deployment cannot be undone on chain. Before go-live: abandon and redeploy
from a new manifest. After: `factory.setLaunchEnabled(false)`, splitter
`setPullsPaused(true)` / `revokeRevenueAttestor()`; see
`docs/W03-SECURITY-RUNBOOK.md` and `docs/W04-ECONOMICS-ARCHITECTURE.md`.

## 5. Blockers carried forward
Audit, governance multisig/timelock, attestor and treasury custody, the
`blockhash` semantics probe, proxy presence on 4663, legal (BUSL v4-core),
ERC-20 quote asset review. See `docs/W04-W05-HANDOVER.md`.

## Robinhood evidence classification (PR #5 Correction A)

The release report distinguishes six categories. Nothing here claims that an Anvil fork proves production behaviour.

| # | Evidence | Item | Status |
|---|---|---|---|
| 1 | Genuine V4 **local** lifecycle (fresh Anvil, genuine PoolManager/PositionManager/Permit2, all 10 steps incl. attestation, pull, claims) | `A06_GENUINE_V4_LOCAL` | verified (CI + local) |
| 2 | Robinhood 4663 contract/runtime identity and CREATE2 proxy presence, read-only RPC | `A07a_ROBINHOOD_RPC_RUNTIME_IDENTITY` | verified |
| 3 | Fork lifecycle steps that **executed**: 1–6 and 10 against the REAL deployed V4 contracts on a local Anvil fork, plus deploy-plan DRY_RUN | `A07b_ROBINHOOD_FORK_EXECUTED_STEPS` | verified (scope limited to those steps) |
| 4 | ArbSys live **read-only** semantics: `arbBlockNumber()`/`arbBlockHash(N-1)` equal the RPC block number/hash | `A07c_ARBSYS_LIVE_READONLY_SEMANTICS` | verified |
| 5 | Fork revenue/claims lifecycle (steps 7–9) | `A07e_ROBINHOOD_FORK_REVENUE_CLAIMS_LIFECYCLE` | **NOT VERIFIED** (skipped; gate state `EVIDENCE_INCOMPLETE`) |
| 6 | Robinhood production write acceptance | `B09_ROBINHOOD_PRODUCTION_WRITE_ACCEPTANCE` | **NOT PERFORMED** (Class B, no mainnet writes) |

Why steps 7–9 are deferred: the local Anvil fork of chain 4663 emulates ArbOS. `0x64` (ArbSys) is a precompile that `anvil_setCode` cannot replace (observed `PrecompileError` in CI), so neither the real ArbSys nor a test double can serve the splitter's evidence read there, and gas/L1 accounting differs from the harness's assumptions. The skipped step list is a single constant (`test/v4/fork-deferred.ts`) checked against the manifest by a unit test, so skipping a step without deferring it (or the reverse) fails CI. The three steps are fully exercised on the fresh-Anvil suite (#1), and the splitter's ArbSys branch by forge tests (`test_H2_*`), but never against the 4663 fork or the live chain.

Harness investigation: `test/v4-fork/anvil-arbsys-investigation.test.ts` is a diagnostic (it asserts nothing about fidelity) that records what Anvil does at `0x64` on a fork with the remote chain id and on one with `--chain-id 31337`; its output (`W05_ANVIL_ARBSYS_PROBE`) is in the CI log of the fork job. Even if a chain-id-overridden fork allowed a test double at `0x64`, that would be a labelled emulation of documented ArbSys behaviour, not evidence about the target chain, so it could not replace category 3/4 facts or category 6.

## Dry-run transaction confirmation (Correction D)

The 4663 fork dry-run (`pnpm w05:deploy-plan dry-run --env fork-4663`) sends every deployment transaction to a **local
Anvil** (impersonated role accounts; the real Robinhood RPC is only the read-only fork source). Once, in CI, a step timed
out with only viem's `Timed out while waiting for transaction <hash>` after 180 s.

**Observed (CI, run 38716345280 / 38716338758, commit 4f54aa3):** the transaction hash was returned by the local node, the
receipt never appeared. The same job passed on the preceding commit and passed 6/6 locally. The harness did not record
which step, nonce, fee, or node state was involved. **Root cause: not established from the failing logs.**
**Mechanism demonstrated (ad hoc, local):** with the fork's remote backend slowed to ~20 s per read, Anvil returns the
transaction hash after the first slow read and the receipt stays `null` while the remaining cold state reads are in
flight - the same signature. That is a candidate, not a finding: nothing in the failed logs proves the remote was slow.

What changed (no timeout increase, no `anvil_mine`):

- every step records step/op/contract/function, sender, expected nonce, tx hash, gas and fees as seen by the node,
  blocks before/after, visibility by hash, receipt status and elapsed time (`stepHistory` in the report);
- a **60 s per-step** confirmation budget (`FORGE_TX_CONFIRM_TIMEOUT_MS`) instead of an opaque 180 s, and the receipt must
  be for *that* hash, from *that* sender, to the expected target, with `status: success`; chain id is checked before submit;
- on a timeout the node snapshot is captured (tx by hash, receipt, latest/pending nonce, block, base fee, gas price,
  automine/interval mining, txpool, Anvil log tail) and the failure is **classified from that evidence**:
  `TX_NOT_ACCEPTED | PENDING_AUTOMINE_DISABLED | PENDING_NONCE_GAP | NONCE_CONFLICT | UNDERPRICED | PENDING_MINING_STALLED |
  RPC_RECEIPT_UNAVAILABLE | ANVIL_EXITED | WRONG_CHAIN | RECEIPT_MISMATCH | CONFIRMED_REVERT` (`PENDING_MINING_STALLED` is
  only the residual: accepted + pending with automine on, nonce right, fee above base fee);
- before the first step: loopback-only RPC (a non-loopback URL is refused before any request), `anvil_getAutomine` must be
  `true`, the deployer nonce must equal the manifest's predicted CREATE nonce, and on a fork the cold-read latency of the
  fork backend is measured (`forkBackend` in the report);
- a failed deployment is a `FAILED` report (never a partial success) written to the same `--out` artifact together with the
  step history, snapshot and Anvil log tail; Anvil is stopped with SIGTERM -> SIGKILL and reaped if the harness exits.

If this failure recurs, the artifact `w05-fork-dryrun` names the step and the class; a `PENDING_MINING_STALLED` with a high
`forkBackend.maxMs` would point at the remote fork backend, and the next correction would target that (for example a
pinned fork block with a restored cache), not the transaction.
