# W03 → W04 Handover — Verified Builder Platform

W03 delivers a functioning **sandbox** vertical slice (`apps/forge-web`) on top of the W02 protocol core. It does not make Forge launch-ready. This document lists what W04 (independent security review) and W05 (production activation) must still resolve.

## 1. Dependency and interface assumptions

| Item | Value | Source |
| --- | --- | --- |
| W02 base | `feat/forge-protocol-core-w02` @ `6d6ded8` (Correction B) | PR Finco-Protocol/Forge#2 (open, draft) |
| Registry EIP-712 | `EIP712("FINCO Forge Binding Registry","2")`, `BindingOp(uint64 githubRepoId,address creator,uint64 bindingExpiresAt,uint64 opDeadline,uint64 opNonce,bytes32 parentOpDigest,string repoFullName,bool revoke)` | `ForgeBindingRegistry.sol` |
| Op-chain | `opNonce == opSequence+1` **and** `parentOpDigest == headOpDigest`; epoch increments on every bind | Correction B |
| Authorizer EIP-712 | `EIP712("FINCO Forge Launch","1")`; `LaunchAuthorization(...12 fields...)`; `EligibilityAttestation(uint64 githubRepoId,address creator,uint64 bindingEpoch,uint64 issuedAt,uint64 expiresAt)`; attestation payload = 81 bytes | `ForgeLaunchAuthorizer.sol` |
| Effective metadata | `keccak256(abi.encode(tokenMetadataHash, creatorFeeRecipient, buybackEnabled, creatorTaxBps))` | authorizer `_metadataHash` |
| Exemption hash | sorted ascending (uint160), duplicates kept, zero refused, ≤ 32, `keccak256(abi.encode(address[]))` | factory `_canonicalExemptionHash` |
| Economics digest | 10-value preimage of `previewLaunchEconomics` | factory `_economicsDigest` |

All of these are machine-checked: `test/integration/eip712-parity.test.ts` compares W03's digests with the contracts' own view functions over randomized inputs; `pnpm abi:check` fails on any ABI drift from the W02 build. If W02 changes before merge, rebuild, regenerate ABIs and re-run these suites.

## 2. Blockers found during W03

### W02-SIZE-01 — Forge factory exceeds EIP-170 (new, HIGH, blocks any real deployment)

`PonsV2LaunchFactory` (forge profile, solc 0.8.35, via-IR, 200 runs) compiles to **25,963 bytes** of runtime code, above the **24,576-byte** EIP-170 limit. A standard EVM rejects the deployment, and Anvil does too unless run with `--disable-code-size-limit`. W02's Foundry suites never deploy it under the limit, so this went unnoticed. The recovered deploy-time factory (`forge build --profile deployed`) compiles to 24,177 bytes, identical to the live PONS factory, so the W02 M-ELIG changes add **1,786 bytes**.

- W03's sandbox, integration tests and E2E run Anvil with `--disable-code-size-limit`. This is labelled everywhere it applies, and `eip170` in the sandbox deployment manifest records it.
- Robinhood Chain is an Arbitrum Orbit chain. Whether its `MaxCodeSize` differs from 24 KB is **UNVERIFIED**. Do not assume it.
- W02/W04 must fix the size without changing financial behaviour (for example a library split, an optimizer-runs trade-off, or moving view helpers out), then re-run the W02 gates and the W03 suites. W03 deliberately did not modify W02.

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
3. `src/server/github/webhooks.ts` and `reconcile.ts`: revocation completeness. Note that a revocation **requires** the worker to land an on-chain revoke. Until it lands, an already-issued attestation (≤ `FORGE_ATTESTATION_TTL_SECONDS`, default 30 min) plus an already-signed consent could still execute. Lower the TTL or have governance call `invalidatePendingOps` for urgent cases.
4. `src/server/wallet/siwe.ts` and `session.ts`: session, CSRF, SIWE.
5. `src/server/indexer/*`: allowlist, finality, reorg handling.
6. `src/server/proof/ledger.ts`: the receipt schema and the proven-vs-attested split.

## 4. Merge plan

W03 is a **draft, stacked PR on `feat/forge-protocol-core-w02`**. After W02's normal merge into `main`, merge `origin/main` into the W03 branch (no rebase or force-push), re-run `forge build --profile forge`, `pnpm abi:check`, the parity suite and the full W03 CI, then retarget the PR to `main`. Do not merge W03 while W02 is open.
