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
 * ── Revocation finality (Correction B) ───────────────────────────────────
 * Correction A required only `opNonce > lastOpSeq`, so an operation signed
 * with a HIGHER future nonce before a revocation stayed executable after
 * it and could reactivate a revoked or transferred binding. Every
 * repository now carries a linear, hash-chained operation log:
 *
 *   - `opNonce` must be EXACTLY `opSequence + 1` (no gaps, no skipping);
 *   - `parentOpDigest` must EQUAL the digest of the last applied operation
 *     (`headOpDigest`) — every signed operation names the exact state it
 *     was issued against.
 *
 * Applying any operation moves the head. Every operation issued against an
 * earlier head (whatever its nonce) is thereby permanently dead: the head
 * never returns to a previous value (digests cover the strictly increasing
 * sequence). An operation that is valid AFTER a revocation must name the
 * revocation's own digest as its parent, i.e. it was knowingly issued
 * after it. Two operations issued against the same head are mutually
 * exclusive: whichever lands first kills the other.
 *
 * `invalidatePendingOps` is the unconditional finality barrier: the
 * authority or governance revokes the active binding (if any) and moves
 * the head to a fresh barrier digest no signed operation can reference,
 * killing every outstanding signature for the repository at once. It can
 * only narrow eligibility, never grant it.
 *
 * ── Binding authorization epoch ──────────────────────────────────────────
 * `bindingEpoch` is the repository's binding generation: it increments on
 * EVERY applied bind (fresh bind, transfer, re-bind after revocation and
 * renewal alike). Eligibility attestations are signed over the epoch, so an
 * attestation issued for one generation can never authorize a launch under
 * a later one — including a re-bind of the same creator after revocation.
 *
 * Deadlines are separated: `opDeadline` bounds how long the authority's
 * SIGNED OPERATION may sit before submission (tight, on-chain enforced);
 * `bindingExpiresAt` is the binding-evidence horizon (independent, longer).
 * A revocation applies ONLY to the binding whose creator it names.
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
        uint64 epoch; // binding generation this record belongs to
        string repoFullName; // evidence only; may go stale on rename
    }

    /// @notice A repository's operation-log head and binding generation.
    struct RepoLog {
        uint64 opSequence; // number of operations applied (incl. barriers)
        uint64 bindingEpoch; // number of binds applied
        bytes32 headOpDigest; // digest of the last applied op or barrier
    }

    /// @notice An authority-signed binding operation. `opNonce` must equal
    /// the repository's `opSequence + 1` and `parentOpDigest` its current
    /// `headOpDigest`.
    struct BindingOp {
        uint64 githubRepoId;
        address creator;
        uint64 bindingExpiresAt; // binding-evidence horizon
        uint64 opDeadline; // signed-op execution deadline (tight)
        uint64 opNonce; // exact next per-repo operation sequence
        bytes32 parentOpDigest; // head the op was issued against
        string repoFullName;
        bool revoke;
    }

    error InvalidSigner();
    error OperationDeadlineExceeded();
    error OperationDeadlineTooFar();
    error BindingHorizonTooFar();
    error NonceNotMonotonic();
    error ParentMismatch();
    error OperationReplayed();
    error UnknownBinding();
    error AlreadyRevoked();
    error RevokedCreatorMismatch();
    error ZeroAddress();
    error ZeroRepoId();
    error StaleBinding();
    error NotRevoker();

    event Bound(
        uint64 indexed githubRepoId,
        address indexed creator,
        address indexed boundBy,
        uint64 bindingExpiresAt,
        string repoFullName
    );
    event Revoked(uint64 indexed githubRepoId, address indexed creator, address indexed revokedBy);
    /// @notice Emitted for every head transition — signed ops and barriers.
    /// Replaying these events reconstructs the full, verifiable op chain.
    event OperationApplied(
        uint64 indexed githubRepoId,
        uint64 indexed opSequence,
        uint64 bindingEpoch,
        bytes32 parentOpDigest,
        bytes32 opDigest,
        bool revoke
    );
    event PendingOpsInvalidated(
        uint64 indexed githubRepoId,
        address indexed invalidatedBy,
        uint64 opSequence,
        bytes32 barrierDigest
    );
    event AuthorityUpdated(address indexed previous, address indexed current);

    /// @notice The eligibility authority key; sole writer of binding state.
    address public eligibilityAuthority;

    /// @notice Maximum validity of an authority-signed operation: a signed
    /// op cannot be parked longer than this before submission.
    uint64 public constant MAX_OP_VALIDITY = 10 minutes;

    /// @notice Maximum horizon a binding's evidence may claim.
    uint64 public constant MAX_BINDING_HORIZON = 30 days;

    mapping(uint64 repoId => Binding binding) public bindings;
    mapping(uint64 repoId => RepoLog log) public repoLogs;
    mapping(bytes32 opDigest => bool used) public usedOps;

    bytes32 private constant BINDING_OP_TYPEHASH = keccak256(
        "BindingOp(uint64 githubRepoId,address creator,uint64 bindingExpiresAt,uint64 opDeadline,uint64 opNonce,bytes32 parentOpDigest,string repoFullName,bool revoke)"
    );
    bytes32 private constant BARRIER_TAG = keccak256("FINCO Forge Binding Barrier");

    constructor(address authority_)
        EIP712("FINCO Forge Binding Registry", "2")
        Ownable(msg.sender)
    {
        if (authority_ == address(0)) revert ZeroAddress();
        eligibilityAuthority = authority_;
    }

    /**
     * @notice Applies an authority-signed binding operation. Relayable: the
     * authority signs; anyone may submit. Fail-closed on stale, replayed,
     * gapped, forked, over-long-deadline or horizon-violating operations.
     */
    function applyBindingOp(BindingOp calldata op, bytes calldata authoritySignature) external {
        // Operation deadline: independently enforced on both sides.
        if (op.opDeadline < block.timestamp) revert OperationDeadlineExceeded();
        if (op.opDeadline > block.timestamp + MAX_OP_VALIDITY) revert OperationDeadlineTooFar();
        if (op.bindingExpiresAt > block.timestamp + MAX_BINDING_HORIZON) {
            revert BindingHorizonTooFar();
        }
        if (op.githubRepoId == 0) revert ZeroRepoId();

        bytes32 digest = _opDigest(op);
        if (usedOps[digest]) revert OperationReplayed();

        // Linear hash-chained log: the op must be the exact next sequence
        // AND name the current head. Any op issued against an earlier head
        // — including one carrying a higher future nonce — is dead.
        RepoLog storage log = repoLogs[op.githubRepoId];
        if (op.opNonce != log.opSequence + 1) revert NonceNotMonotonic();
        if (op.parentOpDigest != log.headOpDigest) revert ParentMismatch();

        if (digest.recover(authoritySignature) != eligibilityAuthority) revert InvalidSigner();
        usedOps[digest] = true;
        log.opSequence = op.opNonce;
        log.headOpDigest = digest;

        Binding storage b = bindings[op.githubRepoId];
        if (op.revoke) {
            if (b.githubRepoId == 0) revert UnknownBinding();
            if (b.revokedAt != 0) revert AlreadyRevoked();
            // A revocation applies ONLY to the current binding's creator.
            if (b.creator != op.creator) revert RevokedCreatorMismatch();
            b.revokedAt = uint64(block.timestamp);
            emit Revoked(op.githubRepoId, b.creator, eligibilityAuthority);
        } else {
            if (op.creator == address(0)) revert ZeroAddress();
            if (op.bindingExpiresAt < block.timestamp) revert StaleBinding();
            uint64 epoch = log.bindingEpoch + 1;
            log.bindingEpoch = epoch;
            bindings[op.githubRepoId] = Binding({
                githubRepoId: op.githubRepoId,
                creator: op.creator,
                boundBy: eligibilityAuthority,
                boundAt: uint64(block.timestamp),
                expiresAt: op.bindingExpiresAt,
                revokedAt: 0,
                epoch: epoch,
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
        emit OperationApplied(
            op.githubRepoId, op.opNonce, log.bindingEpoch, op.parentOpDigest, digest, op.revoke
        );
    }

    /**
     * @notice Unconditional finality barrier for one repository. Revokes the
     * active binding (if any) and moves the operation-log head to a barrier
     * digest that no signed operation can name as its parent — every
     * outstanding authority signature for this repository, whatever its
     * nonce, is permanently invalidated. Callable by the eligibility
     * authority or governance; it can only narrow eligibility.
     */
    function invalidatePendingOps(uint64 repoId) external {
        if (msg.sender != eligibilityAuthority && msg.sender != owner()) revert NotRevoker();
        if (repoId == 0) revert ZeroRepoId();

        Binding storage b = bindings[repoId];
        if (b.githubRepoId != 0 && b.revokedAt == 0) {
            b.revokedAt = uint64(block.timestamp);
            emit Revoked(repoId, b.creator, msg.sender);
        }

        RepoLog storage log = repoLogs[repoId];
        uint64 seq = log.opSequence + 1;
        bytes32 parent = log.headOpDigest;
        // The prior block hash makes the barrier unknowable before the
        // barrier transaction is mined: no op can be pre-signed against it.
        bytes32 barrier = keccak256(
            abi.encode(BARRIER_TAG, block.chainid, repoId, seq, parent, blockhash(block.number - 1))
        );
        log.opSequence = seq;
        log.headOpDigest = barrier;
        emit OperationApplied(repoId, seq, log.bindingEpoch, parent, barrier, true);
        emit PendingOpsInvalidated(repoId, msg.sender, seq, barrier);
    }

    /// @notice Whether (repoId, creator) currently has an active binding.
    /// Expired evidence counts as inactive: the authorizer requires fresh
    /// attestations anyway, so stale evidence never authorizes a launch.
    function isActive(uint64 repoId, address creator) public view returns (bool) {
        Binding storage b = bindings[repoId];
        return b.githubRepoId != 0 && b.revokedAt == 0 && b.creator == creator
            && b.expiresAt >= block.timestamp;
    }

    /// @notice The repository's current operation sequence; the next
    /// authority-signed op must carry exactly this value plus one.
    function operationSequence(uint64 repoId) external view returns (uint64) {
        return repoLogs[repoId].opSequence;
    }

    /// @notice The digest the next authority-signed op must name as parent.
    function headOpDigest(uint64 repoId) external view returns (bytes32) {
        return repoLogs[repoId].headOpDigest;
    }

    /// @notice The repository's binding authorization epoch (generation of
    /// the latest bind; 0 = never bound). Attestations sign over it.
    function bindingEpoch(uint64 repoId) external view returns (uint64) {
        return repoLogs[repoId].bindingEpoch;
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
                    op.parentOpDigest,
                    keccak256(bytes(op.repoFullName)),
                    op.revoke
                )
            )
        );
    }

    /// @notice The typed digest for a binding operation (for off-chain
    /// signing tools and tests). The applied op's digest becomes the next
    /// op's `parentOpDigest`.
    function attestationDigestForBindingOp(BindingOp calldata op) external view returns (bytes32) {
        return _opDigest(op);
    }
}
