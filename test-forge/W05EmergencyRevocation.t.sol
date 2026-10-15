// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {PonsV2FeeEscrow} from "contractsV2-forge/src/v2/PonsV2FeeEscrow.sol";
import {
    ForgeProtocolRevenueSplitter
} from "contractsV2-forge/src/v2/forge/ForgeProtocolRevenueSplitter.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AttestationHelpers} from "./ForgeRevenueSplitter.t.sol";
import {MockQuotePolicyFactory} from "./mocks/MockQuotePolicyFactory.sol";

/**
 * @title W05EmergencyRevocationTest (PR #5 Correction A)
 * @notice Emergency revocation must be ATOMIC and must not be undoable through a
 * pre-incident proposal:
 *
 *   revokeRevenueAttestor() = clear attestor + discard any pending rotation +
 *                             pause pulls, in one transaction.
 *
 * Reproduced before the fix (unfixed contract): propose B -> timelock matures ->
 * revoke A -> an unrelated wallet calls executeRevenueAttestorChange() -> B active.
 */
contract W05EmergencyRevocationTest is AttestationHelpers {
    PonsV2FeeEscrow internal escrow;
    ForgeProtocolRevenueSplitter internal splitter;
    MockQuotePolicyFactory internal factory;

    address internal governance = makeAddr("governance");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal donor = makeAddr("thirdParty");
    address internal attacker = makeAddr("attacker");
    address internal attestorA;
    uint256 internal keyA;
    address internal attestorB;
    uint256 internal keyB;
    address internal attestorC;
    uint256 internal keyC;

    address internal constant NATIVE = address(0);

    function setUp() public {
        vm.roll(1_000);
        (attestorA, keyA) = makeAddrAndKey("attestorA");
        (attestorB, keyB) = makeAddrAndKey("attestorB");
        (attestorC, keyC) = makeAddrAndKey("attestorC");
        escrow = new PonsV2FeeEscrow();
        splitter = new ForgeProtocolRevenueSplitter(escrow, governance, treasury, attestorA);
        factory = new MockQuotePolicyFactory();
        vm.prank(governance);
        splitter.setForgeFactory(address(factory));
    }

    function _credit(address from, address to, uint256 amount) internal {
        vm.deal(from, amount);
        vm.prank(from);
        escrow.credit{value: amount}(to);
    }

    function _auth(uint256 key, uint256 cumulative)
        internal
        returns (ForgeProtocolRevenueSplitter.EligibleRevenue memory a, bytes memory sig)
    {
        a = _authFor(
            splitter, address(factory), NATIVE, cumulative, splitter.ledger(NATIVE).authNonce + 1
        );
        sig = _sign(splitter, key, a);
    }

    function _matureTimelock() internal {
        vm.warp(vm.getBlockTimestamp() + splitter.RECIPIENT_TIMELOCK() + 1);
    }

    // ── A / B: a queued replacement can never execute after an emergency revoke ─

    function test_A_propose_revoke_then_execute_is_rejected() public {
        vm.prank(governance);
        splitter.proposeRevenueAttestor(attestorB);
        vm.prank(governance);
        splitter.revokeRevenueAttestor();
        _matureTimelock(); // even after the timelock would have matured
        vm.prank(attacker);
        vm.expectRevert(ForgeProtocolRevenueSplitter.NoPendingChange.selector);
        splitter.executeRevenueAttestorChange();
        assertEq(splitter.revenueAttestor(), address(0));
        (address pending,,) = splitter.pendingRevenueAttestor();
        assertEq(pending, address(0));
    }

    function test_B_matured_proposal_then_revoke_then_execute_is_rejected() public {
        vm.prank(governance);
        splitter.proposeRevenueAttestor(attestorB);
        _matureTimelock(); // B is executable right now
        vm.prank(governance);
        splitter.revokeRevenueAttestor();
        vm.prank(attacker);
        vm.expectRevert(ForgeProtocolRevenueSplitter.NoPendingChange.selector);
        splitter.executeRevenueAttestorChange();
        assertEq(splitter.revenueAttestor(), address(0), "B must NOT become active");
    }

    // ── C: a fresh proposal + the full timelock is the only way back ────────────

    function test_C_new_proposal_with_full_timelock_succeeds() public {
        vm.startPrank(governance);
        splitter.proposeRevenueAttestor(attestorB);
        splitter.revokeRevenueAttestor();
        splitter.proposeRevenueAttestor(attestorC);
        vm.stopPrank();
        vm.expectRevert(
            abi.encodeWithSelector(
                ForgeProtocolRevenueSplitter.TimelockNotElapsed.selector,
                vm.getBlockTimestamp() + splitter.RECIPIENT_TIMELOCK()
            )
        );
        splitter.executeRevenueAttestorChange(); // no shortcut
        _matureTimelock();
        vm.prank(attacker); // permissionless execution of a VALID, non-invalidated proposal
        splitter.executeRevenueAttestorChange();
        assertEq(splitter.revenueAttestor(), attestorC);
        assertTrue(splitter.pullsPaused(), "recovery of the attestor does not silently unpause");
    }

    function test_ordinary_rotation_without_incident_still_works() public {
        vm.prank(governance);
        splitter.proposeRevenueAttestor(attestorB);
        _matureTimelock();
        splitter.executeRevenueAttestorChange();
        assertEq(splitter.revenueAttestor(), attestorB);
        assertFalse(splitter.pullsPaused());
    }

    // ── D: the revoked attestor's signatures stop working ──────────────────────

    function test_D_old_attestor_signatures_fail_after_revocation_and_after_replacement() public {
        _credit(donor, address(splitter), 2 ether);
        (ForgeProtocolRevenueSplitter.EligibleRevenue memory a, bytes memory sig) =
            _auth(keyA, 1 ether);
        vm.prank(governance);
        splitter.revokeRevenueAttestor();
        vm.expectRevert(ForgeProtocolRevenueSplitter.AttestorNotSet.selector);
        splitter.authorizeEligibleRevenue(a, sig); // signed before, submitted after

        vm.startPrank(governance);
        splitter.proposeRevenueAttestor(attestorC);
        vm.stopPrank();
        _matureTimelock();
        splitter.executeRevenueAttestorChange();
        (a, sig) = _auth(keyA, 1 ether); // a FRESH, unexpired signature by the revoked key
        vm.expectRevert(ForgeProtocolRevenueSplitter.InvalidAttestation.selector);
        splitter.authorizeEligibleRevenue(a, sig); // A can never come back
        (a, sig) = _auth(keyC, 1 ether);
        splitter.authorizeEligibleRevenue(a, sig); // the new attestor works
    }

    // ── E / F / G: containment stops pulls, never claims ───────────────────────

    function _authorizeAndPull(uint256 ceiling, uint256 pullAmount) internal {
        (ForgeProtocolRevenueSplitter.EligibleRevenue memory a, bytes memory sig) =
            _auth(keyA, ceiling);
        splitter.authorizeEligibleRevenue(a, sig);
        if (pullAmount != 0) splitter.pullRevenue(NATIVE, pullAmount);
    }

    function test_E_authorized_headroom_cannot_be_pulled_after_containment() public {
        _credit(donor, address(splitter), 2 ether);
        _authorizeAndPull(2 ether, 0.5 ether);
        assertEq(splitter.verifiedHeadroom(NATIVE), 1.5 ether);
        vm.prank(governance);
        splitter.revokeRevenueAttestor(); // ONE transaction
        assertTrue(splitter.pullsPaused());
        assertEq(splitter.verifiedHeadroom(NATIVE), 1.5 ether, "ceilings are not erased");
        vm.prank(attacker);
        vm.expectRevert(ForgeProtocolRevenueSplitter.PullsPaused.selector);
        splitter.pullRevenue(NATIVE, 0.5 ether);
        vm.expectRevert(ForgeProtocolRevenueSplitter.PullsPaused.selector);
        splitter.pullRevenue(NATIVE, 0);
        assertEq(escrow.balanceOf(address(splitter)), 1.5 ether, "unpulled funds stay in escrow");
    }

    function test_F_treasury_claims_remain_executable() public {
        _credit(donor, address(splitter), 2 ether);
        _authorizeAndPull(2 ether, 1 ether);
        vm.prank(governance);
        splitter.revokeRevenueAttestor();
        uint256 owed = splitter.treasuryLiability(NATIVE);
        assertGt(owed, 0);
        vm.prank(treasury);
        splitter.claimTreasury(NATIVE, 0);
        assertEq(treasury.balance, owed);
        assertEq(splitter.treasuryLiability(NATIVE), 0);
    }

    function test_G_creator_escrow_claims_remain_executable() public {
        _credit(donor, creator, 3 ether);
        vm.prank(governance);
        splitter.revokeRevenueAttestor();
        vm.prank(creator);
        escrow.claim();
        assertEq(creator.balance, 3 ether);
    }

    // ── H: nobody but governance can touch the emergency controls ──────────────

    function test_H_attacker_cannot_cancel_reinstate_or_bypass() public {
        vm.prank(governance);
        splitter.proposeRevenueAttestor(attestorB);
        vm.prank(governance);
        splitter.revokeRevenueAttestor();

        bytes memory denied =
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker);
        vm.startPrank(attacker);
        vm.expectRevert(denied);
        splitter.revokeRevenueAttestor();
        vm.expectRevert(denied);
        splitter.setPullsPaused(false);
        vm.expectRevert(denied);
        splitter.proposeRevenueAttestor(attacker);
        vm.expectRevert(denied);
        splitter.cancelRevenueAttestorChange();
        vm.expectRevert(ForgeProtocolRevenueSplitter.NoPendingChange.selector);
        splitter.executeRevenueAttestorChange();
        vm.stopPrank();

        assertEq(splitter.revenueAttestor(), address(0));
        assertTrue(splitter.pullsPaused());
    }

    // ── I: recovery is explicit and owner-only ─────────────────────────────────

    function test_I_unpausing_requires_explicit_governance_action() public {
        _credit(donor, address(splitter), 2 ether);
        _authorizeAndPull(2 ether, 0.5 ether);
        vm.startPrank(governance);
        splitter.revokeRevenueAttestor();
        splitter.proposeRevenueAttestor(attestorC);
        vm.stopPrank();
        _matureTimelock();
        splitter.executeRevenueAttestorChange();
        // A healthy replacement alone does not resume pulls.
        vm.expectRevert(ForgeProtocolRevenueSplitter.PullsPaused.selector);
        splitter.pullRevenue(NATIVE, 0.1 ether);
        vm.prank(governance);
        splitter.setPullsPaused(false); // explicit recovery decision
        splitter.pullRevenue(NATIVE, 0.1 ether);
        assertEq(splitter.verifiedHeadroom(NATIVE), 1.4 ether);
    }

    // ── J: repeated revocation is idempotent and leaves no inconsistent state ──

    function test_J_repeated_revocation_is_consistent() public {
        vm.startPrank(governance);
        splitter.proposeRevenueAttestor(attestorB);

        vm.expectEmit(true, false, false, true);
        emit ForgeProtocolRevenueSplitter.RevenueAttestorChangeCancelled(attestorB);
        vm.expectEmit(true, true, false, true);
        emit ForgeProtocolRevenueSplitter.RevenueAttestorUpdated(attestorA, address(0));
        vm.expectEmit(false, false, false, true);
        emit ForgeProtocolRevenueSplitter.PullsPausedUpdated(true);
        vm.expectEmit(true, true, false, true);
        emit ForgeProtocolRevenueSplitter.EmergencyRevocation(attestorA, attestorB);
        splitter.revokeRevenueAttestor();

        // Second call: nothing left to discard, already paused -> no spurious pause/cancel events.
        vm.recordLogs();
        splitter.revokeRevenueAttestor();
        assertEq(
            vm.getRecordedLogs().length, 2, "only RevenueAttestorUpdated + EmergencyRevocation"
        );
        splitter.revokeRevenueAttestor(); // and a third time
        vm.stopPrank();

        assertEq(splitter.revenueAttestor(), address(0));
        assertTrue(splitter.pullsPaused());
        (address pending,,) = splitter.pendingRevenueAttestor();
        assertEq(pending, address(0));
        // A proposal made while revoked is a normal, fully timelocked proposal.
        vm.prank(governance);
        splitter.proposeRevenueAttestor(attestorC);
        (pending,,) = splitter.pendingRevenueAttestor();
        assertEq(pending, attestorC);
    }
}
