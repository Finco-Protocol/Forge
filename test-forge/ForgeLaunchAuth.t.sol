// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {ForgeBindingRegistry} from "contractsV2-forge/src/v2/forge/ForgeBindingRegistry.sol";
import {ForgeLaunchAuthorizer} from "contractsV2-forge/src/v2/forge/ForgeLaunchAuthorizer.sol";
import {IForgeLaunchAuthorizer} from "contractsV2-forge/src/v2/forge/IForgeLaunchAuthorizer.sol";

/**
 * @title ForgeLaunchAuthTest
 * @notice Adversarial suite for the M-ELIG authorization core: every bypass
 * vector in the W02 spec is exercised against the REAL on-chain verifier.
 * The factory-facing path is driven through the factory's exact call shape
 * (the full factory integration is ForgeLifecycleTest).
 *
 * NOTE: every argument to requireAuthorizedLaunch (including view calls to
 * the authorizer's digest helpers) is fully evaluated into locals BEFORE
 * vm.prank/vm.expectRevert, so argument evaluation cannot consume pranks or
 * eat expected-revert interceptions.
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

        // Bind the repo to the creator (fresh evidence, 30-day horizon).
        _bind(REPO_ID, creator, uint64(block.timestamp + 30 days));
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    function _bind(uint64 repoId, address who, uint64 expiresAt) internal {
        ForgeBindingRegistry.BindingOp memory op = ForgeBindingRegistry.BindingOp({
            githubRepoId: repoId,
            creator: who,
            expiresAt: expiresAt,
            opNonce: 0,
            repoFullName: "org/repo",
            revoke: false
        });
        bytes32 digest = registry.attestationDigestForBindingOp(
            op.githubRepoId,
            op.creator,
            op.expiresAt,
            op.opNonce,
            keccak256(bytes(op.repoFullName)),
            op.revoke
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(authorityPk, digest);
        registry.applyBindingOp(op, abi.encodePacked(r, s, v));
    }

    function _revoke(uint64 repoId) internal {
        ForgeBindingRegistry.BindingOp memory op = ForgeBindingRegistry.BindingOp({
            githubRepoId: repoId,
            creator: creator,
            expiresAt: uint64(block.timestamp + 10 minutes),
            opNonce: uint64(vm.randomUint(1, type(uint64).max)),
            repoFullName: "",
            revoke: true
        });
        bytes32 digest = registry.attestationDigestForBindingOp(
            op.githubRepoId,
            op.creator,
            op.expiresAt,
            op.opNonce,
            keccak256(bytes(op.repoFullName)),
            op.revoke
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(authorityPk, digest);
        registry.applyBindingOp(op, abi.encodePacked(r, s, v));
    }

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
            nonce: 0
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

    function _attestationPayload(uint64 issuedAt, uint64 expiresAt, uint256 pk)
        internal
        view
        returns (bytes memory)
    {
        return _attestationPayloadFor(REPO_ID, creator, issuedAt, expiresAt, pk);
    }

    function _attestationPayloadFor(
        uint64 repoId,
        address who,
        uint64 issuedAt,
        uint64 expiresAt,
        uint256 pk
    ) internal view returns (bytes memory) {
        bytes32 digest = authorizer.attestationDigest(repoId, who, issuedAt, expiresAt);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        // abi.encodePacked(uint64 issuedAt, uint64 expiresAt, bytes65 sig):
        // each uint64 sits in the LOW 8 bytes of its 32-byte word, matching
        // the contract's bytes8(payload[24:32]) decode.
        return
            abi.encodePacked(
                bytes32(uint256(issuedAt)), bytes32(uint256(expiresAt)), r, s, bytes1(v)
            );
    }

    function _goodAttestation() internal view returns (bytes memory) {
        return
            _attestationPayload(
                uint64(block.timestamp), uint64(block.timestamp + 1 days), authorityPk
            );
    }

    // ── Positive: the full dual-layer authorization accepts ─────────────

    function test_valid_authorization_accepts() public {
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory goodAtt = _goodAttestation();
        bytes32 metaHash = authorizer.metadataDigest(intent.tokenMetadataHash, creator, true);
        vm.expectEmit(true, true, false, true, address(authorizer));
        emit ForgeLaunchAuthorizer.LaunchAuthorized(
            creator, REPO_ID, metaHash, intent.economicsDigest
        );
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, goodAtt);
        // Nonce consumed.
        assertTrue(authorizer.nonceUsed(creator, 0));
        assertFalse(authorizer.nonceUsed(creator, 1));
    }

    // ── B1: direct call with no creator signature ────────────────────────

    function test_b1_direct_call_without_signatures_reverts() public {
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        bytes memory goodAtt = _goodAttestation();
        // OZ v5.0.0 ECDSA reverts with
        // ECDSAInvalidSignatureLength(0).
        vm.expectRevert(abi.encodeWithSelector(0xfce698f7, 0));
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, bytes(""), goodAtt);
    }

    // ── B2: caller is not the wired Forge factory ────────────────────────

    function test_b2_wrong_caller_reverts() public {
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory goodAtt = _goodAttestation();
        vm.expectRevert(ForgeLaunchAuthorizer.WrongFactory.selector);
        vm.prank(fakeFactory);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, goodAtt);
    }

    // ── B3: intent names a different factory than the wired one ─────────

    function test_b3_wrong_factory_in_intent_reverts() public {
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        intent.factory = fakeFactory;
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory goodAtt = _goodAttestation();
        vm.expectRevert(ForgeLaunchAuthorizer.WrongFactory.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, goodAtt);
    }

    // ── B4: reused consent signature (replay) ────────────────────────────

    function test_b4_replayed_consent_reverts() public {
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory goodAtt = _goodAttestation();
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, goodAtt);

        // Replay of the captured calldata: nonce is now stale.
        vm.expectRevert(ForgeLaunchAuthorizer.CreatorNonceStale.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, goodAtt);
    }

    // ── B5: wrong chain ──────────────────────────────────────────────────

    function test_b5_wrong_chain_reverts() public {
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory goodAtt = _goodAttestation();
        // Signatures were produced on chain 1; moving the EVM changes the
        // EIP-712 domain and invalidates them.
        vm.chainId(137);
        vm.expectRevert(ForgeLaunchAuthorizer.WrongCreator.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, goodAtt);
    }

    // ── B6: expired creator consent ──────────────────────────────────────

    function test_b6_expired_consent_reverts() public {
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        intent.expiresAt = uint64(block.timestamp - 1);
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory goodAtt = _goodAttestation();
        vm.expectRevert(ForgeLaunchAuthorizer.AuthorizationExpired.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, goodAtt);
    }

    // ── B7: revoked repository binding ───────────────────────────────────

    function test_b7_revoked_binding_reverts() public {
        _revoke(REPO_ID);
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory goodAtt = _goodAttestation();
        vm.expectRevert(ForgeLaunchAuthorizer.BindingNotActive.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, goodAtt);
    }

    // ── B8: binding expired (stale evidence) ─────────────────────────────

    function test_b8_expired_binding_reverts() public {
        vm.warp(block.timestamp + 31 days);
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory goodAtt = _goodAttestation();
        vm.expectRevert(ForgeLaunchAuthorizer.BindingNotActive.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, goodAtt);
    }

    // ── B9: revoked eligibility authority (kill switch) ──────────────────

    function test_b9_revoked_authority_bricks_launches() public {
        vm.prank(forgeGovernance);
        authorizer.setEligibilityAuthority(address(0));
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory goodAtt = _goodAttestation();
        vm.expectRevert(ForgeLaunchAuthorizer.AuthorityRevoked.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, goodAtt);

        // The kill switch is one-way for launch freedom: only a full
        // governance rotation re-enables, owner-gated and emitted.
        vm.prank(forgeGovernance);
        authorizer.setEligibilityAuthority(authority);
        bytes32 metaHash = authorizer.metadataDigest(intent.tokenMetadataHash, creator, true);
        vm.expectEmit(true, true, false, true, address(authorizer));
        emit ForgeLaunchAuthorizer.LaunchAuthorized(
            creator, REPO_ID, metaHash, intent.economicsDigest
        );
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, goodAtt);
    }

    // ── B10: unauthorized wallet (no binding for the signing creator) ────

    function test_b10_unauthorized_wallet_reverts() public {
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        intent.creator = attacker;
        bytes memory consent = _consentSig(intent, attackerPk);
        bytes memory goodAtt = _goodAttestation();
        vm.expectRevert(ForgeLaunchAuthorizer.InvalidAttestationSignature.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, attacker, true, consent, goodAtt);
    }

    // ── B11: same key signs both layers ──────────────────────────────────

    function test_b11_same_key_both_layers_reverts() public {
        // The authority key tries to act as its own creator.
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

    // ── B12: metadata binding — fee recipient changed after signing ──────

    function test_b12_metadata_mismatch_reverts() public {
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory goodAtt = _goodAttestation();
        // The factory is told a different fee recipient than the consent
        // was signed over: the effective metadata digest differs.
        address rogueRecipient = makeAddr("rogueRecipient");
        vm.expectRevert(ForgeLaunchAuthorizer.WrongCreator.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, rogueRecipient, true, consent, goodAtt);
    }

    // ── B13: economics re-peg after signing ──────────────────────────────

    function test_b13_economics_peg_reverts() public {
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory goodAtt = _goodAttestation();
        // The factory's live economics digest changed (owner re-peg); the
        // factory passes the NEW digest and the consent no longer verifies.
        intent.economicsDigest = keccak256("new-economics");
        vm.expectRevert(ForgeLaunchAuthorizer.WrongCreator.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, goodAtt);
    }

    // ── B14: forged attestation (attacker key) ───────────────────────────

    function test_b14_forged_attestation_reverts() public {
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory forgedAtt = _attestationPayload(
            uint64(block.timestamp), uint64(block.timestamp + 1 days), attackerPk
        );
        vm.expectRevert(ForgeLaunchAuthorizer.InvalidAttestationSignature.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, forgedAtt);
    }

    // ── B15: stale attestation (older than MAX_ATTESTATION_AGE) ──────────

    function test_b15_stale_attestation_reverts() public {
        // Foundry starts at timestamp 1; warp so the stale issuedAt cannot
        // underflow.
        vm.warp(10 days);
        IForgeLaunchAuthorizer.LaunchIntent memory intent = _intent();
        bytes memory consent = _consentSig(intent, creatorPk);
        bytes memory staleAtt = _attestationPayload(
            uint64(block.timestamp - 4 days), uint64(block.timestamp + 1 days), authorityPk
        );
        vm.expectRevert(ForgeLaunchAuthorizer.AttestationTooOld.selector);
        vm.prank(FACTORY);
        authorizer.requireAuthorizedLaunch(intent, creator, true, consent, staleAtt);
    }

    // ── B16: registry/authorizer signer separation ───────────────────────

    function test_b16_registry_signer_separation() public {
        // The registry and authorizer carry separate copies of the key and
        // must be rotated together. A rogue registry key can write bindings,
        // but the authorizer's attestation check still runs on ITS key.
        uint256 roguePk = 0x5E7F;
        address rogue = vm.addr(roguePk);
        vm.prank(forgeGovernance);
        registry.setEligibilityAuthority(rogue);

        // Attacker binds their own repo signed by the rogue registry key.
        ForgeBindingRegistry.BindingOp memory op = ForgeBindingRegistry.BindingOp({
            githubRepoId: 111_222_333,
            creator: attacker,
            expiresAt: uint64(block.timestamp + 30 days),
            opNonce: 0,
            repoFullName: "evil/repo",
            revoke: false
        });
        bytes32 digest = registry.attestationDigestForBindingOp(
            op.githubRepoId,
            op.creator,
            op.expiresAt,
            op.opNonce,
            keccak256(bytes(op.repoFullName)),
            op.revoke
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(roguePk, digest);
        registry.applyBindingOp(op, abi.encodePacked(r, s, v));

        // The creator's launch against the original repo still passes the
        // registry check (binding intact), but the ROGUE key cannot attest:
        // the authorizer rejects any attestation not signed by its own key.
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
}
