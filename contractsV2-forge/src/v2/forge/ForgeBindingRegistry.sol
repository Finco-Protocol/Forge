// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/**
 * @title ForgeBindingRegistry
 * @notice Public evidence ledger binding canonical GitHub repository ids to
 * creator wallets, written only by the Forge eligibility authority key.
 * The registry itself does NOT enforce launches (the ForgeLaunchAuthorizer
 * does); it exists so that
 *
 *   - every (repoId, creator) binding is publicly auditable on chain,
 *   - a binding can be revoked the moment it stops being true (repo
 *     transfer, admin loss, App uninstall), and
 *   - the authorizer can require that a launch's binding is still active,
 *     so revocation cuts off new launches immediately.
 *
 * Canonical identity is the numeric GitHub repository id. Owner logins and
 * full names are recorded as evidence only — a rename keeps the id (and
 * the binding), a transfer force-revokes it.
 */
contract ForgeBindingRegistry is EIP712, Ownable2Step {
    using ECDSA for bytes32;

    struct Binding {
        uint64 githubRepoId;
        address creator;
        address boundBy;        // authority key that wrote it
        uint64 boundAt;
        uint64 expiresAt;       // freshness horizon of the evidence
        uint64 revokedAt;       // 0 = active
        string repoFullName;    // evidence only; may go stale on rename
    }

    /// @notice A binding write/revocation signed by the eligibility
    /// authority, so registry transactions may be relayed by anyone.
    struct BindingOp {
        uint64 githubRepoId;
        address creator;
        uint64 expiresAt;
        uint64 opNonce;
        string repoFullName;
        bool revoke;
    }

    error InvalidSigner();
    error ExpiredOperation();
    error UnknownBinding();
    error AlreadyRevoked();
    error ZeroAddress();
    error ZeroRepoId();
    error StaleOperation();

    event Bound(
        uint64 indexed githubRepoId,
        address indexed creator,
        address indexed boundBy,
        uint64 expiresAt,
        string repoFullName
    );
    event Revoked(uint64 indexed githubRepoId, address indexed creator, address indexed revokedBy);
    event AuthorityUpdated(address indexed previous, address indexed current);

    /// @notice The eligibility authority key; sole writer of binding state.
    address public eligibilityAuthority;

    /// @notice Kept for interface compatibility: op validity upper bound is
    /// enforced off-chain by the authority signer (bindings carry their own
    /// evidence horizon via expiresAt).
    uint64 public constant MAX_OP_VALIDITY = 30 days;

    mapping(uint64 repoId => Binding binding) public bindings;
    mapping(bytes32 opDigest => bool used) public usedOps;

    bytes32 private constant BINDING_OP_TYPEHASH =
        keccak256(
            "BindingOp(uint64 githubRepoId,address creator,uint64 expiresAt,uint64 opNonce,string repoFullName,bool revoke)"
        );

    modifier onlyAuthority() {
        if (msg.sender != eligibilityAuthority) revert InvalidSigner();
        _;
    }

    constructor(address authority_) EIP712("FINCO Forge Binding Registry", "1") Ownable(msg.sender) {
        if (authority_ == address(0)) revert ZeroAddress();
        eligibilityAuthority = authority_;
    }

    /**
     * @notice Applies an authority-signed binding operation. Relayable: the
     * authority signs; anyone may submit. `expiresAt` is bounded so a
     * stolen signed op cannot be parked for later use.
     */
    function applyBindingOp(BindingOp calldata op, bytes calldata authoritySignature) external {
        if (op.expiresAt < block.timestamp) revert StaleOperation();
        bytes32 digest = _opDigest(op);
        if (usedOps[digest]) revert InvalidSigner();
        if (digest.recover(authoritySignature) != eligibilityAuthority) revert InvalidSigner();
        usedOps[digest] = true;

        Binding storage b = bindings[op.githubRepoId];
        if (op.revoke) {
            if (b.githubRepoId == 0) revert UnknownBinding();
            if (b.revokedAt != 0) revert AlreadyRevoked();
            b.revokedAt = uint64(block.timestamp);
            emit Revoked(op.githubRepoId, b.creator, eligibilityAuthority);
        } else {
            if (op.githubRepoId == 0) revert ZeroRepoId();
            if (op.creator == address(0)) revert ZeroAddress();
            bindings[op.githubRepoId] = Binding({
                githubRepoId: op.githubRepoId,
                creator: op.creator,
                boundBy: eligibilityAuthority,
                boundAt: uint64(block.timestamp),
                expiresAt: op.expiresAt,
                revokedAt: 0,
                repoFullName: op.repoFullName
            });
            emit Bound(op.githubRepoId, op.creator, eligibilityAuthority, op.expiresAt, op.repoFullName);
        }
    }

    /// @notice Whether (repoId, creator) currently has an active binding.
    /// Expired evidence counts as inactive: the authorizer requires fresh
    /// attestations anyway, so stale evidence never authorizes a launch.
    function isActive(uint64 repoId, address creator) public view returns (bool) {
        Binding storage b = bindings[repoId];
        return b.githubRepoId != 0 && b.revokedAt == 0 && b.creator == creator
            && b.expiresAt >= block.timestamp;
    }

    /// @notice Rotates the eligibility authority key (governance-gated).
    /// The ForgeLaunchAuthorizer must be rotated with the same transaction
    /// batch: both contracts carry their own copy of the key.
    function setEligibilityAuthority(address newAuthority) external onlyOwner {
        if (newAuthority == address(0)) revert ZeroAddress();
        emit AuthorityUpdated(eligibilityAuthority, newAuthority);
        eligibilityAuthority = newAuthority;
    }

    function _opDigest(BindingOp calldata op) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    BINDING_OP_TYPEHASH,
                    op.githubRepoId,
                    op.creator,
                    op.expiresAt,
                    op.opNonce,
                    keccak256(bytes(op.repoFullName)),
                    op.revoke
                )
            )
        );
    }

    /// @notice The typed digest for a binding operation (for off-chain
    /// signing tools and tests).
    function attestationDigestForBindingOp(
        uint64 githubRepoId,
        address creator,
        uint64 expiresAt,
        uint64 opNonce,
        bytes32 repoFullNameHash,
        bool revoke
    ) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(BINDING_OP_TYPEHASH, githubRepoId, creator, expiresAt, opNonce, repoFullNameHash, revoke)
            )
        );
    }
}
