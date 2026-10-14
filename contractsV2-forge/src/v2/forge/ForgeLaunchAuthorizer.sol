// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IForgeLaunchAuthorizer} from "./IForgeLaunchAuthorizer.sol";
import {ForgeBindingRegistry} from "./ForgeBindingRegistry.sol";

/**
 * @title ForgeLaunchAuthorizer
 * @notice The on-chain eligibility authority enforcing blueprint change
 * M-ELIG on the Forge-owned factory:
 *
 *   NO token can be launched through the Forge factory without valid
 *   authorization from the approved Forge eligibility authority.
 *
 * Every Forge factory launch entry point funnels through the factory's
 * private `_launchToken`, which calls `requireAuthorizedLaunch` before any
 * state changes; the check is therefore structural, not a frontend
 * restriction, and factory-owner privileges cannot bypass it (the
 * authority requirement sits inside every launch path, and revoking the
 * authority key only BRICKS launches — it can never open them).
 *
 * Authorization has two independent, non-interchangeable layers, and the
 * two signatures MUST come from different keys:
 *
 *  1. CREATOR CONSENT — EIP-712 `LaunchAuthorization` signed by the
 *     creator's own wallet over the exact launch contents: effective
 *     metadata hash (including creatorFeeRecipient, buybackEnabled AND the
 *     effective creatorTaxBps), live economics digest, salt, config id,
 *     pair token, canonical anti-snipe exemption list hash, repo id,
 *     expiry, per-creator nonce, chain id and the authorizer address.
 *  2. ELIGIBILITY ATTESTATION — EIP-712 `EligibilityAttestation` signed by
 *     the Forge eligibility authority key, binding the GitHub repository id
 *     to the creator wallet under the registry's current binding epoch
 *     (Correction B). CANONICAL PACKED ENCODING (81 bytes):
 *     abi.encodePacked(uint64 issuedAt, uint64 expiresAt, bytes65 sig).
 *     Any other length is rejected.
 *
 * Additional enforcement: factory binding (msg.sender must be the one-time
 * wired Forge factory the intent names), active registry binding for
 * (repoId, creator), creator nonce freshness, attestation time validity
 * (issuedAt ≤ now, issuedAt ≤ expiresAt, expiry, ≤MAX_ATTESTATION_AGE
 * freshness — each enforced independently), and authority rotation
 * restricted to governance with an explicit revocation-only kill switch.
 */
contract ForgeLaunchAuthorizer is EIP712, Ownable2Step, IForgeLaunchAuthorizer {
    using ECDSA for bytes32;

    struct LaunchAuthorization {
        address factory;
        address creator;
        uint64 githubRepoId;
        uint256 launchConfigId;
        address pairToken;
        bytes32 tokenMetadataHash;
        bytes32 economicsDigest;
        bytes32 salt;
        uint64 expiresAt;
        uint64 nonce;
        uint16 creatorTaxBps;
        bytes32 exemptionListHash;
    }

    struct EligibilityAttestation {
        uint64 githubRepoId;
        address creator;
        uint64 bindingEpoch;
        uint64 issuedAt;
        uint64 expiresAt;
    }

    error InvalidCreatorSignature();
    error InvalidAttestationSignature();
    error SignaturesNotIndependent();
    error AuthorizationExpired();
    error AttestationExpired();
    error AttestationTooOld();
    error AttestationNotYetValid();
    error AttestationTimesInverted();
    error BadAttestationEncoding();
    error WrongFactory();
    error WrongCreator();
    error CreatorNonceStale();
    error BindingNotActive();
    error ZeroAddress();
    error AuthorityRevoked();
    error FactoryAlreadySet();

    event EligibilityAuthorityUpdated(address indexed previous, address indexed current);
    event FactorySet(address indexed factory);
    event LaunchAuthorized(
        address indexed creator,
        uint64 indexed githubRepoId,
        bytes32 metadataHash,
        bytes32 economicsDigest
    );

    /// @notice Longest-lived attestation the authority key may issue.
    uint64 public constant MAX_ATTESTATION_AGE = 3 days;

    /// @notice The Forge factory this authorizer serves. One-time wiring
    /// (the stack's standard pattern): once set it can never be changed, so
    /// the authorizer can never be reused against a different factory.
    address public forgeFactory;
    bool public factorySet;

    /// @notice The binding registry consulted for active (repoId, creator)
    /// evidence and revocation.
    ForgeBindingRegistry public immutable registry;

    /// @notice The eligibility authority key signing attestations. address(0)
    /// after revocation: launches become impossible, never unrestricted.
    address public eligibilityAuthority;

    /// @notice Per-creator strictly-increasing consent nonce.
    mapping(address creator => uint64 next) public nextCreatorNonce;

    bytes32 private constant LAUNCH_AUTHORIZATION_TYPEHASH = keccak256(
        "LaunchAuthorization(address factory,address creator,uint64 githubRepoId,uint256 launchConfigId,address pairToken,bytes32 tokenMetadataHash,bytes32 economicsDigest,bytes32 salt,uint64 expiresAt,uint64 nonce,uint16 creatorTaxBps,bytes32 exemptionListHash)"
    );
    bytes32 private constant ELIGIBILITY_ATTESTATION_TYPEHASH = keccak256(
        "EligibilityAttestation(uint64 githubRepoId,address creator,uint64 bindingEpoch,uint64 issuedAt,uint64 expiresAt)"
    );

    constructor(ForgeBindingRegistry registry_, address eligibilityAuthority_)
        EIP712("FINCO Forge Launch", "1")
        Ownable(msg.sender)
    {
        if (address(registry_) == address(0) || eligibilityAuthority_ == address(0)) {
            revert ZeroAddress();
        }
        registry = registry_;
        eligibilityAuthority = eligibilityAuthority_;
    }

    /// @notice One-time wiring of the Forge factory. Reverts on any second
    /// call; the binding is permanent for the authorizer's lifetime.
    function setForgeFactory(address forgeFactory_) external onlyOwner {
        if (factorySet) revert FactoryAlreadySet();
        if (forgeFactory_ == address(0)) revert ZeroAddress();
        factorySet = true;
        forgeFactory = forgeFactory_;
        emit FactorySet(forgeFactory_);
    }

    /// @inheritdoc IForgeLaunchAuthorizer
    function requireAuthorizedLaunch(
        LaunchIntent calldata intent,
        address creatorFeeRecipient,
        bool buybackEnabled,
        bytes calldata creatorSignature,
        bytes calldata attestationPayload
    ) external override {
        if (msg.sender != forgeFactory) revert WrongFactory();
        if (eligibilityAuthority == address(0)) revert AuthorityRevoked();

        // ── Layer 1: creator consent ─────────────────────────────────────
        // The consent digest binds the launch's effective metadata: the
        // factory records creatorFeeRecipient (defaulting to the creator),
        // buybackEnabled AND the effective creatorTaxBps on the launch
        // record, so all three are hashed alongside the TokenParams
        // metadata hash the factory computed. The canonical anti-snipe
        // exemption list hash and economics digest complete the binding.
        bytes32 metadataHash = _metadataHash(
            intent.tokenMetadataHash, creatorFeeRecipient, buybackEnabled, intent.creatorTaxBps
        );
        bytes32 consentDigest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    LAUNCH_AUTHORIZATION_TYPEHASH,
                    intent.factory,
                    intent.creator,
                    intent.githubRepoId,
                    intent.launchConfigId,
                    intent.pairToken,
                    metadataHash,
                    intent.economicsDigest,
                    intent.salt,
                    intent.expiresAt,
                    intent.nonce,
                    intent.creatorTaxBps,
                    intent.exemptionListHash
                )
            )
        );
        address consentSigner = consentDigest.recover(creatorSignature);
        if (consentSigner == address(0)) revert InvalidCreatorSignature();
        if (consentSigner != intent.creator) revert WrongCreator();
        if (intent.expiresAt < block.timestamp) revert AuthorizationExpired();
        if (intent.factory != forgeFactory) revert WrongFactory();
        // Replay protection: strictly-increasing per-creator nonce.
        if (intent.nonce != nextCreatorNonce[intent.creator]) revert CreatorNonceStale();
        nextCreatorNonce[intent.creator] = intent.nonce + 1;

        // ── Layer 2: eligibility attestation ─────────────────────────────
        // Canonical packed encoding: uint64 issuedAt, uint64 expiresAt,
        // bytes65 sig — exactly 81 bytes. Any other length is rejected.
        if (attestationPayload.length != 16 + 65) revert BadAttestationEncoding();
        uint64 issuedAt = uint64(bytes8(attestationPayload[0:8]));
        uint64 expiresAt = uint64(bytes8(attestationPayload[8:16]));
        // The attestation is bound to the repository's CURRENT binding
        // epoch (Correction B): an attestation issued under an earlier
        // binding generation — e.g. before a revocation and re-bind of the
        // same creator — never verifies. The epoch is read, not supplied.
        uint64 epoch = registry.bindingEpoch(intent.githubRepoId);
        bytes32 attestationDigest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ELIGIBILITY_ATTESTATION_TYPEHASH,
                    intent.githubRepoId,
                    intent.creator,
                    epoch,
                    issuedAt,
                    expiresAt
                )
            )
        );
        address attSigner = attestationDigest.recover(attestationPayload[16:]);
        if (attSigner == address(0)) revert InvalidAttestationSignature();
        if (attSigner == consentSigner) revert SignaturesNotIndependent();
        if (attSigner != eligibilityAuthority) revert InvalidAttestationSignature();
        // Each time property enforced independently:
        if (issuedAt > block.timestamp) revert AttestationNotYetValid(); // future-dated
        if (issuedAt > expiresAt) revert AttestationTimesInverted(); // inverted window
        if (expiresAt < block.timestamp) revert AttestationExpired(); // expired
        if (issuedAt + MAX_ATTESTATION_AGE < block.timestamp) revert AttestationTooOld(); // stale

        // ── Binding freshness: the repo must still belong to this creator ─
        if (!registry.isActive(intent.githubRepoId, intent.creator)) revert BindingNotActive();

        emit LaunchAuthorized(
            intent.creator, intent.githubRepoId, metadataHash, intent.economicsDigest
        );
    }

    /// @inheritdoc IForgeLaunchAuthorizer
    function nonceUsed(address creator, uint64 nonce) external view override returns (bool) {
        return nonce < nextCreatorNonce[creator];
    }

    /// @notice The effective metadata digest creators must sign over.
    function metadataDigest(
        bytes32 tokenMetadataHash,
        address creatorFeeRecipient,
        bool buybackEnabled,
        uint16 creatorTaxBps
    ) external pure returns (bytes32) {
        return _metadataHash(tokenMetadataHash, creatorFeeRecipient, buybackEnabled, creatorTaxBps);
    }

    /// @notice The typed consent digest for off-chain signing tools.
    function consentDigest(
        LaunchIntent calldata intent,
        address creatorFeeRecipient,
        bool buybackEnabled
    ) external view returns (bytes32) {
        bytes32 metadataHash = _metadataHash(
            intent.tokenMetadataHash, creatorFeeRecipient, buybackEnabled, intent.creatorTaxBps
        );
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    LAUNCH_AUTHORIZATION_TYPEHASH,
                    intent.factory,
                    intent.creator,
                    intent.githubRepoId,
                    intent.launchConfigId,
                    intent.pairToken,
                    metadataHash,
                    intent.economicsDigest,
                    intent.salt,
                    intent.expiresAt,
                    intent.nonce,
                    intent.creatorTaxBps,
                    intent.exemptionListHash
                )
            )
        );
    }

    /// @notice The typed attestation digest for the authority's signer.
    function attestationDigest(
        uint64 githubRepoId,
        address creator,
        uint64 bindingEpoch,
        uint64 issuedAt,
        uint64 expiresAt
    ) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ELIGIBILITY_ATTESTATION_TYPEHASH,
                    githubRepoId,
                    creator,
                    bindingEpoch,
                    issuedAt,
                    expiresAt
                )
            )
        );
    }

    /// @notice Rotates the eligibility authority key (governance-gated).
    /// Setting it to address(0) permanently revokes the authority and
    /// bricks ALL launches — an explicit kill switch, never a bypass.
    /// Must be rotated together with ForgeBindingRegistry in one batch.
    function setEligibilityAuthority(address newAuthority) external onlyOwner {
        emit EligibilityAuthorityUpdated(eligibilityAuthority, newAuthority);
        eligibilityAuthority = newAuthority;
    }

    function _metadataHash(
        bytes32 tokenMetadataHash,
        address creatorFeeRecipient,
        bool buybackEnabled,
        uint16 creatorTaxBps
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(tokenMetadataHash, creatorFeeRecipient, buybackEnabled, creatorTaxBps)
        );
    }
}
