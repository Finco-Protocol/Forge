# Launch authorization flow (W02 fixtures → W03 service)

1. Backend (W03: GitHub App) verifies the requesting account administers
   repo R; resolves the CANONICAL numeric repo id.
2. Backend writes the binding: ForgeBindingRegistry.applyBindingOp(op, sig)
   — op signed by the eligibility authority key (10-minute op validity,
   relayable).
3. Creator signs (EIP-712, domain "FINCO Forge Launch" v1 @ authorizer):
   LaunchAuthorization(factory, creator, githubRepoId, launchConfigId,
   pairToken, tokenMetadataHash, economicsDigest, salt, expiresAt, nonce).
4. Authority signs EligibilityAttestation(githubRepoId, creator, issuedAt,
   expiresAt). CANONICAL WIRE ENCODING (81 bytes):
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
