// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {ForgeBindingRegistry} from "contractsV2-forge/src/v2/forge/ForgeBindingRegistry.sol";
import {ForgeLaunchAuthorizer} from "contractsV2-forge/src/v2/forge/ForgeLaunchAuthorizer.sol";
import {IForgeLaunchAuthorizer} from "contractsV2-forge/src/v2/forge/IForgeLaunchAuthorizer.sol";

/**
 * @title ForgeLaunchAuthTest
 * @notice Adversarial suite for the M-ELIG authorization core, including
 * the Correction A regression scenarios (registry op sequencing, creator
 * tax binding, exemption list binding, attestation encoding/time validity).
 * All call arguments are evaluated into locals BEFORE vm.prank /
 * vm.expectRevert so argument evaluation cannot consume pranks or eat
 * expected-revert interceptions.
 */
contract ForgeLaunchAuthTest is Test {
    using ECDSA for bytes32;

    ForgeBindingRegistry internal registry;
    ForgeLaunchAuthorizer internal authorizer;

    uint256 internal authorityPk = 0xA11CE;
    address internal authority;
    uint256 internal creatorPk = 0xC0DEC0DE;
    address internal creator;
    uint256 internal attackerPk = 0xB10B;
    address internal attacker;
    address internal forgeGovernance = makeAddr("forgeGovernance");
    address internal fakeFactory = makeAddr("fakeFactory");

    uint64 internal constant REPO_ID = 987_654_321;
    address internal constant FACTORY = address(0xF0);

    function setUp() public {
        authority = vm.addr(authorityPk);
        creator = vm.addr(creatorPk);
        attacker = vm.addr(attackerPk);
        registry = new ForgeBindingRegistry(authority);
        authorizer = new ForgeLaunchAuthorizer(registry, authority);
        authorizer.transferOwnership(forgeGovernance);
        registry.transferOwnership(forgeGovernance);
        vm.startPrank(forgeGovernance);
        authorizer.acceptOwnership();
        registry.acceptOwnership();
        authorizer.setForgeFactory(FACTORY);
        vm.stopPrank();

        _bind(REPO_ID, creator, uint64(block.timestamp + 30 days));
    }

    // ── Registry helpers ─────────────────────────────────────────────────

    function _op(uint64 repoId, address who, uint64 bindingExpiresAt, uint64 opNonce, bool revoke)
        internal
        view
        returns (ForgeBindingRegistry.BindingOp memory op)
    {
        op = ForgeBindingRegistry.BindingOp({
            githubRepoId: repoId,
            creator: who,
            bindingExpiresAt: bindingExpiresAt,
            opDeadline: uint64(block.timestamp + 5 minutes),
            opNonce: opNonce,
            parentOpDigest: registry.headOpDigest(repoId),
            repoFullName: revoke ? "" : "org/repo",
            revoke: revoke
        });
    }

    function _sign(ForgeBindingRegistry.BindingOp memory op) internal view returns (bytes memory) {
        return _signWith(authorityPk, op);
    }

    function _signWith(uint256 pk, ForgeBindingRegistry.BindingOp memory op)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = registry.attestationDigestForBindingOp(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @notice Applies an authority-signed bind at the NEXT sequence.
    function _bind(uint64 repoId, address who, uint64 bindingExpiresAt) internal {
        _bindAt(repoId, who, bindingExpiresAt, registry.operationSequence(repoId) + 1);
    }

    function _bindAt(uint64 repoId, address who, uint64 bindingExpiresAt, uint64 opNonce) internal {
        ForgeBindingRegistry.BindingOp memory op =
            _op(repoId, who, bindingExpiresAt, opNonce, false);
        registry.applyBindingOp(op, _sign(op));
    }

    /// @notice Applies an authority-signed revoke at the NEXT sequence.
    function _revoke(uint64 repoId) internal {
        _revokeAt(repoId, creator, registry.operationSequence(repoId) + 1);
    }

    function _revokeAt(uint64 repoId, address who, uint64 opNonce) internal {
        ForgeBindingRegistry.BindingOp memory op =
            _op(repoId, who, uint64(block.timestamp + 10 minutes), opNonce, true);
        registry.applyBindingOp(op, _sign(op));
    }

    /// @notice Builds (but does not apply) an op at an arbitrary sequence —
    /// used to demonstrate the stale-signature reactivation vector.
    function _staleOp(uint64 repoId, address who, uint64 opNonce, bool revoke)
        internal
        view
        returns (ForgeBindingRegistry.BindingOp memory op, bytes memory sig)
    {
        op = _op(repoId, who, uint64(block.timestamp + 9 minutes), opNonce, revoke);
        sig = _sign(op);
    }

    // ── Authorization helpers ────────────────────────────────────────────

    function _intent() internal view returns (IForgeLaunchAuthorizer.LaunchIntent memory intent) {
        intent = IForgeLaunchAuthorizer.LaunchIntent({
            factory: FACTORY,
            creator: creator,
            githubRepoId: REPO_ID,
            launchConfigId: 0,
            pairToken: address(0),
            tokenMetadataHash: keccak256("metadata"),
            economicsDigest: keccak256("economics"),
            salt: keccak256("salt"),
            expiresAt: uint64(block.timestamp + 10 minutes),
            nonce: 0,
            creatorTaxBps: 100,
            exemptionListHash: keccak256(abi.encode(new address[](0)))
        });
    }

    function _consentSig(IForgeLaunchAuthorizer.LaunchIntent memory intent, uint256 pk)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = authorizer.consentDigest(intent, intent.creator, true);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @notice Canonical packed attestation payload:
    /// abi.encodePacked(uint64 issuedAt, uint64 expiresAt, bytes65 sig).
    function _attestationPayloadFor(
        uint64 repoId,
        address who,
        uint64 issuedAt,
        uint64 expiresAt,
        uint256 pk
    ) internal view returns (bytes memory) {
        bytes32 digest = authorizer.attestationDigest(
            repoId, who, registry.bindingEpoch(repoId), issuedAt, expiresAt
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(uint64(issuedAt), uint64(expiresAt), r, s, bytes1(v));
    }

    function _goodAttestation() internal view returns (bytes memory) {
        return _attestationPayloadFor(
            REPO_ID, creator, uint64(block.timestamp), uint64(block.timestamp + 1 days), authorityPk
        );
    }

    // ── Positive: the full dual-layer authorization accepts ─────────────

    function test_valid_authorization_accepts() public {
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory goodAtt = _goodAttestation();
        bytes32 metaHash = authorizer.metadataDigest(
            intent.tokenMetadataHash, creator, true, intent.creatorTaxBps
        );
        vm.expectEmit(true, true, false, true, address(authorizer));
        emit ForgeLaunchAuthorizer.LaunchAuthorized(
            creator, REPO_ID, metaHash, intent.economicsDigest
        );
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, goodAtt);
        assertTrue(authorizer.nonceUsed(creator, 0));
        assertFalse(authorizer.nonceUsed(creator, 1));
    }

    // ── Registry P1-1 regression scenarios ───────────────────────────────

    /// @notice Scenario 1: an OLD BIND signed before a revocation executes
    /// AFTER the revocation — must be REJECTED (the W02 replay vector).
    function test_r1_old_bind_after_revoke_reverts() public {
        // Attacker obtains a signed re-bind op (seq 2) BEFORE the revoke...
        (ForgeBindingRegistry.BindingOp memory staleBind, bytes memory staleSig) =
            _staleOp(REPO_ID, attacker, registry.operationSequence(REPO_ID) + 1, false);
        // ...the authority revokes (seq 2 — consumed before the stale op)...
        _revoke(REPO_ID);
        // ...then submits the stale bind: rejected by sequencing.
        vm.expectRevert(ForgeBindingRegistry.NonceNotMonotonic.selector);
        registry.applyBindingOp(staleBind, staleSig);
        assertFalse(registry.isActive(REPO_ID, attacker), "attacker must not gain the binding");
    }

    /// @notice Scenario 2: an OLD BIND signed before a repo transfer to a
    /// new creator executes AFTER the transfer — REJECTED.
    function test_r2_old_bind_after_transfer_reverts() public {
        (ForgeBindingRegistry.BindingOp memory staleBind, bytes memory staleSig) =
            _staleOp(REPO_ID, attacker, registry.operationSequence(REPO_ID) + 1, false);
        // The repo is legitimately transferred to a NEW creator (seq 2).
        _bind(REPO_ID, vm.addr(0x777), uint64(block.timestamp + 30 days));
        // The stale bind for the attacker is now permanently stale.
        vm.expectRevert(ForgeBindingRegistry.NonceNotMonotonic.selector);
        registry.applyBindingOp(staleBind, staleSig);
        assertFalse(registry.isActive(REPO_ID, attacker));
    }

    /// @notice Scenario 3: an OLD REVOKE signed before a new owner binding
    /// executes AFTER the transfer — REJECTED (it must not invalidate the
    /// new owner's binding).
    function test_r3_old_revoke_after_new_binding_reverts() public {
        address newCreator = vm.addr(0x777);
        // Old revoke signed against the CURRENT creator before the transfer.
        (ForgeBindingRegistry.BindingOp memory staleRevoke, bytes memory staleSig) =
            _staleOp(REPO_ID, creator, registry.operationSequence(REPO_ID) + 1, true);
        // Transfer to the new creator (seq 2).
        _bind(REPO_ID, newCreator, uint64(block.timestamp + 30 days));
        // The stale revoke (naming the OLD creator) is rejected both by
        // sequencing and by creator mismatch.
        vm.expectRevert(ForgeBindingRegistry.NonceNotMonotonic.selector);
        registry.applyBindingOp(staleRevoke, staleSig);
        assertTrue(registry.isActive(REPO_ID, newCreator), "new owner binding must survive");
    }

    /// @notice Scenario 4: a FRESH legitimate bind after a revocation —
    /// ACCEPT (legitimate re-binding flows through a new authorized op).
    function test_r4_fresh_rebind_after_revoke_accepted() public {
        _revoke(REPO_ID);
        assertFalse(registry.isActive(REPO_ID, creator));
        _bind(REPO_ID, creator, uint64(block.timestamp + 30 days));
        assertTrue(registry.isActive(REPO_ID, creator), "legitimate re-bind must work");
    }

    /// @notice Scenario 5: duplicate or out-of-order binding operations —
    /// REJECT (exact duplicate via usedOps; lower seq via monotonicity).
    function test_r5_duplicate_and_out_of_order_revert() public {
        // Exact duplicate: same op submitted twice.
        ForgeBindingRegistry.BindingOp memory op = _op(
            REPO_ID,
            creator,
            uint64(block.timestamp + 30 days),
            registry.operationSequence(REPO_ID) + 1,
            false
        );
        bytes memory sig = _sign(op);
        registry.applyBindingOp(op, sig);
        vm.expectRevert(ForgeBindingRegistry.OperationReplayed.selector);
        registry.applyBindingOp(op, sig);

        // Out-of-order: a signed op with a LOWER sequence than applied.
        (ForgeBindingRegistry.BindingOp memory oldOp, bytes memory oldSig) =
            _staleOp(REPO_ID, creator, registry.operationSequence(REPO_ID) - 1, false);
        vm.expectRevert(ForgeBindingRegistry.NonceNotMonotonic.selector);
        registry.applyBindingOp(oldOp, oldSig);
    }

    /// @notice Operation deadline enforcement (split from binding horizon).
    function test_operation_deadline_enforced() public {
        // Expired op deadline.
        ForgeBindingRegistry.BindingOp memory expired = _op(
            REPO_ID,
            creator,
            uint64(block.timestamp + 30 days),
            registry.operationSequence(REPO_ID) + 1,
            false
        );
        expired.opDeadline = uint64(block.timestamp - 1);
        bytes memory expiredSig = _sign(expired);
        vm.expectRevert(ForgeBindingRegistry.OperationDeadlineExceeded.selector);
        registry.applyBindingOp(expired, expiredSig);

        // Deadline too far out (parked signature).
        ForgeBindingRegistry.BindingOp memory parked = _op(
            REPO_ID,
            creator,
            uint64(block.timestamp + 30 days),
            registry.operationSequence(REPO_ID) + 1,
            false
        );
        parked.opDeadline = uint64(block.timestamp + 11 minutes);
        bytes memory parkedSig = _sign(parked);
        vm.expectRevert(ForgeBindingRegistry.OperationDeadlineTooFar.selector);
        registry.applyBindingOp(parked, parkedSig);
    }

    // ── Authorization bypass vectors ─────────────────────────────────────

    function test_b1_direct_call_without_signatures_reverts() public {
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        bytes memory goodAtt = _goodAttestation();
        // OZ v5.0.0 ECDSA reverts with ECDSAInvalidSignatureLength(0).
        vm.expectRevert(abi.encodeWithSelector(0xfce698f7, 0));
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, bytes(""), goodAtt);
    }

    function test_b2_wrong_caller_reverts() public {
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory goodAtt = _goodAttestation();
        vm.expectRevert(ForgeLaunchAuthorizer.WrongFactory.selector);
        vm.prank(fakeFactory);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, goodAtt);
    }

    function test_b3_wrong_factory_in_intent_reverts() public {
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        intent.factory = fakeFactory;
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory goodAtt = _goodAttestation();
        vm.expectRevert(ForgeLaunchAuthorizer.WrongFactory.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, goodAtt);
    }

    function test_b4_replayed_consent_reverts() public {
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory goodAtt = _goodAttestation();
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, goodAtt);
        vm.expectRevert(ForgeLaunchAuthorizer.CreatorNonceStale.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, goodAtt);
    }

    function test_b5_wrong_chain_reverts() public {
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory goodAtt = _goodAttestation();
        vm.chainId(137);
        vm.expectRevert(ForgeLaunchAuthorizer.WrongCreator.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, goodAtt);
    }

    function test_b6_expired_consent_reverts() public {
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        intent.expiresAt = uint64(block.timestamp - 1);
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory goodAtt = _goodAttestation();
        vm.expectRevert(ForgeLaunchAuthorizer.AuthorizationExpired.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, goodAtt);
    }

    function test_b7_revoked_binding_reverts() public {
        _revoke(REPO_ID);
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory goodAtt = _goodAttestation();
        vm.expectRevert(ForgeLaunchAuthorizer.BindingNotActive.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, goodAtt);
    }

    function test_b8_expired_binding_reverts() public {
        vm.warp(vm.getBlockTimestamp() + 31 days);
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory goodAtt = _goodAttestation();
        vm.expectRevert(ForgeLaunchAuthorizer.BindingNotActive.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, goodAtt);
    }

    function test_b9_revoked_authority_bricks_launches() public {
        vm.prank(forgeGovernance);
        authorizer.setEligibilityAuthority(address(0));
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory goodAtt = _goodAttestation();
        vm.expectRevert(ForgeLaunchAuthorizer.AuthorityRevoked.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, goodAtt);

        vm.prank(forgeGovernance);
        authorizer.setEligibilityAuthority(authority);
        bytes32 metaHash = authorizer.metadataDigest(
            intent.tokenMetadataHash, creator, true, intent.creatorTaxBps
        );
        vm.expectEmit(true, true, false, true, address(authorizer));
        emit ForgeLaunchAuthorizer.LaunchAuthorized(
            creator, REPO_ID, metaHash, intent.economicsDigest
        );
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, goodAtt);
    }

    function test_b10_unauthorized_wallet_reverts() public {
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        intent.creator = attacker;
        bytes memory consent = _consentSig(intent, attackerPk);
        bytes memory goodAtt = _goodAttestation();
        vm.expectRevert(ForgeLaunchAuthorizer.InvalidAttestationSignature.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, attacker, true, consent, goodAtt);
    }

    function test_b11_same_key_both_layers_reverts() public {
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        intent.creator = authority;
        bytes32 digest = authorizer.consentDigest(intent, authority, true);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(authorityPk, digest);
        bytes memory selfConsent = abi.encodePacked(r, s, v);
        bytes memory selfAtt = _attestationPayloadFor(
            REPO_ID,
            authority,
            uint64(block.timestamp),
            uint64(block.timestamp + 1 days),
            authorityPk
        );
        vm.expectRevert(ForgeLaunchAuthorizer.SignaturesNotIndependent.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, authority, true, selfConsent, selfAtt);
    }

    // ── Correction A: creator tax binding (scenario 6) ───────────────────

    function test_r6_changed_creator_tax_reverts() public {
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory goodAtt = _goodAttestation();
        // The factory's effective creator tax changed after signing (e.g. a
        // forwarded launch submitting a different tax): the metadata digest
        // differs and the consent no longer verifies.
        intent.creatorTaxBps = 500;
        vm.expectRevert(ForgeLaunchAuthorizer.WrongCreator.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, goodAtt);
    }

    // ── Correction A: exemption list binding (scenario 7) ────────────────

    /// @notice Canonical hash helper mirroring the factory's own rule.
    function _canonicalHash(address[] memory list) internal pure returns (bytes32) {
        for (uint256 i = 1; i < list.length; ++i) {
            address v = list[i];
            uint256 j = i;
            while (j > 0 && list[j - 1] > v) {
                list[j] = list[j - 1];
                --j;
            }
            list[j] = v;
        }
        return keccak256(abi.encode(list));
    }

    function test_r7_changed_exemption_list_reverts() public {
        address[] memory signedList = new address[](2);
        signedList[0] = vm.addr(0xE1);
        signedList[1] = vm.addr(0xE2);
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        intent.exemptionListHash = _canonicalHash(signedList);
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory goodAtt = _goodAttestation();

        // Substitution: the factory submits a DIFFERENT list.
        address[] memory submitted = new address[](2);
        submitted[0] = vm.addr(0xE1);
        submitted[1] = attacker;
        intent.exemptionListHash = _canonicalHash(submitted);
        vm.expectRevert(ForgeLaunchAuthorizer.WrongCreator.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, goodAtt);

        // Addition: one extra wallet appended to the signed list.
        address[] memory added = new address[](3);
        added[0] = signedList[0];
        added[1] = signedList[1];
        added[2] = attacker;
        intent.exemptionListHash = _canonicalHash(added);
        vm.expectRevert(ForgeLaunchAuthorizer.WrongCreator.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, goodAtt);

        // Removal: the empty list where two were signed.
        intent.exemptionListHash = _canonicalHash(new address[](0));
        vm.expectRevert(ForgeLaunchAuthorizer.WrongCreator.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, goodAtt);
    }

    /// @notice Reordering is ACCEPTED by design: the canonical ordering
    /// rule (ascending sort) makes on-chain application order irrelevant.
    function test_r7b_reordered_exemption_list_accepted() public {
        address[] memory signedList = new address[](2);
        signedList[0] = vm.addr(0xE1);
        signedList[1] = vm.addr(0xE2);
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        intent.exemptionListHash = _canonicalHash(signedList);
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory goodAtt = _goodAttestation();

        address[] memory reordered = new address[](2);
        reordered[0] = vm.addr(0xE2);
        reordered[1] = vm.addr(0xE1);
        intent.exemptionListHash = _canonicalHash(reordered);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, goodAtt);
    }

    function test_b14_forged_attestation_reverts() public {
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory forgedAtt = _attestationPayloadFor(
            REPO_ID, creator, uint64(block.timestamp), uint64(block.timestamp + 1 days), attackerPk
        );
        vm.expectRevert(ForgeLaunchAuthorizer.InvalidAttestationSignature.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, forgedAtt);
    }

    // ── Correction A: attestation encoding + time validity (scenario 9/10)

    function test_r9_incorrect_attestation_encoding_reverts() public {
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        bytes memory consent = _consentSig(intent, creatorPk);

        // The W02 padded encoding (129 bytes) is rejected: the canonical
        // encoding is packed (81 bytes).
        bytes32 digest = authorizer.attestationDigest(
            REPO_ID,
            creator,
            registry.bindingEpoch(REPO_ID),
            uint64(block.timestamp),
            uint64(block.timestamp + 1 days)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(authorityPk, digest);
        bytes memory padded = abi.encodePacked(
            bytes32(uint256(uint64(block.timestamp))),
            bytes32(uint256(uint64(block.timestamp + 1 days))),
            r,
            s,
            bytes1(v)
        );
        vm.expectRevert(ForgeLaunchAuthorizer.BadAttestationEncoding.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, padded);

        // Short payload rejected too.
        vm.expectRevert(ForgeLaunchAuthorizer.BadAttestationEncoding.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, bytes("short"));
    }

    function test_r10_future_dated_attestation_reverts() public {
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory futureAtt = _attestationPayloadFor(
            REPO_ID,
            creator,
            uint64(block.timestamp + 1 hours),
            uint64(block.timestamp + 2 days),
            authorityPk
        );
        vm.expectRevert(ForgeLaunchAuthorizer.AttestationNotYetValid.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, futureAtt);
    }

    function test_r10b_inverted_attestation_times_revert() public {
        // Warp so the inverted expiry cannot underflow.
        vm.warp(10 days);
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        bytes memory consent = _consentSig(intent, creatorPk);
        // issuedAt AFTER expiresAt: inverted window (issuedAt still within
        // the present, so the future-dated check does not fire first).
        bytes memory inverted = _attestationPayloadFor(
            REPO_ID, creator, uint64(block.timestamp), uint64(block.timestamp - 1 days), authorityPk
        );
        vm.expectRevert(ForgeLaunchAuthorizer.AttestationTimesInverted.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, inverted);
    }

    function test_b15_stale_attestation_reverts() public {
        vm.warp(10 days);
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory staleAtt = _attestationPayloadFor(
            REPO_ID,
            creator,
            uint64(block.timestamp - 4 days),
            uint64(block.timestamp + 1 days),
            authorityPk
        );
        vm.expectRevert(ForgeLaunchAuthorizer.AttestationTooOld.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, staleAtt);
    }

    function test_b16_registry_signer_separation() public {
        uint256 roguePk = 0x5E7F;
        address rogue = vm.addr(roguePk);
        vm.prank(forgeGovernance);
        registry.setEligibilityAuthority(rogue);

        // Attacker binds their own repo signed by the rogue registry key.
        ForgeBindingRegistry.BindingOp memory op =
            _op(111_222_333, attacker, uint64(block.timestamp + 30 days), 1, false);
        registry.applyBindingOp(op, _signWith(roguePk, op));

        // An attacker with NO binding for the ORIGINAL repo consents for
        // themselves and even carries an authority-signed attestation
        // payload addressed to them: the registry check still refuses.
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        intent.creator = attacker;
        bytes memory consent = _consentSig(intent, attackerPk);
        bytes memory rogueAtt = _attestationPayloadFor(
            REPO_ID,
            attacker,
            uint64(block.timestamp),
            uint64(block.timestamp + 1 days),
            authorityPk
        );
        vm.expectRevert(ForgeLaunchAuthorizer.BindingNotActive.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, attacker, true, consent, rogueAtt);
    }

    // ── Correction B: revocation finality (hash-chained op log + epoch) ──

    /// @notice Builds and signs an op with explicit nonce AND parent — the
    /// shape a pre-issued (signed-ahead) authority operation would have.
    function _issuedOp(uint64 repoId, address who, uint64 opNonce, bytes32 parent, bool revoke)
        internal
        view
        returns (ForgeBindingRegistry.BindingOp memory op, bytes memory sig)
    {
        op = _op(repoId, who, uint64(block.timestamp + 30 days), opNonce, revoke);
        op.parentOpDigest = parent;
        sig = _sign(op);
    }

    /// @notice B1: the Correction A residual. An op issued BEFORE a
    /// revocation with a HIGHER future nonce can no longer reactivate the
    /// binding — neither with a gapped nonce nor with the exact next nonce.
    function test_cb1_future_nonce_op_after_revoke_reverts() public {
        uint64 seq = registry.operationSequence(REPO_ID);
        bytes32 head = registry.headOpDigest(REPO_ID);
        // Issued before the revocation: a gapped future nonce...
        (ForgeBindingRegistry.BindingOp memory gapped, bytes memory gappedSig) =
            _issuedOp(REPO_ID, attacker, seq + 5, head, false);
        // ...and one at exactly the nonce the post-revoke log will expect.
        (ForgeBindingRegistry.BindingOp memory exact, bytes memory exactSig) =
            _issuedOp(REPO_ID, attacker, seq + 2, head, false);

        _revoke(REPO_ID);
        assertFalse(registry.isActive(REPO_ID, creator));

        vm.expectRevert(ForgeBindingRegistry.NonceNotMonotonic.selector);
        registry.applyBindingOp(gapped, gappedSig);
        // Nonce now matches, but the parent names the pre-revocation head.
        vm.expectRevert(ForgeBindingRegistry.ParentMismatch.selector);
        registry.applyBindingOp(exact, exactSig);
        assertFalse(registry.isActive(REPO_ID, attacker), "no reactivation");
        assertFalse(registry.isActive(REPO_ID, creator), "revocation is final");
    }

    /// @notice B2: a pre-issued op for the OLD owner cannot claw the repo
    /// back after a transfer, even at the exact next nonce.
    function test_cb2_future_nonce_op_after_transfer_reverts() public {
        address newCreator = vm.addr(0x777);
        uint64 seq = registry.operationSequence(REPO_ID);
        (ForgeBindingRegistry.BindingOp memory clawback, bytes memory sig) =
            _issuedOp(REPO_ID, creator, seq + 2, registry.headOpDigest(REPO_ID), false);
        _bind(REPO_ID, newCreator, uint64(block.timestamp + 30 days));
        vm.expectRevert(ForgeBindingRegistry.ParentMismatch.selector);
        registry.applyBindingOp(clawback, sig);
        assertTrue(registry.isActive(REPO_ID, newCreator));
        assertFalse(registry.isActive(REPO_ID, creator));
    }

    /// @notice B3: even a fully pre-signed CHAIN (op2 names op1's digest as
    /// parent) dies with its first link once a revocation lands instead.
    function test_cb3_presigned_chain_dies_with_superseded_link() public {
        uint64 seq = registry.operationSequence(REPO_ID);
        bytes32 head = registry.headOpDigest(REPO_ID);
        (ForgeBindingRegistry.BindingOp memory op1,) =
            _issuedOp(REPO_ID, creator, seq + 1, head, false);
        bytes32 op1Digest = registry.attestationDigestForBindingOp(op1);
        (ForgeBindingRegistry.BindingOp memory op2, bytes memory op2Sig) =
            _issuedOp(REPO_ID, attacker, seq + 2, op1Digest, false);

        _revoke(REPO_ID); // lands at seq+1 instead of op1
        assertTrue(registry.headOpDigest(REPO_ID) != op1Digest);
        vm.expectRevert(ForgeBindingRegistry.ParentMismatch.selector);
        registry.applyBindingOp(op2, op2Sig);
        assertFalse(registry.isActive(REPO_ID, attacker));
    }

    /// @notice B4: the finality barrier revokes and kills EVERY outstanding
    /// signature for the repository at once; only authority/governance.
    function test_cb4_barrier_invalidates_all_outstanding_ops() public {
        uint64 seq = registry.operationSequence(REPO_ID);
        bytes32 head = registry.headOpDigest(REPO_ID);
        (ForgeBindingRegistry.BindingOp memory pending, bytes memory pendingSig) =
            _issuedOp(REPO_ID, attacker, seq + 1, head, false);
        (ForgeBindingRegistry.BindingOp memory pendingNext, bytes memory pendingNextSig) =
            _issuedOp(REPO_ID, attacker, seq + 2, head, false);

        vm.expectRevert(ForgeBindingRegistry.NotRevoker.selector);
        vm.prank(attacker);
        registry.invalidatePendingOps(REPO_ID);

        vm.prank(authority);
        registry.invalidatePendingOps(REPO_ID);
        assertFalse(registry.isActive(REPO_ID, creator), "barrier revokes");
        assertEq(registry.operationSequence(REPO_ID), seq + 1);

        vm.expectRevert(ForgeBindingRegistry.NonceNotMonotonic.selector);
        registry.applyBindingOp(pending, pendingSig);
        vm.expectRevert(ForgeBindingRegistry.ParentMismatch.selector);
        registry.applyBindingOp(pendingNext, pendingNextSig);

        // Governance may raise the barrier too (revocation-only power).
        vm.prank(forgeGovernance);
        registry.invalidatePendingOps(REPO_ID);
        assertEq(registry.operationSequence(REPO_ID), seq + 2);
    }

    /// @notice B5: legitimate fresh re-binding after a revocation or a
    /// barrier still works, and advances the binding epoch.
    function test_cb5_fresh_rebind_after_revoke_and_barrier_accepted() public {
        uint64 epoch0 = registry.bindingEpoch(REPO_ID);
        _revoke(REPO_ID);
        assertEq(registry.bindingEpoch(REPO_ID), epoch0, "revoke keeps the epoch");
        _bind(REPO_ID, creator, uint64(block.timestamp + 30 days));
        assertTrue(registry.isActive(REPO_ID, creator));
        assertEq(registry.bindingEpoch(REPO_ID), epoch0 + 1);

        vm.prank(authority);
        registry.invalidatePendingOps(REPO_ID);
        assertFalse(registry.isActive(REPO_ID, creator));
        _bind(REPO_ID, creator, uint64(block.timestamp + 30 days));
        assertTrue(registry.isActive(REPO_ID, creator));
        assertEq(registry.bindingEpoch(REPO_ID), epoch0 + 2);
        (,,,,,, uint64 recordEpoch,) = registry.bindings(REPO_ID);
        assertEq(recordEpoch, epoch0 + 2, "binding record carries its epoch");
    }

    /// @notice B6: an eligibility attestation issued under an earlier
    /// binding epoch never authorizes a launch after revoke + re-bind of
    /// the SAME creator; a fresh attestation under the new epoch does.
    function test_cb6_old_epoch_attestation_rejected_after_rebind() public {
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory oldAtt = _goodAttestation(); // epoch N

        _revoke(REPO_ID);
        _bind(REPO_ID, creator, uint64(block.timestamp + 30 days)); // epoch N+1

        vm.expectRevert(ForgeLaunchAuthorizer.InvalidAttestationSignature.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, oldAtt);

        bytes memory freshAtt = _goodAttestation(); // epoch N+1
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, freshAtt);
        assertTrue(authorizer.nonceUsed(creator, 0));
    }

    /// @notice B7: the applied-op log is auditable from events alone —
    /// parent, digest, sequence and epoch of every transition.
    function test_cb7_operation_log_is_auditable() public {
        uint64 seq = registry.operationSequence(REPO_ID);
        bytes32 head = registry.headOpDigest(REPO_ID);
        uint64 epoch = registry.bindingEpoch(REPO_ID);
        ForgeBindingRegistry.BindingOp memory op =
            _op(REPO_ID, creator, uint64(block.timestamp + 10 minutes), seq + 1, true);
        bytes memory sig = _sign(op);
        bytes32 digest = registry.attestationDigestForBindingOp(op);
        vm.expectEmit(true, true, false, true, address(registry));
        emit ForgeBindingRegistry.OperationApplied(REPO_ID, seq + 1, epoch, head, digest, true);
        registry.applyBindingOp(op, sig);
        assertEq(registry.headOpDigest(REPO_ID), digest);
        assertTrue(registry.usedOps(digest));
        // Re-submitting the applied op is a replay.
        vm.expectRevert(ForgeBindingRegistry.OperationReplayed.selector);
        registry.applyBindingOp(op, sig);
    }

    /// @notice B8 (property): NO operation issued against the pre-revocation
    /// state survives the revocation — for any nonce, creator or op kind.
    function testFuzz_cb8_no_preissued_op_survives_revoke(
        uint64 nonceOffset,
        address who,
        bool revoke
    ) public {
        vm.assume(who != address(0));
        uint64 seq = registry.operationSequence(REPO_ID);
        nonceOffset = uint64(bound(nonceOffset, 0, type(uint64).max - seq - 1));
        (ForgeBindingRegistry.BindingOp memory op, bytes memory sig) =
            _issuedOp(REPO_ID, who, seq + 1 + nonceOffset, registry.headOpDigest(REPO_ID), revoke);
        _revoke(REPO_ID);
        vm.expectRevert();
        registry.applyBindingOp(op, sig);
        assertFalse(registry.isActive(REPO_ID, who));
    }
}
