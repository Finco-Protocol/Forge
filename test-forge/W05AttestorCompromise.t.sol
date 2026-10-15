// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {PonsV2FeeEscrow} from "contractsV2-forge/src/v2/PonsV2FeeEscrow.sol";
import {
    ForgeProtocolRevenueSplitter
} from "contractsV2-forge/src/v2/forge/ForgeProtocolRevenueSplitter.sol";
import {AttestationHelpers} from "./ForgeRevenueSplitter.t.sol";
import {MockQuotePolicyFactory} from "./mocks/MockQuotePolicyFactory.sol";

/**
 * @title W05AttestorCompromiseTest
 * @notice Adversarial suite for a COMPROMISED or FAULTY revenue attestor
 * against the real canonical escrow. The attestor is a trusted role (not a
 * trustless proof); these tests pin down its exact blast radius and the
 * incident procedure:
 *
 *  - it can never reach creator escrow balances or withdraw anything;
 *  - W05: it cannot exhaust the nonce space (sequential nonces) nor
 *    pre-authorise future third-party credits (ceiling capped at escrow
 *    claimed + held at signing time);
 *  - (Correction A) revocation is atomic: it stops NEW authorizations, discards
 *    any queued rotation and pauses pulls, so already-authorized headroom cannot
 *    be drained; claims are never blocked (see W05EmergencyRevocation.t.sol);
 *  - pausing pulls never blocks treasury claims, and a timelocked successor
 *    continues the nonce sequence (no permanent lockout).
 */
contract W05AttestorCompromiseTest is AttestationHelpers {
    PonsV2FeeEscrow internal escrow;
    ForgeProtocolRevenueSplitter internal splitter;
    MockQuotePolicyFactory internal factory;

    address internal governance = makeAddr("governance");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal donor = makeAddr("thirdParty");
    address internal attacker = makeAddr("attacker");
    address internal attestor;
    uint256 internal attestorKey;

    address internal constant NATIVE = address(0);

    function setUp() public {
        vm.roll(1_000);
        (attestor, attestorKey) = makeAddrAndKey("attestor");
        escrow = new PonsV2FeeEscrow();
        splitter = new ForgeProtocolRevenueSplitter(escrow, governance, treasury, attestor);
        factory = new MockQuotePolicyFactory();
        vm.prank(governance);
        splitter.setForgeFactory(address(factory));
    }

    function _credit(address from, address to, uint256 amount) internal {
        vm.deal(from, amount);
        vm.prank(from);
        escrow.credit{value: amount}(to);
    }

    function _signed(uint256 key, uint256 cumulative, uint64 nonce)
        internal
        returns (ForgeProtocolRevenueSplitter.EligibleRevenue memory a, bytes memory sig)
    {
        a = _authFor(splitter, address(factory), NATIVE, cumulative, nonce);
        sig = _sign(splitter, key, a);
    }

    function _next() internal view returns (uint64) {
        return splitter.ledger(NATIVE).authNonce + 1;
    }

    function test_nonce_space_cannot_be_exhausted() public {
        _credit(attacker, address(splitter), 1 ether);
        (ForgeProtocolRevenueSplitter.EligibleRevenue memory a, bytes memory sig) =
            _signed(attestorKey, 1 ether, type(uint64).max);
        vm.expectRevert(ForgeProtocolRevenueSplitter.StaleNonce.selector);
        splitter.authorizeEligibleRevenue(a, sig);
        (a, sig) = _signed(attestorKey, 1 ether, 3); // skipping ahead is refused too
        vm.expectRevert(ForgeProtocolRevenueSplitter.StaleNonce.selector);
        splitter.authorizeEligibleRevenue(a, sig);
        assertEq(splitter.ledger(NATIVE).authNonce, 0);
    }

    function test_unbounded_ceiling_is_refused() public {
        _credit(attacker, address(splitter), 1 ether);
        (ForgeProtocolRevenueSplitter.EligibleRevenue memory a, bytes memory sig) =
            _signed(attestorKey, type(uint256).max, 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                ForgeProtocolRevenueSplitter.CeilingExceedsEscrow.selector,
                type(uint256).max,
                1 ether
            )
        );
        splitter.authorizeEligibleRevenue(a, sig);
    }

    /// Worst case of an overstating attestor: third-party credits ALREADY
    /// under the splitter key at signing time get pulled. Creator balances
    /// are untouched and later third-party credits stay unpullable.
    function test_overstatement_blast_radius_is_current_third_party_credit_only() public {
        _credit(attacker, address(splitter), 0.3 ether); // "legit" stand-in
        _credit(donor, address(splitter), 1 ether); // third party
        _credit(attacker, creator, 7 ether); // creator's own escrow balance

        (ForgeProtocolRevenueSplitter.EligibleRevenue memory a, bytes memory sig) =
            _signed(attestorKey, 1.3 ether, _next());
        splitter.authorizeEligibleRevenue(a, sig);
        assertEq(splitter.pullRevenue(NATIVE, 0), 1.3 ether, "overstated pull bounded by escrow");

        _credit(donor, address(splitter), 5 ether); // after signing
        vm.expectRevert(ForgeProtocolRevenueSplitter.NothingReceived.selector);
        splitter.pullRevenue(NATIVE, 0);
        assertEq(escrow.balanceOf(address(splitter)), 5 ether, "later credits unpullable");
        assertEq(escrow.balanceOf(creator), 7 ether, "creator escrow untouched");
        // Nothing but the treasury recipient can move allocated funds.
        vm.prank(attestor);
        vm.expectRevert(ForgeProtocolRevenueSplitter.NotTreasuryRecipient.selector);
        splitter.claimTreasury(NATIVE, 0);
    }

    /// Incident procedure: revoke the attestor AND pause pulls. Revocation
    /// alone leaves existing headroom pullable.
    function test_revocation_atomically_pauses_pulls_and_keeps_claims() public {
        _credit(attacker, address(splitter), 2 ether);
        (ForgeProtocolRevenueSplitter.EligibleRevenue memory a, bytes memory sig) =
            _signed(attestorKey, 2 ether, _next());
        splitter.authorizeEligibleRevenue(a, sig);
        splitter.pullRevenue(NATIVE, 0.5 ether);

        vm.prank(governance);
        splitter.revokeRevenueAttestor();
        (a, sig) = _signed(attestorKey, 2 ether, _next());
        vm.expectRevert(ForgeProtocolRevenueSplitter.AttestorNotSet.selector);
        splitter.authorizeEligibleRevenue(a, sig);

        // Correction A: revocation does not erase the 1.5 ETH already authorized, but it
        // pauses new pulls in the SAME transaction, so that headroom cannot be drained.
        assertEq(splitter.verifiedHeadroom(NATIVE), 1.5 ether);
        assertTrue(splitter.pullsPaused());
        vm.expectRevert(ForgeProtocolRevenueSplitter.PullsPaused.selector);
        splitter.pullRevenue(NATIVE, 0.5 ether);
        assertEq(escrow.balanceOf(address(splitter)), 1.5 ether, "remaining stays in escrow");

        // Treasury claims are never blocked by the pause.
        uint256 liability = splitter.treasuryLiability(NATIVE);
        vm.prank(treasury);
        splitter.claimTreasury(NATIVE, 0);
        assertEq(treasury.balance, liability);
    }

    /// A timelocked successor continues the per-asset nonce sequence: a
    /// compromised predecessor can never lock it out.
    function test_successor_attestor_continues_sequence() public {
        _credit(attacker, address(splitter), 1 ether);
        (ForgeProtocolRevenueSplitter.EligibleRevenue memory a, bytes memory sig) =
            _signed(attestorKey, 0.4 ether, _next());
        splitter.authorizeEligibleRevenue(a, sig);

        (address next, uint256 nextKey) = makeAddrAndKey("attestorV2");
        vm.startPrank(governance);
        splitter.revokeRevenueAttestor();
        splitter.proposeRevenueAttestor(next);
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + splitter.RECIPIENT_TIMELOCK());
        splitter.executeRevenueAttestorChange();

        (a, sig) = _signed(attestorKey, 1 ether, _next());
        vm.expectRevert(ForgeProtocolRevenueSplitter.InvalidAttestation.selector);
        splitter.authorizeEligibleRevenue(a, sig);
        (a, sig) = _signed(nextKey, 1 ether, _next());
        splitter.authorizeEligibleRevenue(a, sig);
        assertEq(splitter.ledger(NATIVE).authNonce, 2);
        assertEq(splitter.verifiedHeadroom(NATIVE), 1 ether);
    }

    /// A lagging (under-stating) attestor only delays pulls; nothing is lost.
    function test_understatement_only_delays() public {
        _credit(attacker, address(splitter), 1 ether);
        (ForgeProtocolRevenueSplitter.EligibleRevenue memory a, bytes memory sig) =
            _signed(attestorKey, 0.25 ether, _next());
        splitter.authorizeEligibleRevenue(a, sig);
        assertEq(splitter.pullRevenue(NATIVE, 0), 0.25 ether);
        assertEq(escrow.balanceOf(address(splitter)), 0.75 ether, "rest waits in escrow");
    }

    function test_attestor_cannot_govern() public {
        vm.startPrank(attestor);
        vm.expectRevert();
        splitter.setPullsPaused(false);
        vm.expectRevert();
        splitter.proposeRevenueAttestor(attacker);
        vm.expectRevert();
        splitter.proposeTreasuryRecipient(attacker);
        vm.expectRevert();
        splitter.releaseNonRevenue(NATIVE, 1);
        vm.stopPrank();
    }
}
