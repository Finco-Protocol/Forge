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
- The splitter accepts evidence only if `evidenceBlock < block.number`,
  `block.number - evidenceBlock <= 256` and `blockhash(evidenceBlock)` equals
  the signed hash (`ForgeProtocolRevenueSplitter.sol:283-290`). The attestor
  fills these from RPC `eth_getBlock` at the indexer checkpoint
  (`src/server/finance/attestor.ts:153-175`).
- **Open risk (not resolved here):** 4663 is an Arbitrum Orbit chain
  (ONCHAIN_VERIFIED, indirect). Arbitrum documents that `block.number` and
  `blockhash` inside the EVM are not the L2 RPC block number/hash. If that
  holds on 4663, every attestation reverts `StaleEvidence` there. A local
  Anvil fork cannot show this (Anvil uses Ethereum semantics). The CI probe
  `test/v4-fork/arbos-block-semantics.test.ts` asks the real chain via
  `eth_call` and will fail if the assumption is wrong. **Status: UNVERIFIED
  until that probe runs in CI.** If it fails, the splitter's evidence rule
  needs a contract change (Forge-owned source, out of scope here) before
  production.
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

## Fork-mode limitation (measured in PR CI) — a gap, not a pass

The local Anvil fork of chain 4663 emulates ArbOS: address `0x64` (ArbSys) is a precompile that `anvil_setCode` cannot replace, and gas/L1 accounting differs from the real EVM assumptions in the harness. Therefore lifecycle steps 7–9 (revenue attestation → splitter pull → treasury/creator claims) are **skipped in fork mode** and run only on the fresh-Anvil genuine-V4 suite. What still covers them: (a) fork steps 1–6 and 10 against the REAL deployed PoolManager/PositionManager/Permit2; (b) the read-only probe `test/v4-fork/arbos-block-semantics.test.ts`, which asserted on the real RPC that `ArbSys.arbBlockNumber()`/`arbBlockHash()` equal the RPC's block number/hash (finding W05-05); (c) forge tests `test_H2_*` for the splitter's ArbSys branch. The splitter's behaviour on the live ArbOS chain end-to-end remains unproven until a testnet/staging attestation is executed by an operator (Class B).
