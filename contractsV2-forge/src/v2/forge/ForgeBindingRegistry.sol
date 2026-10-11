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
 *
 * ── Operation sequencing (Correction A / P1-1) ───────────────────────────
 * Every repository carries a strictly-increasing operation sequence. An
 * authority-signed operation is valid ONLY if its `opNonce` is greater than
 * the repository's current sequence — any older signed operation (bind or
 * revoke) is permanently rejected once a newer one has been applied, so a
 * previously signed but unconsumed operation can never execute after a
 * later revocation, transfer, or re-binding. The digest replay guard
 * (`usedOps`) additionally blocks double-submission of the identical op.
 *
 * Deadlines are separated: `opDeadline` bounds how long the authority's
 * SIGNED OPERATION may sit before submission (tight, on-chain enforced);
 * `bindingExpiresAt` is the binding-evidence horizon (independent, longer).
 * A revocation applies ONLY to the binding whose creator it names — a
 * revoke naming a superseded creator is rejected.
 */
contract ForgeBindingRegistry is EIP712, Ownable2Step {
    using ECDSA for bytes32;

    struct Binding {
        uint64 githubRepoId;
        address creator;
        address boundBy; // authority key that wrote it
        uint64 boundAt;
        uint64 expiresAt; // binding-evidence horizon
        uint64 revokedAt; // 0 = active
        uint64 lastOpSeq; // highest applied operation sequence
        string repoFullName; // evidence only; may go stale on rename
    }

    /// @notice An authority-signed binding operation. `opNonce` must be
    /// strictly greater than the repository's current operation sequence.
    struct BindingOp {
        uint64 githubRepoId;
        address creator;
        uint64 bindingExpiresAt; // binding-evidence horizon
        uint64 opDeadline; // signed-op execution deadline (tight)
        uint64 opNonce; // per-repo monotonic operation sequence
        string repoFullName;
        bool revoke;
    }

    error InvalidSigner();
    error StaleOperation();
    error OperationDeadlineExceeded();
    error OperationDeadlineTooFar();
    error BindingHorizonTooFar();
    error NonceNotMonotonic();
    error UnknownBinding();
    error AlreadyRevoked();
    error RevokedCreatorMismatch();
    error ZeroAddress();
    error ZeroRepoId();
    error StaleBinding();

    event Bound(
        uint64 indexed githubRepoId,
        address indexed creator,
        address indexed boundBy,
        uint64 bindingExpiresAt,
        string repoFullName
    );
    event Revoked(uint64 indexed githubRepoId, address indexed creator, address indexed revokedBy);
    event AuthorityUpdated(address indexed previous, address indexed current);

    /// @notice The eligibility authority key; sole writer of binding state.
    address public eligibilityAuthority;

    /// @notice Maximum validity of an authority-signed operation: a signed
    /// op cannot be parked longer than this before submission.
    uint64 public constant MAX_OP_VALIDITY = 10 minutes;

    /// @notice Maximum horizon a binding's evidence may claim.
    uint64 public constant MAX_BINDING_HORIZON = 30 days;

    mapping(uint64 repoId => Binding binding) public bindings;
    mapping(bytes32 opDigest => bool used) public usedOps;

    bytes32 private constant BINDING_OP_TYPEHASH = keccak256(
        "BindingOp(uint64 githubRepoId,address creator,uint64 bindingExpiresAt,uint64 opDeadline,uint64 opNonce,string repoFullName,bool revoke)"
    );

    modifier onlyAuthority() {
        if (msg.sender != eligibilityAuthority) revert InvalidSigner();
        _;
    }

    constructor(address authority_)
        EIP712("FINCO Forge Binding Registry", "1")
        Ownable(msg.sender)
    {
        if (authority_ == address(0)) revert ZeroAddress();
        eligibilityAuthority = authority_;
    }

    /**
     * @notice Applies an authority-signed binding operation. Relayable: the
     * authority signs; anyone may submit. Fail-closed on stale, replayed,
     * out-of-order, over-long-deadline or horizon-violating operations.
     */
    function applyBindingOp(BindingOp calldata op, bytes calldata authoritySignature) external {
        // Operation deadline: independently enforced on both sides.
        if (op.opDeadline < block.timestamp) revert OperationDeadlineExceeded();
        if (op.opDeadline > block.timestamp + MAX_OP_VALIDITY) revert OperationDeadlineTooFar();
        if (op.bindingExpiresAt > block.timestamp + MAX_BINDING_HORIZON) {
            revert BindingHorizonTooFar();
        }
        if (op.revoke && op.githubRepoId == 0) revert ZeroRepoId();

        // Replay guard for the identical signed op.
        bytes32 digest = _opDigest(op);
        if (usedOps[digest]) revert InvalidSigner();

        // Monotonic per-repository sequencing: strictly increasing opNonce.
        // An older signed op is permanently rejected once any newer one has
        // been applied — the P1-1 reactivation vector is closed here.
        Binding storage b = bindings[op.githubRepoId];
        if (op.opNonce <= b.lastOpSeq) revert NonceNotMonotonic();

        if (digest.recover(authoritySignature) != eligibilityAuthority) revert InvalidSigner();
        usedOps[digest] = true;
        b.lastOpSeq = op.opNonce;

        if (op.revoke) {
            if (b.githubRepoId == 0) revert UnknownBinding();
            if (b.revokedAt != 0) revert AlreadyRevoked();
            // A revocation applies ONLY to the current binding's creator:
            // an old revoke signature naming a superseded creator (e.g.
            // after a transfer/re-bind) is rejected.
            if (b.creator != op.creator) revert RevokedCreatorMismatch();
            b.revokedAt = uint64(block.timestamp);
            emit Revoked(op.githubRepoId, b.creator, eligibilityAuthority);
        } else {
            if (op.githubRepoId == 0) revert ZeroRepoId();
            if (op.creator == address(0)) revert ZeroAddress();
            if (op.bindingExpiresAt < block.timestamp) revert StaleBinding();
            bindings[op.githubRepoId] = Binding({
                githubRepoId: op.githubRepoId,
                creator: op.creator,
                boundBy: eligibilityAuthority,
                boundAt: uint64(block.timestamp),
                expiresAt: op.bindingExpiresAt,
                revokedAt: 0,
                lastOpSeq: op.opNonce,
                repoFullName: op.repoFullName
            });
            emit Bound(
                op.githubRepoId,
                op.creator,
                eligibilityAuthority,
                op.bindingExpiresAt,
                op.repoFullName
            );
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

    /// @notice The repository's current operation sequence (last applied
    /// opNonce); the next authority-signed op must exceed it.
    function operationSequence(uint64 repoId) external view returns (uint64) {
        return bindings[repoId].lastOpSeq;
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
                    op.bindingExpiresAt,
                    op.opDeadline,
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
        uint64 bindingExpiresAt,
        uint64 opDeadline,
        uint64 opNonce,
        bytes32 repoFullNameHash,
        bool revoke
    ) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    BINDING_OP_TYPEHASH,
                    githubRepoId,
                    creator,
                    bindingExpiresAt,
                    opDeadline,
                    opNonce,
                    repoFullNameHash,
                    revoke
                )
            )
        );
    }
}
