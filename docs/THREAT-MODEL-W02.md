# W02 Threat Model & Risk Register — Forge-owned stack

Scope: the Forge-owned launch path implemented in W02 (Forge factory with
M-ELIG, ForgeLaunchAuthorizer, ForgeBindingRegistry, deploy-time financial
contracts unchanged). Threat categories and bypass vectors from the W02
mission, with the test evidence for each.

## 1. Bypass-vector closure table

| # | Vector | Closure | Test |
| --- | --- | --- | --- |
| 1 | Direct factory calls without authorization | `requireAuthorizedLaunch` sits inside `_launchToken` before any state change; no signatures → ECDSA zero-length revert | `ForgeLifecycle.test_unauthorized_launch_reverts_at_factory`, `Auth.b1` |
| 2 | Alternative factory entry points | All three `launchToken` overloads + `launchTokenFor` funnel through the same `_launchToken`; the check runs below every entry point | `Auth.b1–b3` + `Lifecycle` (exemption overload is the one the lifecycle drives) |
| 3 | Forwarders and relayers | `launchTokenFor` still requires the owner-set forwarder; M-ELIG binds the ORIGINAL deployer's consent, so a relayed launch still needs that wallet's signature | `Auth` suite (factory binding) + `Lifecycle` |
| 4 | Reused signatures | Per-creator strictly-increasing nonce consumed inside the authorization; replay reverts `CreatorNonceStale` | `Auth.b4`, `Lifecycle.test_nonce_reuse_second_launch_reverts` |
| 5 | Wrong chain | EIP-712 domain includes `block.chainid`; signatures do not cross chains | `Auth.b5` |
| 6 | Wrong factory | Authorizer one-time `setForgeFactory` binding + intent.factory binding, both enforced | `Auth.b2, b3` |
| 7 | Expired authorizations | Consent `expiresAt` + attestation `expiresAt` + `MAX_ATTESTATION_AGE` freshness | `Auth.b6, b15` |
| 8 | Revoked repository binding | Registry `isActive(repoId, creator)` freshness-checked at launch; revoke cuts launches immediately | `Auth.b7, b8, b16` |
| 8a | Previously issued registry op reactivates a revoked/transferred binding (Correction B) | Hash-chained per-repo op log: `opNonce` must equal `opSequence + 1` AND `parentOpDigest` must equal the current `headOpDigest`. Any op issued against an earlier head is dead whatever its nonce (gapped future nonces, the exact next nonce, and fully pre-signed chains alike); `invalidatePendingOps` (authority or governance, revocation-only) revokes and moves the head to an unpredictable barrier, killing every outstanding signature at once | `Auth.cb1–cb4`, property `Auth.testFuzz_cb8` |
| 8b | Pre-revocation eligibility attestation reused after a re-bind (Correction B) | Attestations are signed over the registry's `bindingEpoch` (incremented on every bind); the authorizer reads the current epoch, so an attestation from an earlier generation never verifies — even for a re-bind of the same creator | `Auth.cb5, cb6` |
| 9 | Revoked eligibility authority | `setEligibilityAuthority(0)` bricks ALL launches (revocation-only kill switch); re-enable is owner-gated and emitted | `Auth.b9` |
| 10 | Unauthorized wallets | Attestation binds (repoId, creator); registry binding must name the same creator | `Auth.b10, b16` |
| 11 | Malicious administrator configurations | The authority address is immutable in the factory and the check is not owner-bypassable; whitelist/launch-enabled owner switches do NOT satisfy M-ELIG (they gate `canLaunch`, which runs before but cannot replace the authorizer call) | `Auth` suite + MODIFICATION-REGISTER §2 |
| 12 | Single-key self-authorization | Creator signature and attestation MUST recover to different addresses | `Auth.b11` |
| 12a | Changed creator tax after signing | Effective creatorTaxBps is hashed into the consent digest; any mutation reverts | `Auth.r6` |
| 12b | Exemption list mutation (add/remove/substitute) | Canonical sorted-list hash bound in the consent; reordering accepted by design (order is semantically irrelevant), all other mutations revert | `Auth.r7, r7b` |
| 12c | Forwarder mutates signed exemptions | Canonical hash computed and bound BEFORE deployment in every entry point incl. launchTokenFor; forwarder cannot alter it | `Lifecycle` + factory code path |
| 13 | Metadata/economics re-peg after signing | Consent digest binds effective metadata (incl. fee recipient, buyback flag) AND the live economics digest; any change re-verifies against a different digest and reverts | `Auth.b12, b13` |
| 14 | Forged attestations | Attestation must recover to the authority key | `Auth.b14` |
| 15 | Factory/chain substitutions | Domain binds authorizer address + chain; factory binding is one-time | `Auth.b2, b3, b5` |
| 16 | Deployer bypass (direct deployLaunch) | Deployer is `onlyFactory`; CREATE2 salt namespacing is per original deployer | `Lifecycle.test_direct_deployer_bypass_blocked` |

## 2. Financial invariants (Phase 5)

Covered by `ForgeLifecycle.test_full_lifecycle_launch_to_graduation` over
the real stack:

- Reserve conservation: curve trackedQuote/trackTokokens drain to exactly
  zero at graduation; no stray ETH on the curve.
- Token supply conservation: every token accounted for across pool, locker
  balance, escrow, hook (equals its pending entries), vault and holders;
  ≤ minted supply.
- Locker withdrawal restrictions: locker holds the position NFT; no
  withdrawal function exists (upstream-verified, unchanged).
- Fee escrow liabilities: escrow balances credited on sweep, claimable per
  the published interface.
- Partial fills and refunds: the crossing buy clamps at the sellable
  allocation and refunds (deploy-time behavior, unchanged).
- Graduation retries: two-phase (Swept → PoolCreated) permissionless retry
  (deploy-time behavior, unchanged).
- Reentrancy: deploy-time guards unchanged (curve/hook/vault/escrow all
  nonReentrant on the value paths; verified in W01's suites over the same
  sources).
- Fee-on-transfer / decimal normalization / slippage: covered by the W01
  suite (`test/PonsV2BondingCurve.t.sol`) over identical curve source.
- MEV/anti-snipe: deploy-time launch-second tax verified
  (`ForgeSnipeTaxTest`): creator exempt, 99% launch-second tax on snipers,
  exponential decay to untaxed after the window.
- V4 callback validation: the hook's `unlockCallback` is reachable only via
  the PoolManager's unlock (mini-manager dispatch mirrors v4-core; W01 hook
  suite covers the trust boundary).
- Signature malleability: OZ ECDSA (v5.0.0) rejects high-s values and the
  cross-signed malleability case; digests are typed-structure hashes.

## 3. F-03 / F-04 review against the Forge-owned deployment

W01 findings F-03 (owner can redirect any launch's creator fees after a
3-day timelock) and F-04 (owner rescue paths) exist in the deploy-time
factory/hook/escrow and are carried into the Forge-owned deployment
UNCHANGED (this workflow does not modify custody behavior without
independent review, per the mission).

Disposition for the Forge-owned stack:

- M-ELIG is orthogonal: owner powers operate on fee ROUTING and RESCUE, not
  on launch AUTHORIZATION. The owner cannot mint launches, cannot bypass
  the eligibility gate, and cannot mint or burn supply.
- The Forge owner is FINCO governance (not PONS), under FINCO's operational
  control; the timelock on fee-recipient overrides provides community
  notice exactly as upstream designed.
- Minimal scoped remediation prepared (not applied): `FORGE-CHANGE-MAP.md`
  §6 fee-policy authority work and a potential owner-power narrowing are
  deferred to W04 with independent review, as the mission requires.

## 4. Remaining trust dependencies

1. Forge governance key (factory/hook/vault/locker owner): timelocked
   multisig required before any real deployment; powers per F-03/F-04.
2. Forge eligibility authority key: single EOA in W02 test fixtures; W03+
   must operate it from an HSM/KMS-backed service with rotation runbooks.
   The on-chain rotation is two contracts rotated in one governance batch
   (registry + authorizer).
3. GitHub App attestation service: out of scope (W03); W02 uses
   deterministic test fixtures signing with the authority key against the
   REAL on-chain verifier — no mock replaces on-chain verification.
4. Uniswap V4 production addresses: W02 lifecycles use mini mocks; wiring
   the production PoolManager/PositionManager/Permit2 on 4663 is a W03+
   step requiring its own integration review (the financial contracts are
   agnostic — they take the addresses as constructor/wiring arguments).
5. External audit: the Forge-owned stack (factory M-ELIG diff, authorizer,
   registry) must be independently audited before any mainnet use, together
   with the recovered-source parity evidence (docs/W02-SOURCE-RECOVERY.md).
6. Eligibility-stack lint posture (Correction B): the COMPLETE
   `forge lint --json` output is parsed by `scripts/check-security-lint.pl`
   (no regex prefilter). Error-level findings, malformed output, unknown
   levels and any warning not pinned in `scripts/security-lint-baseline.tsv`
   fail the gate. Each pin names the code, file, the exact flagged source
   text and an exact count, with a reviewed rationale (timestamp windows,
   precompile-only "reentrancy-events", uint64 timestamp casts, the
   kill-switch zero address, two event-ordering false positives and the
   barrier's prior-blockhash use). Changing flagged code or leaving a pin
   unmatched fails the gate. Every approved finding is printed in the CI
   log and uploaded with the raw JSON (`w02-lint-evidence`). Parser
   negative fixtures: `scripts/test-security-lint-gate.sh` (S1–S16).

## 5. Risk register additions

| ID | Severity | Finding |
| --- | --- | --- |
| W02-R1 | Medium | Authorizer + registry key rotation is a two-contract governance batch; a partial rotation leaves one contract on the old key (monitoring requirement). |
| W02-R2 | Low | MAX_ATTESTATION_AGE (3 days) bounds attestation freshness; a repo bound but unattested for >3 days re-attests through the backend — liveness dependency on the W03 service. |
| W02-R3 | Low | Registry binding expiry (30 days in fixtures) requires periodic re-binding; expiry only ever tightens access. |
| W02-R5 | Low | Correction B: two ops issued against the same head are mutually exclusive, so an attacker holding a leaked-but-valid pending op can front-run one authority revoke op. `invalidatePendingOps` is a direct call that does not depend on the head, so front-running it cannot defeat it: whatever lands first, the barrier then revokes the active binding and kills every remaining signature. It is the operational revocation path; the backend must never sign ahead of the on-chain head. |
| W02-R4 | Informational | The recovered tree reveals the "RobinFunFi" naming lineage (docs/W02-SOURCE-RECOVERY.md §4); no code impact. |
