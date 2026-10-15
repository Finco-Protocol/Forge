// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {PonsV2FeeEscrow} from "contractsV2-forge/src/v2/PonsV2FeeEscrow.sol";
import {
    ForgeProtocolRevenueSplitter
} from "contractsV2-forge/src/v2/forge/ForgeProtocolRevenueSplitter.sol";
import {AttestationHelpers} from "./ForgeRevenueSplitter.t.sol";
import {MockQuotePolicyFactory} from "./mocks/MockQuotePolicyFactory.sol";

/**
 * @title W06FinancialAcceptanceTest
 * @notice Independently written, sequence-fuzzed regression for the two on-chain
 * financial invariants W06 must prove COMBINED (the W05 suites prove each in
 * isolation with hand-written orders):
 *
 *   (a) a revoked revenue attestor can NEVER be bypassed by an older pending
 *       rotation, in ANY interleaving of propose / mature / revoke / execute /
 *       re-propose / pull / unpause;
 *   (b) an emergency pause or revocation NEVER invalidates an already-accrued
 *       claim (treasury liability or creator escrow balance), and the
 *       treasury + reserve liabilities always conserve the allocated revenue.
 *
 * No contract, fee policy or maths is changed. Native asset only; attestor keys
 * are Foundry test keys. Fuzz seeds are Foundry's default deterministic seed
 * (reproducible with `--fuzz-seed`).
 */
contract W06FinancialAcceptanceTest is AttestationHelpers {
    PonsV2FeeEscrow internal escrow;
    ForgeProtocolRevenueSplitter internal splitter;
    MockQuotePolicyFactory internal factory;

    address internal governance = makeAddr("governance");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal donor = makeAddr("source");
    address internal anyone = makeAddr("anyone");
    address internal constant NATIVE = address(0);

    address internal attestorA;
    uint256 internal keyA;
    address internal attestorB;
    address internal attestorC;
    uint256 internal keyC;

    function setUp() public {
        vm.roll(1_000);
        (attestorA, keyA) = makeAddrAndKey("attestorA");
        attestorB = makeAddr("attestorB");
        (attestorC, keyC) = makeAddrAndKey("attestorC");
        escrow = new PonsV2FeeEscrow();
        splitter = new ForgeProtocolRevenueSplitter(escrow, governance, treasury, attestorA);
        factory = new MockQuotePolicyFactory();
        vm.prank(governance);
        splitter.setForgeFactory(address(factory));
    }

    // ── helpers ────────────────────────────────────────────────────────────

    function _credit(address to, uint256 amount) internal {
        vm.deal(donor, amount);
        vm.prank(donor);
        escrow.credit{value: amount}(to);
    }

    function _authAs(uint256 key, uint256 cumulative) internal {
        ForgeProtocolRevenueSplitter.EligibleRevenue memory a = _authFor(
            splitter, address(factory), NATIVE, cumulative, splitter.ledger(NATIVE).authNonce + 1
        );
        splitter.authorizeEligibleRevenue(a, _sign(splitter, key, a));
    }

    function _mature() internal {
        vm.warp(vm.getBlockTimestamp() + splitter.RECIPIENT_TIMELOCK() + 1);
    }

    /// treasury + reserve liabilities == allocated revenue; funds on hand cover every liability.
    function _assertConservation() internal view {
        ForgeProtocolRevenueSplitter.AssetLedger memory l = splitter.ledger(NATIVE);
        assertEq(
            l.treasuryAllocated + l.reserveAllocated, l.revenueReceived, "allocated == received"
        );
        assertEq(l.reserveAllocated, l.revenueReceived / 3, "reserve is exactly floor(received/3)");
        assertEq(
            splitter.treasuryLiability(NATIVE) + splitter.reserveLiability(NATIVE),
            l.revenueReceived - l.treasuryPaid,
            "liabilities conserve"
        );
        assertEq(
            address(splitter).balance,
            splitter.treasuryLiability(NATIVE) + splitter.reserveLiability(NATIVE),
            "the splitter holds only its treasury and reserve liabilities (attested revenue; no creator funds)"
        );
        assertLe(
            l.revenueReceived, l.eligibleCeiling, "allocation never exceeds the attested ceiling"
        );
    }

    // ── (a)+(b): sequence fuzz over the emergency state machine ────────────────

    /// ops: 0 propose B (pre-incident rotation), 1 mature timelock, 2 revoke, 3 anyone executes,
    /// 4 governance proposes C (post-incident), 5 pull some headroom, 6 governance unpauses,
    /// 7 attestor A signs a fresh ceiling (must fail once revoked), 8 treasury claims, 9 creator claims.
    function testFuzz_revocation_cannot_be_bypassed_and_claims_survive(
        uint8[14] memory ops,
        uint64 seed
    ) public {
        uint256 fundA = 1 ether + (seed % 5 ether); // third-party escrow credit under the splitter key
        _credit(address(splitter), fundA);
        _credit(creator, 3 ether);
        uint256 creatorOwed = 3 ether;

        bool revoked;
        bool unpausedSinceRevoke;
        uint256 ceiling;

        for (uint256 i; i < ops.length; i++) {
            uint8 op = ops[i] % 10;
            if (op == 0) {
                // B is the PRE-INCIDENT rotation: governance only ever queues it before the revocation.
                if (!revoked) {
                    vm.prank(governance);
                    splitter.proposeRevenueAttestor(attestorB);
                }
            } else if (op == 1) {
                _mature();
            } else if (op == 2) {
                vm.prank(governance);
                splitter.revokeRevenueAttestor();
                revoked = true;
                unpausedSinceRevoke = false;
            } else if (op == 3) {
                vm.prank(anyone);
                try splitter.executeRevenueAttestorChange() {} catch {}
            } else if (op == 4) {
                vm.prank(governance);
                splitter.proposeRevenueAttestor(attestorC);
            } else if (op == 5) {
                // Pull only while a healthy attestor exists and pulls are on.
                if (splitter.revenueAttestor() != address(0) && !splitter.pullsPaused()) {
                    uint256 want = ceiling < fundA ? fundA : ceiling;
                    address cur = splitter.revenueAttestor();
                    uint256 key = cur == attestorA ? keyA : (cur == attestorC ? keyC : 0);
                    if (key != 0) {
                        if (want > ceiling) {
                            _authAs(key, want);
                            ceiling = want;
                        }
                        uint256 head = splitter.verifiedHeadroom(NATIVE);
                        if (head > 1) {
                            vm.prank(anyone);
                            splitter.pullRevenue(NATIVE, head / 2);
                        }
                    }
                }
            } else if (op == 6) {
                vm.prank(governance);
                splitter.setPullsPaused(false);
                if (revoked) unpausedSinceRevoke = true;
            } else if (op == 7) {
                // The revoked/replaced attestor A can never authorize again after the incident.
                if (revoked) {
                    ForgeProtocolRevenueSplitter.EligibleRevenue memory a = _authFor(
                        splitter,
                        address(factory),
                        NATIVE,
                        ceiling,
                        splitter.ledger(NATIVE).authNonce + 1
                    );
                    bytes memory sig = _sign(splitter, keyA, a);
                    // The input is otherwise valid, so the refusal must come from the attestor check itself.
                    if (splitter.revenueAttestor() == address(0)) {
                        vm.expectRevert(ForgeProtocolRevenueSplitter.AttestorNotSet.selector);
                    } else {
                        vm.expectRevert(ForgeProtocolRevenueSplitter.InvalidAttestation.selector);
                    }
                    splitter.authorizeEligibleRevenue(a, sig);
                }
            } else if (op == 8) {
                uint256 owed = splitter.treasuryLiability(NATIVE);
                if (owed > 0) {
                    vm.prank(treasury);
                    splitter.claimTreasury(NATIVE, 0); // MUST succeed, paused or not, revoked or not
                    assertEq(splitter.treasuryLiability(NATIVE), 0);
                }
            } else {
                uint256 bal = escrow.balanceOf(creator);
                if (bal > 0) {
                    vm.prank(creator);
                    escrow.claim(); // MUST succeed regardless of splitter state
                    creatorOwed -= bal;
                }
            }

            // ── invariants after EVERY operation ──
            address active = splitter.revenueAttestor();
            if (revoked) {
                // B was queued before the incident: it can never be the active attestor afterwards.
                assertTrue(active != attestorB, "pre-incident rotation bypassed the revocation");
                // Only a NEW post-incident proposal (C) can restore an attestor.
                assertTrue(
                    active == address(0) || active == attestorC,
                    "unexpected attestor after revocation"
                );
                // Pulls stay paused until an explicit owner unpause, whoever the attestor is.
                if (!unpausedSinceRevoke) {
                    assertTrue(splitter.pullsPaused(), "pulls resumed without governance");
                }
            }
            _assertConservation();
            // Escrow still holds every unclaimed wei owed to the creator (never swept into the splitter).
            assertEq(
                escrow.balanceOf(creator),
                creatorOwed,
                "creator escrow balance is untouched by splitter state"
            );
        }
    }

    // ── directed regression for the exact bypass, with accrued claims alongside ─

    function test_directed_matured_rotation_then_revoke_with_accrued_claims() public {
        _credit(address(splitter), 4 ether);
        _credit(creator, 2 ether);
        _authAs(keyA, 4 ether);
        vm.prank(anyone);
        splitter.pullRevenue(NATIVE, 3 ether);
        _assertConservation();

        vm.prank(governance);
        splitter.proposeRevenueAttestor(attestorB);
        _mature(); // B executable right now
        vm.prank(governance);
        splitter.revokeRevenueAttestor(); // atomic: clears A, discards B, pauses pulls
        vm.prank(anyone);
        vm.expectRevert(ForgeProtocolRevenueSplitter.NoPendingChange.selector);
        splitter.executeRevenueAttestorChange();
        assertEq(splitter.revenueAttestor(), address(0));
        assertTrue(splitter.pullsPaused());

        // accrued claims all still pay in full
        uint256 owed = splitter.treasuryLiability(NATIVE);
        assertEq(owed, 2 ether); // 3 ether pulled: reserve 1, treasury 2
        vm.prank(treasury);
        splitter.claimTreasury(NATIVE, 0);
        assertEq(treasury.balance, 2 ether);
        vm.prank(creator);
        escrow.claim();
        assertEq(creator.balance, 2 ether);
        _assertConservation();
        assertEq(
            splitter.reserveLiability(NATIVE), 1 ether, "reserve has no exit and keeps its balance"
        );
        assertEq(
            splitter.verifiedHeadroom(NATIVE), 1 ether, "unpulled headroom is frozen, not erased"
        );
    }

    function test_directed_pause_alone_never_blocks_claims_and_unpause_resumes_pulls() public {
        _credit(address(splitter), 2 ether);
        _authAs(keyA, 2 ether);
        vm.prank(anyone);
        splitter.pullRevenue(NATIVE, 1 ether);
        vm.prank(governance);
        splitter.setPullsPaused(true);
        vm.prank(anyone);
        vm.expectRevert(ForgeProtocolRevenueSplitter.PullsPaused.selector);
        splitter.pullRevenue(NATIVE, 0.5 ether);
        vm.prank(treasury);
        splitter.claimTreasury(NATIVE, 0);
        assertGt(treasury.balance, 0);
        _assertConservation();
        vm.prank(governance);
        splitter.setPullsPaused(false);
        vm.prank(anyone);
        splitter.pullRevenue(NATIVE, 0.5 ether);
        _assertConservation();
    }
}
