# Launch authorization flow (W02 fixtures → W03 service)

1. Backend (W03: GitHub App) verifies the requesting account administers
   repo R; resolves the CANONICAL numeric repo id.
2. Backend writes the binding: ForgeBindingRegistry.applyBindingOp(op, sig)
   — op signed by the eligibility authority key (10-minute op validity,
   relayable). Correction B: the backend reads `operationSequence(repoId)`
   and `headOpDigest(repoId)` from chain and signs
   `opNonce = operationSequence + 1`, `parentOpDigest = headOpDigest`.
   It never signs ahead of the on-chain head. To revoke with finality,
   call `invalidatePendingOps(repoId)` directly from the authority key; this
   kills every outstanding signed op for the repo.
3. Creator signs (EIP-712, domain "FINCO Forge Launch" v1 @ authorizer):
   LaunchAuthorization(factory, creator, githubRepoId, launchConfigId,
   pairToken, tokenMetadataHash, economicsDigest, salt, expiresAt, nonce).
4. Authority signs EligibilityAttestation(githubRepoId, creator,
   bindingEpoch, issuedAt, expiresAt). `bindingEpoch` is
   `registry.bindingEpoch(repoId)` at signing time; it is NOT carried in
   the payload (the authorizer reads it on chain), so any later bind
   invalidates the attestation. CANONICAL WIRE ENCODING (81 bytes):
   abi.encodePacked(uint64 issuedAt, uint64 expiresAt, bytes65 sig).
   viem: serializeAbiParameters(["uint64","uint64","bytes"], [issuedAt, expiresAt, sig]).
   ethers: AbiCoder.defaultAbiCoder().encode(["uint64","uint64","bytes"], ...).
   The authorizer enforces: payload.length == 81, issuedAt <= block.timestamp,
   issuedAt <= expiresAt, expiresAt >= now, issuedAt + 3d >= now.
5. Launch transaction: factory.launchToken(TokenParams{..., githubRepoId,
   authorizationExpiresAt, authorizationNonce, creatorSignature,
   attestationPayload}, launchConfigId, pairToken).
6. On chain: requireAuthorizedLaunch verifies BOTH signatures (independent
   keys), consumes the creator nonce, checks factory/chain binding,
   attestation freshness (≤3 days) and registry binding freshness.

Test fixtures reproduce exactly this flow with deterministic keys against
the REAL verifier (test-forge/ForgeLaunchAuth.t.sol, ForgeLifecycle.t.sol).
