// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {ForgeStackFixture} from "./ForgeRevenueLifecycle.t.sol";
import {PonsV2BondingCurve} from "contractsV2-forge/src/v2/PonsV2BondingCurve.sol";
import {PonsV2LaunchFactory} from "contractsV2-forge/src/v2/PonsV2LaunchFactory.sol";
import {PonsV2MemeHook} from "contractsV2-forge/src/v2/hooks/PonsV2MemeHook.sol";
import {
    ForgeProtocolRevenueSplitter
} from "contractsV2-forge/src/v2/forge/ForgeProtocolRevenueSplitter.sol";
import {GraduationPhase} from "contractsV2-forge/src/v2/interfaces/ILaunchpadV2.sol";

/**
 * @title W05OwnerPowersTest
 * @notice W05 security review evidence for the standing owner powers on the
 * REAL Forge stack with the CANONICAL escrow (no contract is modified):
 *
 *   F-03  factory-owner override of a launch's creator fee recipient
 *         (3-day notice + 3-day execution window), and
 *   F-04  owner rescue hatches (rescueCurveFees, rescuePoolFees,
 *         rescueSweptGraduation, forceSweptGraduation).
 *
 * Each test pins down exactly which creator entitlements an owner action can
 * and cannot reach, what the creator can observe and do during the notice
 * period, that unauthorized callers are refused, and that rescued funds can
 * never be recognised as eligible 70/20/10 revenue.
 */
contract W05OwnerPowersTest is ForgeStackFixture {
    using PoolIdLibrary for PoolKey;

    address internal newRecipient = makeAddr("ownerChosenRecipient");
    address internal stranger = makeAddr("stranger");

    function _unauthorized(address who) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, who);
    }

    function _curve(address c) internal pure returns (PonsV2BondingCurve) {
        return PonsV2BondingCurve(payable(c));
    }

    /// Creator leg of a curve sweep for `fee` with the default 30% snapshot.
    function _creatorLeg(uint256 fee) internal pure returns (uint256) {
        return fee - (fee * 3_000) / 10_000;
    }

    // ── F-03: what the owner override can and cannot reach ──────────────

    /// Fees already CREDITED to the creator's escrow key are out of reach;
    /// fees still ACCRUED in the curve at execution time follow the new
    /// recipient at the next sweep.
    function test_F03_override_reaches_unswept_fees_never_credited_escrow() public {
        (address token, address curve) = _launch(_opts("f03a"));
        _buyNative(_curve(curve), 10e18);
        uint256 fee1 = _curve(curve).quoteFeeBalance();
        vm.prank(creator);
        _curve(curve).sweepFees(0);
        uint256 credited = escrow.balanceOf(creator);
        assertEq(credited, _creatorLeg(fee1), "creator leg credited to the creator key");

        _buyNative(_curve(curve), 10e18); // accrued, not yet swept
        uint256 fee2 = _curve(curve).quoteFeeBalance();

        vm.prank(governance);
        factory.setCreatorFeeRecipient(token, newRecipient);
        vm.warp(vm.getBlockTimestamp() + factory.CREATOR_FEE_RECIPIENT_TIMELOCK());
        factory.executeCreatorFeeRecipientChange(token);

        vm.prank(governance); // the sweep operator settles the accrued bucket
        _curve(curve).sweepFees(0);

        assertEq(escrow.balanceOf(creator), credited, "credited escrow balance is untouched");
        assertEq(escrow.balanceOf(newRecipient), _creatorLeg(fee2), "accrued fees follow override");
        uint256 before = creator.balance;
        vm.prank(creator);
        escrow.claim();
        assertEq(creator.balance - before, credited, "creator still claims everything credited");
    }

    /// During the 3-day notice the creator can settle accrued fees to their
    /// own key, so the override then reaches only fees accrued afterwards.
    function test_F03_creator_can_protect_accrued_fees_during_notice() public {
        (address token, address curve) = _launch(_opts("f03b"));
        _buyNative(_curve(curve), 10e18);
        uint256 fee = _curve(curve).quoteFeeBalance();

        vm.prank(governance);
        factory.setCreatorFeeRecipient(token, newRecipient);
        vm.prank(creator);
        _curve(curve).sweepFees(0); // reaction inside the notice period

        vm.warp(vm.getBlockTimestamp() + factory.CREATOR_FEE_RECIPIENT_TIMELOCK());
        factory.executeCreatorFeeRecipientChange(token);
        assertEq(escrow.balanceOf(creator), _creatorLeg(fee));
        assertEq(escrow.balanceOf(newRecipient), 0, "nothing accrued remained to redirect");
    }

    /// The creator cannot veto: a self-service transfer during the notice
    /// period does not cancel the override. The collision is observable from
    /// the two events (proposal names the old recipient; the update names the
    /// recipient it actually replaced).
    function test_F03_creator_transfer_does_not_cancel_override_and_is_observable() public {
        (address token,) = _launch(_opts("f03c"));
        address creator2 = makeAddr("creatorSecondWallet");

        vm.expectEmit(true, true, true, false, address(factory));
        emit PonsV2LaunchFactory.CreatorFeeRecipientChangeProposed(
            token, creator, newRecipient, 0, 0
        );
        vm.prank(governance);
        factory.setCreatorFeeRecipient(token, newRecipient);

        vm.prank(creator);
        factory.transferCreatorFeeRecipient(token, creator2);
        assertEq(factory.getLaunchedToken(token).creatorFeeRecipient, creator2);

        vm.warp(vm.getBlockTimestamp() + factory.CREATOR_FEE_RECIPIENT_TIMELOCK());
        vm.expectEmit(true, true, true, true, address(factory));
        emit PonsV2LaunchFactory.CreatorFeeRecipientUpdated(token, creator2, newRecipient);
        factory.executeCreatorFeeRecipientChange(token);
        assertEq(factory.getLaunchedToken(token).creatorFeeRecipient, newRecipient);
    }

    function test_F03_notice_window_and_authorization() public {
        (address token,) = _launch(_opts("f03d"));
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        factory.setCreatorFeeRecipient(token, stranger);
        vm.prank(creator); // the creator is not the owner either
        vm.expectRevert(_unauthorized(creator));
        factory.setCreatorFeeRecipient(token, creator);

        vm.prank(governance);
        factory.setCreatorFeeRecipient(token, newRecipient);
        uint256 effectiveAt = vm.getBlockTimestamp() + factory.CREATOR_FEE_RECIPIENT_TIMELOCK();
        vm.expectRevert(
            abi.encodeWithSelector(PonsV2LaunchFactory.TimelockNotElapsed.selector, effectiveAt)
        );
        factory.executeCreatorFeeRecipientChange(token);

        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        factory.cancelCreatorFeeRecipientChange(token);

        // A matured proposal that nobody executes in time lapses.
        uint256 expiresAt = effectiveAt + factory.CREATOR_FEE_RECIPIENT_EXECUTION_WINDOW();
        vm.warp(expiresAt + 1);
        vm.expectRevert(
            abi.encodeWithSelector(PonsV2LaunchFactory.TimelockExpired.selector, expiresAt)
        );
        factory.executeCreatorFeeRecipientChange(token);
        assertEq(factory.getLaunchedToken(token).creatorFeeRecipient, creator);
    }

    /// Vested-but-unreleased buyback tokens follow the override too, unless
    /// the creator releases them during the notice period.
    function test_F03_vested_unreleased_buyback_follows_override() public {
        LaunchOpts memory o = _opts("f03e");
        o.buybackEnabled = true;
        (address token, address curve) = _launch(o);
        _buyNative(_curve(curve), 5e18);
        vm.prank(governance);
        _curve(curve).sweepFees(1); // operator executes the buyback
        assertGt(vault.totalLocked(token), 0);

        vm.warp(vm.getBlockTimestamp() + 365 days);
        vm.prank(governance);
        factory.setCreatorFeeRecipient(token, newRecipient);
        vm.warp(vm.getBlockTimestamp() + factory.CREATOR_FEE_RECIPIENT_TIMELOCK());
        factory.executeCreatorFeeRecipientChange(token);

        vm.prank(creator);
        vm.expectRevert(bytes4(keccak256("NotVestBeneficiary()"))); // the original creator is no longer a vest beneficiary
        vault.release(token);
        vm.prank(newRecipient);
        vault.release(token);
        assertGt(escrow.balanceOfToken(newRecipient, token), 0, "vested creator share redirected");
        assertEq(escrow.balanceOfToken(creator, token), 0);
    }

    // ── F-04: rescue hatches ─────────────────────────────────────────────

    function test_F04_rescue_hatches_are_owner_only() public {
        (address token, address curve) = _launch(_opts("f04a"));
        _buyNative(_curve(curve), 10e18);
        address[3] memory callers = [stranger, creator, treasury];
        for (uint256 i; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(_unauthorized(callers[i]));
            factory.rescueCurveFees(token);
            vm.expectRevert(_unauthorized(callers[i]));
            factory.rescueSweptGraduation(token, callers[i]);
            vm.expectRevert(_unauthorized(callers[i]));
            factory.forceSweptGraduation(token);
            vm.expectRevert(_unauthorized(callers[i]));
            hook.rescuePoolFees(PoolId.wrap(bytes32(uint256(1))));
            vm.stopPrank();
        }
        // The curve itself only accepts the factory.
        vm.prank(stranger);
        vm.expectRevert(bytes4(keccak256("NotFactory()")));
        _curve(curve).rescueFees();
    }

    /// A curve rescue pays the protocol leg to the splitter as a DIRECT
    /// transfer: non-revenue, never attestable, never allocated.
    function test_F04_curve_rescue_is_never_eligible_revenue() public {
        (address token, address curve) = _launch(_opts("f04b"));
        _buyNative(_curve(curve), 10e18);
        uint256 fee = _curve(curve).quoteFeeBalance();
        uint256 creatorBefore = creator.balance;

        vm.prank(governance);
        factory.rescueCurveFees(token);

        uint256 protocolLeg = (fee * 3_000) / 10_000;
        assertEq(creator.balance - creatorBefore, fee - protocolLeg, "creator paid directly");
        assertEq(splitter.nonRevenueHeld(address(0)), protocolLeg, "protocol leg is non-revenue");
        _attestEligible();
        assertEq(splitter.verifiedHeadroom(address(0)), 0, "a rescue is never attested");
        vm.expectRevert(ForgeProtocolRevenueSplitter.NothingReceived.selector);
        splitter.pullRevenue(address(0), 0);
        assertEq(splitter.ledger(address(0)).revenueReceived, 0);
    }

    /// A pool rescue after graduation is likewise a direct, non-revenue
    /// transfer to the splitter.
    function test_F04_pool_rescue_is_never_eligible_revenue() public {
        (address token, address curve) = _launch(_opts("f04c"));
        uint256 tokens = _buyNative(_curve(curve), 10e18);
        vm.deal(buyer, 200e18);
        vm.prank(buyer);
        _curve(curve).buy{value: 100e18}(100e18, 0, buyer);
        factory.createGraduatedPool(token);
        _attestEligible(); // curve-phase protocol fees swept at graduation
        splitter.pullRevenue(address(0), 0);
        uint256 revenueBefore = splitter.ledger(address(0)).revenueReceived;
        uint256 nonRevenueBefore = splitter.nonRevenueHeld(address(0));

        swapKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: 0,
            tickSpacing: 10,
            hooks: hook
        });
        swapZeroForOne = false;
        swapAmountIn = tokens / 2;
        swapBeneficiary = buyer;
        vm.prank(buyer);
        IERC20(token).transfer(address(this), tokens / 2);
        vm.deal(address(poolManager), poolManager.poolReserve(address(0)));
        poolManager.unlock("");
        PoolId pid = swapKey.toId();
        uint256 pending = hook.pendingFees(pid, address(0));
        assertGt(pending, 0);

        // Native-quote pools: rescuePoolFees never touches the native quote
        // bucket (only an ERC-20 quote or the memecoin can stop delivering).
        vm.prank(governance);
        vm.expectRevert(PonsV2MemeHook.NothingToRescue.selector);
        hook.rescuePoolFees(pid);

        // A buy swap accrues memecoin-denominated fees; those ARE rescuable
        // and arrive at the splitter as a direct launch-token transfer.
        swapZeroForOne = true;
        swapAmountIn = 1e18;
        vm.deal(address(this), 1e18);
        poolManager.unlock("");
        uint256 memePending = hook.pendingFees(pid, token);
        assertGt(memePending, 0, "memecoin fees accrued");
        uint256 splitterTokensBefore = IERC20(token).balanceOf(address(splitter));
        vm.prank(governance);
        hook.rescuePoolFees(pid);
        uint256 protocolMeme = IERC20(token).balanceOf(address(splitter)) - splitterTokensBefore;
        assertGt(protocolMeme, 0, "protocol leg paid directly, bypassing the escrow");
        assertEq(escrow.balanceOfToken(address(splitter), token), 0, "no escrow credit");
        // The launch token can never become a revenue asset, and the
        // transfer surfaces only as unrecorded surplus / non-revenue.
        vm.prank(governance);
        vm.expectRevert(
            abi.encodeWithSelector(ForgeProtocolRevenueSplitter.AssetIsLaunchToken.selector, token)
        );
        splitter.setAssetApproved(token, true);
        splitter.recordUnattributed(token);
        assertEq(splitter.nonRevenueHeld(token), protocolMeme);
        assertEq(splitter.ledger(token).revenueReceived, 0);
        _attestEligible();
        assertEq(splitter.verifiedHeadroom(address(0)), 0, "a pool rescue is never attested");
        assertEq(splitter.ledger(address(0)).revenueReceived, revenueBefore);
        assertEq(splitter.nonRevenueHeld(address(0)), nonRevenueBefore);
    }

    /// Holders' swept reserves can be moved to an owner-chosen recipient, but
    /// only after GRADUATION_RESCUE_DELAY, and anyone can close that window
    /// permanently by seeding the pool.
    function test_F04_swept_graduation_rescue_delay_and_permissionless_seed_closes_it() public {
        (address tokenA, address curveA) = _launch(_opts("f04d"));
        vm.deal(buyer, 400e18);
        vm.prank(buyer);
        _curve(curveA).buy{value: 100e18}(100e18, 0, buyer);
        assertEq(
            uint8(factory.getLaunchedToken(tokenA).phase), uint8(GraduationPhase.Swept), "swept"
        );
        uint256 availableAt =
            factory.getLaunchedToken(tokenA).sweptAt + factory.GRADUATION_RESCUE_DELAY();

        vm.prank(governance);
        vm.expectRevert(
            abi.encodeWithSelector(
                PonsV2LaunchFactory.GraduationRescueTooEarly.selector, availableAt
            )
        );
        factory.rescueSweptGraduation(tokenA, newRecipient);

        // Anyone seeds launch A: the rescue window is closed for good.
        vm.prank(stranger);
        factory.createGraduatedPool(tokenA);
        vm.warp(availableAt);
        vm.prank(governance);
        vm.expectRevert(PonsV2LaunchFactory.WrongGraduationPhase.selector);
        factory.rescueSweptGraduation(tokenA, newRecipient);
    }

    /// An unseeded swept launch: after the delay the owner can move ALL swept
    /// reserves to a recipient of its choice (standing owner trust, F-04).
    function test_F04_swept_graduation_rescue_moves_reserves_to_owner_choice() public {
        (address tokenB, address curveB) = _launch(_opts("f04e"));
        vm.deal(buyer, 200e18);
        vm.prank(buyer);
        _curve(curveB).buy{value: 100e18}(100e18, 0, buyer);
        PonsV2LaunchFactory.LaunchedToken memory b = factory.getLaunchedToken(tokenB);
        vm.warp(b.sweptAt + factory.GRADUATION_RESCUE_DELAY());
        uint256 before = newRecipient.balance;
        vm.prank(governance);
        factory.rescueSweptGraduation(tokenB, newRecipient);
        assertEq(newRecipient.balance - before, b.sweptQuote, "reserves leave to owner choice");
        assertEq(IERC20(tokenB).balanceOf(newRecipient), b.sweptTokens);
        assertEq(uint8(factory.getLaunchedToken(tokenB).phase), uint8(GraduationPhase.Rescued));
        assertEq(splitter.ledger(address(0)).revenueReceived, 0, "never revenue");
    }

    // ── governance-only policy knobs: unauthorized calls are refused ─────

    function test_policy_knobs_refuse_non_owners() public {
        vm.startPrank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        hook.setProtocolFeeRecipient(stranger);
        vm.expectRevert(_unauthorized(stranger));
        hook.setProtocolFeeShareBps(0);
        vm.expectRevert(_unauthorized(stranger));
        hook.setFeeSweepOperator(stranger);
        vm.expectRevert(_unauthorized(stranger));
        factory.setLaunchFee(1 ether);
        vm.expectRevert(_unauthorized(stranger));
        factory.setLaunchEnabled(false);
        vm.expectRevert(_unauthorized(stranger));
        factory.setPairTokenApproved(address(usdx), false);
        vm.expectRevert(_unauthorized(stranger));
        authorizer.setEligibilityAuthority(address(0));
        vm.expectRevert(_unauthorized(stranger));
        registry.setEligibilityAuthority(stranger);
        vm.expectRevert(_unauthorized(stranger));
        splitter.setPullsPaused(true);
        vm.expectRevert(_unauthorized(stranger));
        splitter.revokeRevenueAttestor();
        vm.stopPrank();
    }
}
