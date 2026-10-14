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
