# W03 → W04 Handover — Verified Builder Platform

W03 delivers a functioning **sandbox** vertical slice (`apps/forge-web`) on top of the W02 protocol core. It does not make Forge launch-ready. This document lists what W04 (independent security review) and W05 (production activation) must still resolve.

## 1. Dependency and interface assumptions

| Item | Value | Source |
| --- | --- | --- |
| W02 base | `main` @ `4800a79` (Finco-Protocol/Forge#2 **merged**; W02 head `6d6ded8`, Correction B) | merged into W03 by a normal merge commit |
| Registry EIP-712 | `EIP712("FINCO Forge Binding Registry","2")`, `BindingOp(uint64 githubRepoId,address creator,uint64 bindingExpiresAt,uint64 opDeadline,uint64 opNonce,bytes32 parentOpDigest,string repoFullName,bool revoke)` | `ForgeBindingRegistry.sol` |
| Op-chain | `opNonce == opSequence+1` **and** `parentOpDigest == headOpDigest`; epoch increments on every bind | Correction B |
| Authorizer EIP-712 | `EIP712("FINCO Forge Launch","1")`; `LaunchAuthorization(...12 fields...)`; `EligibilityAttestation(uint64 githubRepoId,address creator,uint64 bindingEpoch,uint64 issuedAt,uint64 expiresAt)`; attestation payload = 81 bytes | `ForgeLaunchAuthorizer.sol` |
| Effective metadata | `keccak256(abi.encode(tokenMetadataHash, creatorFeeRecipient, buybackEnabled, creatorTaxBps))` | authorizer `_metadataHash` |
| Exemption hash | sorted ascending (uint160), duplicates kept, zero refused, ≤ 32, `keccak256(abi.encode(address[]))` | authorizer `canonicalExemptionHash` (moved from the factory by Correction A) |
| Factory → authorizer | `requireAuthorizedLaunchCall(msg.data, originalDeployer, economicsDigest)` from `_launchToken`; the authorizer decodes the three factory entry points by selector | MODIFICATION-REGISTER §7 |
| Economics digest | 10-value preimage of `previewLaunchEconomics` | factory `_economicsDigest` |

All of these are machine-checked: `test/integration/eip712-parity.test.ts` compares W03's digests with the contracts' own view functions over randomized inputs; `pnpm abi:check` fails on any ABI drift from the W02 build. If W02 changes before merge, rebuild, regenerate ABIs and re-run these suites.

## 2. Blockers found during W03

### W02-SIZE-01 — Forge factory exceeded EIP-170 — **RESOLVED by W03 Correction A**

Before: `PonsV2LaunchFactory` (forge profile: solc 0.8.35, via-IR, 200 runs, cancun, ipfs metadata) was **25,963 B**, 1,387 B over the **24,576 B** EIP-170 limit; a standard Anvil rejected the deployment (reproduced). Compiler-only options were measured and are insufficient (runs=1: 25,848 B; inliner off: 25,928 B).

After: eligibility *verification* moved into `ForgeLaunchAuthorizer.requireAuthorizedLaunchCall` (the factory forwards its own calldata from `_launchToken`, below every entry point, before any state change); enforcement location, ordering and every check are unchanged; compiler settings unchanged. **Factory runtime 24,470 B (106 B margin); authorizer 8,127 B.** Exact diff and rationale: `docs/MODIFICATION-REGISTER.md` §7.

- All W03 integration and browser tests now run on a **standard** Anvil with EIP-170 enforced (an explicit test proves a 24,577 B runtime is rejected there). `--disable-code-size-limit` is no longer used anywhere.
- CI gate `pnpm size:check` fails on any Forge runtime > 24,576 B or factory margin < 64 B.
- Robinhood Chain 4663's limit is probed read-only in CI (`eth_estimateGas` of a 24,576 B vs 24,577 B creation); see the PR's exact-head CI for the observed result. No chain-specific exception is assumed.
- The 106 B margin is small. Further measured levers if future changes need room: optimizer runs 50 (−106 B), moving `previewLaunchEconomics` to a lens contract (−~280 B).

### Evidence classes (do not conflate)

| Class | Status |
| --- | --- |
| Source parity of the deploy-time PONS tree (`contractsV2-deployed/`) | proven by W02's parity gate; untouched by W03 |
| Forge-owned stack compiles, W01/W02 Foundry suites | passing (CI) |
| Functional sandbox (real W02 contracts on Anvil, mocked GitHub) | passing: acceptance 1–15, all negatives, Playwright |
| Standard-EVM deployability (EIP-170) | **proven on standard Anvil**; CI size gate |
| Robinhood 4663 read-only (V4 wiring, code-size limit probe) | CI job against the live public RPC |
| Production Uniswap V4 acceptance on 4663 | **NOT done** — no Forge stack deployed, no real-money pools |
| External security audit | **NOT done** — W04 |

### Other open items

| Id | Item | Owner |
| --- | --- | --- |
| F-03 / F-04 | Factory owner can redirect creator fees (3-day timelock) and use rescue hatches. These are shown to creators in the economics step and on project pages. | W04 review / governance |
| FEE-AUTH | `FORGE_FEE_POLICY_AUTHORITY_UNPROVEN`: fee-policy owner is not a proven governance authority | W04/W05 |
| KMS | No production `DigestSigner` (KMS/HSM) adapter exists. The local key is refused outside 31337/1337. | W05 + owner approval |
| GH-APP | No real GitHub App is registered for Forge yet. Permissions needed: Metadata (read), Contents (read); user authorization on install; webhook events listed in `apps/forge-web/README.md`. | FINCO operator |
| RH-V4 | Robinhood V4 addresses come from W02's 2026-10-08 live reads. W03's read-only CI job re-verifies them; this container's network policy blocked the RPC. | CI evidence |
| RH-QUOTE | No ERC-20 quote assets verified for a Forge factory on 4663 (none deployed) | W05 |
| HOOK | A production `PonsV2MemeHook` must be CREATE2-mined to the `0x2044` mask against the real PoolManager | W05 deployment |
| FINALITY | Production `FORGE_CONFIRMATIONS` and reorg window for Robinhood (Arbitrum Orbit; sequencer soft-finality vs L1 batch finality) must be chosen and documented | W05 |
| PG | Production requires PostgreSQL plus a separate `pnpm worker`. PGlite is sandbox/test only. | W05 |
| DEP | One moderate advisory remains (`decode-uri-component` via WalletConnect inside `@wagmi/connectors`, not imported by the app). High-severity advisories are pinned away via pnpm overrides. | W04 |
| LEGAL | Token-launch terms, disclaimers, jurisdictional review and creator ToS are not done. UI copy states that verification is not an audit, KYC or proof of legitimacy. | FINCO legal |
| PRIVATE | Policy defaults to public, non-fork repositories only. Allowing private repositories needs a disclosure decision, because Proof of Build would reference non-public code. | FINCO product |

## 3. Interface hand-off for W04 review

Highest-value review targets, in order:

1. `src/server/signer/policy.ts`: everything the authority key signs.
2. `src/server/github/verify.ts`: the two-source admin proof (user token plus installation view), identity cross-checks and policy.
3. `src/server/github/webhooks.ts`, `reconcile.ts`, `worker/index.ts`, `eligibility/registry-ops.ts`: revocation completeness (runbook §3.0). Off-chain refusal is immediate; on-chain revocation is a confirmed transaction landed by a priority-0, never-dropped job with alerts, an SLO on `/api/health`, and a watchdog that re-asserts a revocation reorged out of the chain. Residual risk: until that revoke confirms, an attestation issued *before* the revocation (≤ `FORGE_ATTESTATION_TTL_SECONDS`, default 30 min) plus a consent signed before it can still execute — a contract-level property. Governance can close it at once with `invalidatePendingOps`.
4. `contractsV2-forge/src/v2/forge/ForgeLaunchAuthorizer.sol` `requireAuthorizedLaunchCall` and the factory call site: the Correction A calldata decoding (selector set, `launchTokenFor` deployer binding, intent derivation parity).
5. `src/server/api/handlers.ts` `trustedClientIp`: trusted-proxy policy (runbook §4).
6. `src/server/wallet/siwe.ts` and `session.ts`: session, CSRF, SIWE.
7. `src/server/indexer/*`: allowlist, finality, reorg handling.
8. `src/server/proof/ledger.ts`: the receipt schema and the proven-vs-attested split.

## 4. Merge plan

W02 (Finco-Protocol/Forge#2) is merged. `origin/main` (`4800a79`) was merged into the W03 branch with a normal merge commit (no rebase/force-push) and PR #3 now targets `main`. W03 must not be merged until an independent final review approves it; production remains blocked regardless.
