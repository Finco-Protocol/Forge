// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/**
 * @title IForgeLaunchAuthorizer
 * @notice On-chain eligibility authority for the Forge-owned factory
 * (blueprint change M-ELIG). Enforces the invariant:
 *
 *   NO token can be launched through the Forge factory without valid
 *   authorization from the approved Forge eligibility authority.
 *
 * The authorization has two independent, non-interchangeable layers:
 *
 *  1. CREATOR CONSENT — an EIP-712 `LaunchAuthorization` signed by the
 *     creator's own wallet over the exact launch contents (metadata hash,
 *     economics digest, salt, config id, pair token, repo id, expiry,
 *     nonce, chain id, authorizer address). A wallet signature alone never
 *     authorizes anything.
 *  2. ELIGIBILITY ATTESTATION — an EIP-712 `EligibilityAttestation` signed
 *     by the Forge eligibility authority key binding the GitHub repository
 *     id to the creator wallet until an expiry, fresh at launch time.
 *
 * The two signatures MUST come from two different addresses; a single key
 * signing both is rejected.
 */
interface IForgeLaunchAuthorizer {
    /// @notice A launch's full contents as seen by the Forge factory. The
    /// metadata hash covers every field that shapes the launched token;
    /// the economics digest binds the factory's launch configuration and
    /// the live fee policy (the factory's own `previewLaunchEconomics`
    /// preimage), so an owner re-peg invalidates outstanding authorizations
    /// instead of silently repricing them.
    struct LaunchIntent {
        address factory;        // Forge factory that will execute the launch
        address creator;        // wallet that signs the consent and receives attribution
        uint64 githubRepoId;    // canonical GitHub repository id
        uint256 launchConfigId; // factory launch configuration index
        address pairToken;      // quote asset (address(0) = native ETH)
        bytes32 tokenMetadataHash;
        bytes32 economicsDigest;
        bytes32 salt;           // CREATE2 salt passed to the factory
        uint64 expiresAt;       // consent deadline (unix seconds)
        uint64 nonce;           // per-creator monotonically increasing nonce
    }

    /// @notice Reverts unless the launch described by `intent` carries a
    /// valid creator consent and a valid, fresh eligibility attestation.
    /// Called from every Forge factory launch entry point. The economics
    /// digest inside `intent` is the factory's live launch-economics
    /// preimage (see the factory's `previewLaunchEconomics`).
    /// @param creatorFeeRecipient The fee recipient the factory will record
    /// (defaults to the creator); part of the bound metadata.
    /// @param buybackEnabled The launch's initial buyback flag; part of the
    /// bound metadata.
    /// @param creatorSignature The creator's EIP-712 LaunchAuthorization
    /// signature (65 bytes).
    /// @param attestationSignature The authority attestation payload:
    /// abi.encodePacked(uint64 issuedAt, uint64 expiresAt, bytes65 sig).
    function requireAuthorizedLaunch(
        LaunchIntent calldata intent,
        address creatorFeeRecipient,
        bool buybackEnabled,
        bytes calldata creatorSignature,
        bytes calldata attestationSignature
    ) external;

    /// @notice The current eligibility authority key.
    function eligibilityAuthority() external view returns (address);

    /// @notice Whether `nonce` has been consumed for `creator`.
    function nonceUsed(address creator, uint64 nonce) external view returns (bool);
}
