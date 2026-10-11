# W02 Source Recovery — Phase 1 Gate Report

Workflow 02, Phase 1 (2026-10-09). The hard source-recovery gate from the
W02 mission: establish whether PONS V2 can be reproduced safely before any
Forge implementation work.

**Verdict: GO — the complete required launch path is source-proven,
compiles reproducibly, and matches deployed bytecode.**

## 1. Recovery method

The published upstream source (Workflow 01 finding F-01) does not compile:
the factory references `PonsV2BondingCurve.exemptFromSnipeTax`, which the
published curve does not define, and the deployer lacks CREATE2. The
deploy-time source was therefore recovered from **Sourcify**, where the
live Robinhood Chain (4663) deployments are verified with full standard-JSON
compilation inputs:

- Sourcify v2 API: `sourcify.dev/server/v2/contract/4663/<address>?fields=all`
- Each record contains: verification tier, on-chain vs recompiled creation
  and runtime bytecode, the full std-json input (sources + compiler
  settings), the deployment transaction hash, and the deployer.
- Sources extracted per contract from the record's `sources` map into
  `.w02-recovery/<name>-src/` (working extraction output, gitignored —
  the durable evidence is this tooling, the committed deploy-time tree
  `contractsV2-deployed/`, and the embedded sources in each
  `provenance/<Contract>/std-json-input.json`).

Priority order per the mission: (1) exact upstream deploy-time source —
not available; (2) **verified explorer source matching deployed addresses —
USED, via Sourcify**; (3) historical revisions — not needed.

## 2. Verification matrix

| Contract | Address (4663) | Sourcify match | Verified at | Deploy tx | Independent byte-verification (this workflow) |
| --- | --- | --- | --- | --- | --- |
| PonsV2LaunchFactory | `0x7eD5…EC7e` | **exact** (creation + runtime) | 2026-08-04 | `0x3817f297…` | RUNTIME-PARITY-PROVEN — `EXACT_VIA_SOURCIFY` (114 immutable spans) |
| PonsV2LaunchDeployer | `0x3711…1A42` | **exact** (creation + runtime) | 2026-08-04 | `0x849d092e…` | RUNTIME-PARITY-PROVEN — `EXACT_VIA_SOURCIFY` (12 spans) |
| PonsV2LaunchAndBuy | `0xe33E…2948` | **exact** (creation + runtime) | 2026-08-04 | `0x4be522d4…` | RUNTIME-PARITY-PROVEN — `EXACT_VIA_SOURCIFY` (12 spans) |
| PonsV2MemeHook | `0xE5e7…e044` | match (creation + runtime) | 2026-08-05 | `0x220a9825…` | RUNTIME-PARITY-PROVEN — `IMMUTABLE_PATCHED` (69 spans) |
| PonsV2FeeEscrow | `0xd3AF…Ac9e` | match (creation + runtime) | 2026-08-14 | `0xf0a6e026…` | RUNTIME-PARITY-PROVEN — `IMMUTABLE_PATCHED` (0 spans — no immutables) |
| PonsV2BuybackVault | `0x42df…219c` | match (creation + runtime) | 2026-08-20 | `0x4ceb1e80…` | RUNTIME-PARITY-PROVEN — `IMMUTABLE_PATCHED` (12 spans) |
| PonsV2LaunchLocker | `0x2674…4952` | match (creation + runtime) | 2026-08-25 | `0x7b2f3e9d…` | RUNTIME-PARITY-PROVEN — `IMMUTABLE_PATCHED` (12 spans) |
| PonsV2GraduationExecutor | `0xC781…9046` | match (creation + runtime) | 2026-08-25 | `0x21d0b869…` | RUNTIME-PARITY-PROVEN — `IMMUTABLE_PATCHED` (33 spans) |
| PonsV2GraduationGuard | `0xf569…c6C` | (verified transitively inside the factory's source set) | — | — | RUNTIME-PARITY-PROVEN — `EXACT` (0 spans) |

"match" in Sourcify v2 terms = full bytecode match modulo immutable
positions; "exact" = including metadata. PonsV2LauncherToken's source rides
in every package; PonsV2GraduationGuard's source rides in the factory and
executor packages.

### Classification tiers (what may be claimed, and by what evidence)

The CI source-parity gate (`provenance/verify-parity.sh`) enforces this
vocabulary; a contract may only carry the strongest tier its recorded
evidence supports, and **anything weaker is `UNVERIFIED` and fails the
gate — never labeled RUNTIME-PARITY-PROVEN**:

- **`EXACT`** — recompiled runtime is byte-identical to the on-chain
  runtime including the metadata tail. Currently: PonsV2GraduationGuard.
- **`EXACT_VIA_SOURCIFY`** — Sourcify's independent "exact" tier proved
  creation+runtime+metadata equality at deploy-time verification; the
  local recompile proves full code-section parity while the metadata tail
  necessarily differs (toolchain/`outputSelection` presence), which is
  handled explicitly and recorded. Currently: factory, deployer,
  launch-and-buy router.
- **`IMMUTABLE_PATCHED`** — code-section parity holds after patching only
  the documented constructor-immutable spans (each diff must expand to a
  20-byte zero placeholder), with length-matched well-formed tails. Every
  patched address is cross-checked against the deployment table.
- **`UNVERIFIED` / `BLOCKED`** — missing manifest artifact, source drift,
  recompile failure, or any unexpected byte difference. The gate fails;
  no parity claim may be made.

A declared floor may be exceeded upward (e.g. GraduationGuard is declared
`IMMUTABLE_PATCHED` as its contract-shape floor but observes `EXACT`);
the reverse is a hard failure.

### Independent byte-verification method

`solc 0.8.35+commit.47b9dedd` (the EXACT deployed compiler version, per the
Sourcify compilation record) recompiles each contract from its recovered
`std-json-input.json` (with `outputSelection` injected — the only
modification, which cannot affect codegen). The recompiled runtime bytecode
is then compared byte-for-byte against the live on-chain runtime code
(`cast code`) under explicit metadata handling:

1. The CBOR auxdata tail is located as the LAST occurrence of the ipfs
   metadata marker whose trailing 2-byte length word is consistent
   (deployer-type contracts embed creation code that contains the marker as
   data).
2. Every template-vs-deployed difference inside the code portion must
   expand to exactly a 40-hex-char all-zero run in the template — a
   20-byte immutable address placeholder — and is patched with the on-chain
   value.
3. After patching, the code portions must be FULLY byte-equal; both tails
   must be equal length and well-formed.

**Result: 9/9 RUNTIME-PARITY-PROVEN** — the recovered sources reproduce the
deployed bytecode exactly, with the only differences being the constructor
immutable addresses (factory, hook, pool manager, position manager, permit2,
locker, vault, escrow — all cross-checked against the documented deployment
table; e.g. the factory's embedded hook `0xe5e702…e044`, PoolManager
`0x8366a3…0951`, Permit2 `0x000000000022D473…78BA3`). The auxdata tails
differ only because the verification toolchain (Windows solc build, and
`outputSelection` presence) changes the embedded metadata hash — handled
explicitly per step 1–3; Sourcify's own "exact" tier independently
confirms metadata-level equality for the three exact-matched contracts.

Compiler settings (from the Sourcify record): solc `0.8.35+commit.47b9dedd`,
EVM version cancun, `via_ir = true`, optimizer 200 runs, metadata hash ipfs.

## 3. F-01 / F-02 disposition

- **F-01 CLOSED (for the recovered tree):** the deploy-time sources
  compile as a whole (99 files, `forge build --profile deployed` and
  `--profile forge` both green). The published-tree defects are exactly:
  the deploy-time `PonsV2BondingCurve` carries the anti-snipe machinery
  (`snipeTaxStartBps`/`snipeTaxSeconds` snapshot from the factory,
  `exemptFromSnipeTax`, exponential decay) that the published curve lacks,
  and the deploy-time `PonsV2LaunchDeployer` CREATE2-deploys via
  `Create2.deploy` with the factory's per-creator salt namespacing —
  matching upstream issue #10's diagnosis precisely.
- **F-02 CLOSED (for the recovered tree):** `PonsV2FeeEscrow` (148 LoC) and
  `PonsV2LaunchAndBuy` (222 LoC) sources are recovered and verified above.

F-01/F-02 remain open **for the published upstream repository** (that is
Pons Labs' action to take); for Forge's own W02 foundation they are closed
by this recovery, with the deployed-bytecode parity evidence above.

## 4. Deploy-time source inventory

`contractsV2-deployed/` holds the verified tree (87 `.sol` files from the
factory package + FeeEscrow + LaunchAndBuy + the OZ cryptography/ERC721
files the Forge additions need):

- `src/v2/`: 11 financial contracts (curve, deployer, factory, token,
  executor, guard, locker, vault, escrow, launch-and-buy, hook) + 2
  interfaces + 2 libraries.
- `lib/`: OpenZeppelin (v5.0.0 subset — `Ownable.sol` header confirms),
  Uniswap v4-core, v4-periphery (+permit2 interfaces), v4-hooks-public,
  forge-std.

Integrity: every file in the factory/executor/hook/vault/locker/escrow
package is byte-identical to its Sourcify extraction (`drifted=0` across
the tree); the OZ cryptography files added for the Forge authorizer are
pinned byte-identical to OpenZeppelin v5.0.0. The single cross-package
divergence found: `ILaunchpadV2.sol` exists in two revisions — the
factory's (with `IPonsV2SnipeTax`, used here) and the hook/vault/executor
packages' (earlier, without it). Each package's own copy is what THAT
contract compiled against; no behavioral conflict.

### Provenance discovery

The locker package's verified source carries the contract name
**`RobinFunFiV2LaunchLocker`** and `IRobinFunFiV2*` interfaces — the
deploy-time tree is the renamed descendant of a "RobinFunFi V2" codebase
(verified 2026-08-25, after the factory's 2026-08-04 verification). This
is provenance evidence, not a defect: the RobinFunFi-named locker source
compiles to the deployed bytecode identically (its package verified
`match`), and the PONS-renamed equivalents verify against the same
bytecode.

## 5. Hard GO/NO-GO decision

| Criterion | Result |
| --- | --- |
| A. Complete launch path source-proven | ✅ all 10 required contracts + optional LaunchAndBuy |
| B. Compiles reproducibly | ✅ solc 0.8.35 exact, both profiles green |
| C. Provenance independently established | ✅ Sourcify tiers + deploy txs + this workflow's byte verification |
| D. No undocumented critical mismatch | ✅ only immutable-value and metadata-tail differences, both handled and cross-checked |
| E. Licensing | ✅ MIT first-party; OZ v5.0.0 additions MIT; BUSL-1.1 (v4-core Pool/Position) unchanged from W01 — legal-review gate carried forward |
| F. High-severity findings have an evidence-backed remediation plan | ✅ F-03/F-04 addressed structurally in the Forge-owned stack (see docs/THREAT-MODEL-W02.md) |

**GO.** Phase 2–4 implementation proceeded on this foundation.
