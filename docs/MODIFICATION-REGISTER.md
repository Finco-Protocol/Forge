# Contract Modification Register — W02

Every divergence from the verified deploy-time PONS V2 source
(`contractsV2-deployed/`), with regression-test coverage. Baseline:
`RUNTIME-PARITY-PROVEN` sources (docs/W02-SOURCE-RECOVERY.md).

## 1. Financial contracts — ZERO divergence

`diff` between the deploy-time tree and the Forge-owned tree
(`contractsV2-forge/src/v2/`) is EMPTY for:

- PonsV2BondingCurve.sol — curve mathematics, fee accounting, graduation untouched
- PonsV2LaunchDeployer.sol — CREATE2 deployment untouched
- PonsV2LauncherToken.sol — token untouched
- PonsV2GraduationExecutor.sol — Permit2/V4 mint untouched
- PonsV2GraduationGuard.sol — seed preflight untouched
- PonsV2LaunchLocker.sol — permanent lock untouched
- PonsV2BuybackVault.sol — five-year vest untouched
- PonsV2FeeEscrow.sol — escrow untouched
- PonsV2LaunchAndBuy.sol — router untouched
- PonsV2MemeHook.sol — hook fee logic untouched
- interfaces/ and libraries/ — untouched

No token supply, fee mathematics, curve pricing, graduation threshold, or
liquidity behavior was changed anywhere.

## 2. PonsV2LaunchFactory.sol — the M-ELIG change (blueprint Phase 3)

Exactly one functional modification: **M-ELIG eligibility enforcement**.
Diff vs deploy-time source: 56 changed lines (all additions plus the
constructor's one new parameter). Elements:

1. `IForgeLaunchAuthorizer public immutable launchAuthorizer` — new
   immutable, constructor-injected, zero-checked. Governance can rotate the
   signing key inside the authorizer; it can never remove the enforcement
   from the factory's launch path.
2. `TokenParams` extended with the Forge authorization fields:
   `githubRepoId`, `authorizationExpiresAt`, `authorizationNonce`,
   `creatorSignature`, `attestationPayload`. The launch entry-point
   signatures are otherwise unchanged.
3. In `_launchToken` (private, shared by ALL entry points — direct,
   overload-with-exemptions, and trusted-forwarder), immediately after the
   creatorFeeRecipient is resolved and BEFORE `deployLaunch` executes:
   `launchAuthorizer.requireAuthorizedLaunch(intent, creatorFeeRecipient,
   params.buybackEnabled, params.creatorSignature, params.attestationPayload)`.
   The intent binds factory address, creator, repo id, config id, pair
   token, metadata hash (name, symbol, logo, description, socials), live
   economics digest, salt, expiry, nonce, AND (Correction A):
   - the effective `creatorTaxBps` the factory will apply (a forwarded or
     malformed launch submitting a different tax reverts);
   - the canonical anti-snipe exemption list hash (sorted-ascending hash;
     a reordered submission is accepted, any addition/removal/substitution
     reverts).

### 2a. Entry-point exemption binding (Correction A / P1-3)

The three launch entry points now compute the CANONICAL exemption list
hash (sorted-ascending hash; zero addresses refused; 32-entry cap
preserved) and pass it into `_launchToken` so it feeds the signed intent:

- `launchToken(params, id, pair)` — binds the canonical EMPTY list hash.
- `launchToken(params, id, pair, exemptions)` — binds
  `_canonicalExemptionHash(exemptions)`, computed BEFORE `deployLaunch`.
- `launchTokenFor(params, id, pair, originalDeployer, exemptions)` — same
  binding; the owner-configured forwarder cannot alter the signed list.

Why exemptions are economically sensitive: an exemption wallet buys at the
UNTAXED price during the launch-second 99%-decay window. An unsigned list
lets a malicious forwarder add its own wallets (capturing the tax value)
or attacker wallets that dump immediately (the W01 F-08 extraction
pattern).

Effect: the invariant **no token can be launched through the Forge factory
without valid authorization from the approved Forge eligibility authority**
holds structurally on every path. Residual governance trust (documented in
docs/THREAT-MODEL-W02.md): the Forge owner retains the deploy-time owner
powers (fee-recipient override with timelock, rescue paths); M-ELIG is not
bypassable by them, but the owner cannot be removed from those powers
without a further reviewed change (upstream limitation, tracked in the
W01 findings F-03/F-04).

Tests: test-forge/ForgeLaunchAuth.t.sol (17 adversarial cases),
test-forge/ForgeLifecycle.t.sol (unauthorized launch refused at the
factory; nonce replay refused; deployer bypass refused).

## 3. New Forge contracts (additive — no upstream code modified)

| Contract | Role |
| --- | --- |
| `forge/IForgeLaunchAuthorizer.sol` | The M-ELIG interface (LaunchIntent, requireAuthorizedLaunch, nonce views) |
| `forge/ForgeLaunchAuthorizer.sol` | On-chain verifier: EIP-712 dual-signature enforcement (creator consent + Forge eligibility attestation, keys MUST differ), per-creator nonces, factory one-time wiring, MAX_ATTESTATION_AGE freshness, registry-binding freshness, governance-only authority rotation with revocation-only kill switch |
| `forge/ForgeBindingRegistry.sol` | Public evidence ledger: canonical numeric GitHub repo id → creator wallet, authority-signed relayable ops with bounded validity, per-binding expiry + revocation, canonical-id-stable renames, force-revoke semantics; Correction B: hash-chained per-repo op log (exact next sequence + parent digest), `invalidatePendingOps` finality barrier, per-repo `bindingEpoch` signed into eligibility attestations |

## 4. Vendored dependency additions (contractsV2-deployed/lib)

The Forge authorizer/registry need OpenZeppelin cryptography and ERC-721
files absent from the verified factory package. Added, each pinned
byte-identical to **OpenZeppelin Contracts v5.0.0** (the version the
deploy-time tree itself vendors — confirmed by the `last updated v5.0.0`
headers of the package's own files):

- `utils/cryptography/ECDSA.sol`, `EIP712.sol`, `MessageHashUtils.sol`
- `utils/ShortStrings.sol`, `utils/Strings.sol`, `utils/Address.sol`,
  `utils/Multicall.sol`, `utils/math/SignedMath.sol`
- `interfaces/IERC5267.sol`
- `token/ERC721/ERC721.sol`, `IERC721.sol`, `IERC721Receiver.sol`,
  `extensions/IERC721Metadata.sol`, `extensions/ERC721URIStorage.sol`
- `utils/introspection/ERC165.sol`
- `lib/forge-std` (v1.17.0 submodule content, test infrastructure only)

## 5. Build configuration (foundry.toml)

Two new profiles, both pinned to the deploy-time toolchain
(solc 0.8.35, cancun, via_ir, 200 runs, ipfs metadata):

- `[profile.deployed]` — compiles the recovered tree as-is (parity
  evidence profile).
- `[profile.forge]` — compiles the Forge-owned stack + W02 tests.

The W01 profiles (`default` canary, `testable`, `v1`) are unchanged.

## 6. Script

`script/DeployForgeW02.s.sol` — local/test deployment of the full stack
(mini V4 legs for lifecycles; production V4 addresses are a W03+ concern
pending independent review). Never pointed at Robinhood mainnet.

## 7. W03 Correction A — EIP-170 deployability (W02-SIZE-01)

**Problem.** The Forge factory's runtime (forge profile: solc 0.8.35, via-IR,
200 runs, cancun, ipfs metadata) was **25,963 B**, above the EIP-170 limit of
**24,576 B** (excess 1,387 B), so it could not be deployed to any standard
EVM chain. The deploy-time PONS factory compiles to 24,177 B; M-ELIG added
1,786 B. W02's Foundry suites never deployed it under the limit.

**Options evaluated (measured, same compiler profile):**

| Option | Factory runtime | Result |
| --- | --- | --- |
| A. optimizer runs 100 / 50 / 20 / 1 | 25,899 / 25,857 / 25,851 / 25,848 B | insufficient (≤115 B) |
| A. `optimizer_details.inliner = false` | 25,928 B | insufficient |
| B. drop `previewLaunchEconomics` (view) | 25,681 B | insufficient alone; not applied (W03/creators depend on it) |
| B. drop exemption sort only | 25,763 B | insufficient alone |
| **C. calldata-forwarding authorization (applied)** | **24,470 B** | **106 B under the limit** |

Compiler settings are **unchanged** (no optimizer-induced change is claimed
as parity; the forge profile never claimed bytecode parity with PONS).

**Change (C).** Eligibility *verification* moves entirely into
`ForgeLaunchAuthorizer`; *enforcement* stays in the factory exactly where it
was:

- `PonsV2LaunchFactory._launchToken` (private, below every entry point,
  before any state change or deployment) now calls
  `launchAuthorizer.requireAuthorizedLaunchCall(msg.data, originalDeployer, economics)`
  instead of assembling the `LaunchIntent` itself. Removed from the factory:
  `_canonicalExemptionHash`, `_EMPTY_EXEMPTION_HASH`, the `exemptionListHash`
  parameter of `_launchToken`, and the now-unused `InvalidExemptionAddress`
  error. No other factory line changed; the exemption list the factory
  applies (`_exemptFromSnipeTax`) is the same calldata the authorizer
  verifies.
- `ForgeLaunchAuthorizer.requireAuthorizedLaunchCall` (factory-only)
  decodes the factory's own calldata by selector — `launchToken(TokenParams,uint256,address)`,
  `launchToken(TokenParams,uint256,address,address[])`,
  `launchTokenFor(TokenParams,uint256,address,address,address[])` — and
  reverts `UnknownLaunchEntry` for anything else. For `launchTokenFor` the
  decoded `originalDeployer` must equal the attributed creator. It rebuilds
  the intent with the identical derivations the factory used (raw metadata
  hash `keccak256(abi.encode(name, symbol, logo, description, socials))`,
  effective fee recipient `creatorFeeRecipient == 0 ? creator : creatorFeeRecipient`,
  canonical exemption hash moved verbatim as public `canonicalExemptionHash`)
  and runs the **single** verification path `_authorize`.
- `requireAuthorizedLaunch(LaunchIntent, ...)` is kept, unchanged in
  behaviour, as a thin wrapper over the same `_authorize` (all 17 W02 M-ELIG
  adversarial tests run against it unmodified).
- `_authorize` reads the 81-byte attestation payload from memory
  (`mcopy` of the 65-byte signature) instead of calldata slices; the length
  check, field order and every time/epoch/signer check are unchanged.

**Unchanged:** bonding-curve maths, supply, graduation economics, fee
accounting, fee policy, owner powers (F-03/F-04), the EIP-712 domains and
type strings, the consent digest a creator signs (proven by
`test_calldata_path_binds_same_digest_as_struct_path` and the W03
randomized parity suite), `contractsV2-deployed/` and all provenance. No
delegatecall, proxy or upgrade authority introduced.

**Evidence.** `test-forge/ForgeLaunchCall.t.sol` (EIP-170 bound, factory-only
entry, unknown/short selectors, forwarder entry point, deployer
substitution, exemption reorder/tamper, canonical-hash rules, struct-path
digest equivalence, metadata tamper on every entry point) plus the
unchanged W02 suites (ForgeLaunchAuth 17, lifecycle, snipe tax) and W01
regression. W03 runs every integration and browser test on a **standard**
Anvil (EIP-170 enforced) and CI enforces `pnpm size:check` (all Forge
runtimes ≤ 24,576 B, factory margin ≥ 64 B).

The security lint baseline gains one reviewed pin:
`require-revert-in-loop` on the zero-address refusal inside the bounded
canonical-exemption loop (moved verbatim from the factory).

## 8. W04 — economics, revenue distribution & treasury (sandbox)

**No existing financial contract was modified.** `PonsV2LaunchFactory` (24,470 B), the curve, hook, escrow, vault, deployer, executor and locker, `contractsV2-deployed/` and all provenance are byte-for-byte unchanged.

**Additions (Forge-owned, external):**
- `contractsV2-forge/src/v2/forge/ForgeProtocolRevenueSplitter.sol` (6,383 B runtime at W04; 10,862 B after Correction A, §8a).
  - It is the escrow key the hook's `protocolFeeRecipient` names. It claims only its own `PonsV2FeeEscrow` balance and allocates the measured receipt: 2/3 to the treasury, 1/3 to the FINCO reserve, with cumulative-floor rounding.
  - It separates non-revenue: the launch fee, direct transfers, rescues and graduation residual.
  - The treasury recipient is timelocked. The reserve has no exit (`FINCO_BURN_ENABLED` is a constant `false`).
  - Design and limits: `docs/W04-ECONOMICS-ARCHITECTURE.md`.
- `contractsV2-forge/src/v2/forge/IFincoBurnReserveExecutor.sol`: an architectural interface only, not implemented or referenced.

**Sandbox wiring (apps/forge-web/scripts/sandbox-lib.ts):**
- The sandbox deploys the canonical `PonsV2FeeEscrow`, replacing W02's `MockFeeEscrow`, so escrow events and claim semantics are real.
- It deploys the splitter, names it as the hook's `protocolFeeRecipient` in the hook constructor (before any launch), and wires `splitter.setForgeFactory(factory)`.
- The treasury recipient is the test-only Anvil key #8.

**Test-only mocks:**
- `test-forge/mocks/FeeOnTransferToken.sol`
- `test-forge/mocks/SandboxSwapRouter.sol`: an exact-input router for the W02 mini pool manager, so sandbox E2E can trade a graduated pool through the real hook. It is never part of any deployable stack.

**Evidence:**

| Suite | Tests |
| --- | --- |
| `test-forge/ForgeRevenueSplitter.t.sol` (unit and fuzz) | 19 |
| `ForgeRevenueSplitterInvariantTest` | 3 invariants |
| `test-forge/ForgeRevenueLifecycle.t.sol` (real stack, canonical escrow) | 7 |
| W04 integration (`economics.test.ts`) | 13 |
| Ledger unit tests | 7 |
| Browser E2E (`w04-economics.spec.ts`) | 1 |

The security-lint baseline gains 10 reviewed W04 pins: the balance-delta measurement around the canonical escrow, uint64 timelock casts, timelock timestamps, and native sends limited to the treasury recipient. The two remaining W04 warnings were fixed in code: modifier order, and emitting events before transfers.

### 8a. W04 Correction A — financial provenance, claim integrity, asset authority

**Still no existing financial contract modified.** Only the Forge-owned `ForgeProtocolRevenueSplitter` changed (6,383 → 10,862 B runtime; the factory is unchanged at 24,470 B). The canonical escrow, curve, hook, vault, executor, PONS sources, curve pricing, V4 fee math, graduation math, creator tax and buyback vesting are untouched.

- **P1 — revenue provenance:** `pullRevenue` is bounded by a per-asset cumulative `eligibleCeiling`, raised only by an EIP-712 `EligibleRevenue` authorization from a separate, timelocked, instantly revocable `revenueAttestor`, with an on-chain `blockhash` check of the evidence block. The constructor gains a fourth argument (`revenueAttestor_`). `RevenueAllocated` gains `escrowClaimed`. New events: `EligibleRevenueAuthorized` and `RevenueAttestor*`. Design and trust boundary: `docs/W04-ECONOMICS-ARCHITECTURE.md` §2a.
- **P2 — claim attestation:** `recordClaimSubmission` verifies the decoded transaction contents and requires the canonical indexed claim event. `fin_claim_submissions` (migration 003, unreleased, edited in place) gains `chain_id`, `target`, `selector`, `nominal_amount` and `contents_verified_at`.
- **P3 — asset authority:** `setAssetApproved` requires the wired factory's `approvedPairTokens`, non-zero `pairTokenEconomics` and a matching `decimals()`.
- **Backend:** `finance/attestor.ts` (sandbox attestor service, run by the worker after indexing), `finance/claims.ts` (claim content verification), provenance statuses in the treasury report, and attestor role and status in governance. Config adds the optional `FORGE_REVENUE_ATTESTOR_PRIVATE_KEY` (local-test custody only) and `REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED = false`. The sandbox uses Anvil key #4 as the attestor.
- **Test-only mock:** `test-forge/mocks/MockQuotePolicyFactory.sol`.
- **Lint baseline:** the `RevenueAllocated` and `expiresAt` anchors are re-pinned to the new source text. Two pins are added: the attestation deadline timestamp, and the `EligibleRevenueAuthorized` emit after the ecrecover precompile. An `unused-return` on `pairTokenEconomics` was fixed in code by also requiring a non-zero `graduationThreshold`.

| Suite | Tests after Correction A |
| --- | --- |
| `test-forge/ForgeRevenueSplitter.t.sol` (unit and fuzz) | 35 |
| `ForgeRevenueSplitterInvariantTest` | 3 invariants (2,048 calls per run, including third-party credits and over-pull attempts) |
| `test-forge/ForgeRevenueLifecycle.t.sol` | 8 |
| W04 integration (`economics.test.ts`) | 30 |
| Ledger, provenance and claim unit tests | 11 |
| Browser E2E (`w04-economics.spec.ts`) | 1 |

## 9. W05 — production hardening, governance and beta readiness

Only one contract file changed: `ForgeProtocolRevenueSplitter.sol` (Forge-owned) — strictly sequential attestation nonce, new error `CeilingExceedsEscrow` (ceiling ≤ escrow claimed + held), and a non-zero `graduationThreshold` check in `setAssetApproved` (finding W05-01). plus ArbSys-aware evidence block/hash reads (finding W05-05, measured on the real 4663 RPC). Runtime 11,501 B at W05 (11,680 B after Correction A, see 9a); factory unchanged at 24,470 B. No PONS/deployed-source evidence, escrow, hook, curve, factory or vendored code modified. New: migrations 004 (signer audit), 005 (ledger materialization), 006 (ops controls); forge tests `W05OwnerPowers`, `W05AttestorCompromise`; docs `W05-*`; `.github/workflows/w05.yml`; `release/`. Flags unchanged.

### 9a. PR #5 Correction A

`ForgeProtocolRevenueSplitter.revokeRevenueAttestor()` now (1) discards `pendingRevenueAttestor`, (2) pauses pulls and (3) emits `EmergencyRevocation` (new event; ABI regenerated); runtime 11,680 B, factory unchanged at 24,470 B. No other contract changed. Off-chain: `SignerRegistry` re-reads authoritative on-chain state on every signing request; the release gate gains deferred (NOT VERIFIED) Class A items and the `EVIDENCE_INCOMPLETE` state; Robinhood evidence is split into `A07a/A07b/A07c/A07e` and `B09`.
