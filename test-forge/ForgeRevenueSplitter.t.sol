// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {PonsV2FeeEscrow} from "contractsV2-forge/src/v2/PonsV2FeeEscrow.sol";
import {
    ForgeProtocolRevenueSplitter
} from "contractsV2-forge/src/v2/forge/ForgeProtocolRevenueSplitter.sol";
import {IPonsV2FeeEscrow} from "contractsV2-forge/src/v2/interfaces/ILaunchpadV2.sol";
import {ForgeTestToken} from "./mocks/ForgeTestToken.sol";
import {FeeOnTransferToken} from "./mocks/FeeOnTransferToken.sol";

/// @notice Stand-in for a Forge curve/hook: credits fees to escrow keys.
contract FeeSource {
    function creditNative(IPonsV2FeeEscrow escrow, address recipient) external payable {
        escrow.credit{value: msg.value}(recipient);
    }

    function creditToken(IPonsV2FeeEscrow escrow, address recipient, address token, uint256 amt)
        external
    {
        ForgeTestToken(token).approve(address(escrow), amt);
        escrow.creditToken(recipient, token, amt);
    }
}

/**
 * @title ForgeRevenueSplitterTest
 * @notice W04 unit + fuzz suite for ForgeProtocolRevenueSplitter against the
 * REAL canonical PonsV2FeeEscrow (not the W02 mock).
 */
contract ForgeRevenueSplitterTest is Test {
    PonsV2FeeEscrow internal escrow;
    ForgeProtocolRevenueSplitter internal splitter;
    ForgeTestToken internal usdx;
    FeeSource internal source;

    address internal governance = makeAddr("governance");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal attacker = makeAddr("attacker");
    address internal factory = makeAddr("factory");

    address internal constant NATIVE = address(0);

    function setUp() public {
        escrow = new PonsV2FeeEscrow();
        splitter = new ForgeProtocolRevenueSplitter(escrow, governance, treasury);
        usdx = new ForgeTestToken("USD X", "USDX");
        source = new FeeSource();
        vm.prank(governance);
        splitter.setAssetApproved(address(usdx), true);
    }

    // ── helpers ──────────────────────────────────────────────────────────

    /// Mirrors a curve/hook sweep: 30% protocol to the splitter, 70% creator.
    function _sweepNative(uint256 baseFee) internal returns (uint256 protocol, uint256 creatorAmt) {
        protocol = (baseFee * 3_000) / 10_000;
        creatorAmt = baseFee - protocol;
        vm.deal(address(this), baseFee);
        source.creditNative{value: protocol}(escrow, address(splitter));
        source.creditNative{value: creatorAmt}(escrow, creator);
    }

    function _sweepToken(uint256 baseFee) internal returns (uint256 protocol, uint256 creatorAmt) {
        protocol = (baseFee * 3_000) / 10_000;
        creatorAmt = baseFee - protocol;
        usdx.mint(address(source), baseFee);
        source.creditToken(escrow, address(splitter), address(usdx), protocol);
        source.creditToken(escrow, creator, address(usdx), creatorAmt);
    }

    function _assertConserved(address asset) internal view {
        (uint256 bal, uint256 accounted,, uint256 deficit) = splitter.reconcile(asset);
        assertEq(deficit, 0, "no deficit");
        assertGe(bal, accounted, "balance covers liabilities");
        ForgeProtocolRevenueSplitter.AssetLedger memory l = splitter.ledger(asset);
        assertEq(
            l.treasuryAllocated + l.reserveAllocated, l.revenueReceived, "every unit allocated once"
        );
        assertEq(l.reserveAllocated, l.revenueReceived / 3, "reserve is floor(revenue/3)");
        assertLe(l.treasuryPaid, l.treasuryAllocated, "never overpaid");
    }

    // ── 1/3: 70/20/10 on eligible base fees, native ETH payout ───────────

    function test_native_70_20_10_on_eligible_base_fee() public {
        (uint256 protocol, uint256 creatorAmt) = _sweepNative(10 ether);
        assertEq(creatorAmt, 7 ether);
        uint256 got = splitter.pullRevenue(NATIVE, 0);
        assertEq(got, protocol);
        assertEq(splitter.treasuryLiability(NATIVE), 2 ether, "20 points of the base fee");
        assertEq(splitter.reserveLiability(NATIVE), 1 ether, "10 points of the base fee");
        assertEq(escrow.balanceOf(creator), 7 ether, "creator 70% untouched in escrow");

        uint256 before = treasury.balance;
        vm.prank(treasury);
        splitter.claimTreasury(NATIVE, 0);
        assertEq(treasury.balance - before, 2 ether);
        _assertConserved(NATIVE);
    }

    // ── 4: ERC-20 quote asset payout ────────────────────────────────────

    function test_erc20_70_20_10() public {
        _sweepToken(1_000_000e6);
        splitter.pullRevenue(address(usdx), 0);
        assertEq(splitter.treasuryLiability(address(usdx)), 200_000e6);
        assertEq(splitter.reserveLiability(address(usdx)), 100_000e6);
        vm.prank(treasury);
        splitter.claimTreasury(address(usdx), 50_000e6);
        assertEq(usdx.balanceOf(treasury), 50_000e6);
        _assertConserved(address(usdx));
    }

    // ── 5: mixed assets never cross ─────────────────────────────────────

    function test_mixed_assets_isolated() public {
        _sweepNative(3 ether);
        _sweepToken(9_000e6);
        splitter.pullRevenue(NATIVE, 0);
        splitter.pullRevenue(address(usdx), 0);
        assertEq(splitter.treasuryLiability(NATIVE), 0.6 ether);
        assertEq(splitter.treasuryLiability(address(usdx)), 1_800e6);
        vm.prank(treasury);
        vm.expectRevert(
            abi.encodeWithSelector(
                ForgeProtocolRevenueSplitter.InsufficientLiability.selector, 1 ether, 0.6 ether
            )
        );
        splitter.claimTreasury(NATIVE, 1 ether);
        _assertConserved(NATIVE);
        _assertConserved(address(usdx));
    }

    // ── 6/7: zero, dust and cumulative rounding ─────────────────────────

    function test_zero_pull_reverts_and_dust_rounds_to_treasury() public {
        vm.expectRevert(ForgeProtocolRevenueSplitter.NothingReceived.selector);
        splitter.pullRevenue(NATIVE, 0);

        vm.deal(address(this), 1);
        source.creditNative{value: 1}(escrow, address(splitter));
        splitter.pullRevenue(NATIVE, 0);
        assertEq(splitter.treasuryLiability(NATIVE), 1, "1 wei: reserve floor(1/3)=0");
        assertEq(splitter.reserveLiability(NATIVE), 0);

        // Two more single-wei pulls: cumulative floor(3/3) = 1 to reserve.
        for (uint256 i; i < 2; ++i) {
            vm.deal(address(this), 1);
            source.creditNative{value: 1}(escrow, address(splitter));
            splitter.pullRevenue(NATIVE, 0);
        }
        assertEq(splitter.reserveLiability(NATIVE), 1, "no per-pull drift");
        assertEq(splitter.treasuryLiability(NATIVE), 2);
        _assertConserved(NATIVE);
    }

    function testFuzz_cumulative_split_exact(uint96[8] memory amounts) public {
        uint256 total;
        for (uint256 i; i < amounts.length; ++i) {
            uint256 a = amounts[i];
            if (a == 0) continue;
            vm.deal(address(this), a);
            source.creditNative{value: a}(escrow, address(splitter));
            splitter.pullRevenue(NATIVE, 0);
            total += a;
        }
        ForgeProtocolRevenueSplitter.AssetLedger memory l = splitter.ledger(NATIVE);
        assertEq(l.revenueReceived, total);
        assertEq(l.reserveAllocated, total / 3);
        assertEq(l.treasuryAllocated, total - total / 3);
        _assertConserved(NATIVE);
    }

    function testFuzz_extreme_amounts(uint256 amount) public {
        amount = bound(amount, 1, type(uint128).max);
        usdx.mint(address(source), amount);
        source.creditToken(escrow, address(splitter), address(usdx), amount);
        splitter.pullRevenue(address(usdx), 0);
        assertEq(splitter.reserveLiability(address(usdx)), amount / 3);
        assertEq(splitter.treasuryLiability(address(usdx)), amount - amount / 3);
        _assertConserved(address(usdx));
    }

    // ── 8/9/10: partial, repeated, unauthorized claims ──────────────────

    function test_partial_repeated_and_unauthorized_claims() public {
        _sweepNative(10 ether);
        splitter.pullRevenue(NATIVE, 0);

        vm.prank(attacker);
        vm.expectRevert(ForgeProtocolRevenueSplitter.NotTreasuryRecipient.selector);
        splitter.claimTreasury(NATIVE, 0);
        vm.prank(governance);
        vm.expectRevert(ForgeProtocolRevenueSplitter.NotTreasuryRecipient.selector);
        splitter.claimTreasury(NATIVE, 0);

        vm.startPrank(treasury);
        splitter.claimTreasury(NATIVE, 0.5 ether);
        splitter.claimTreasury(NATIVE, 1.5 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                ForgeProtocolRevenueSplitter.InsufficientLiability.selector, 0, 0
            )
        );
        splitter.claimTreasury(NATIVE, 0);
        vm.stopPrank();
        assertEq(treasury.balance, 2 ether);
        assertEq(splitter.reserveLiability(NATIVE), 1 ether, "reserve never paid");
        _assertConserved(NATIVE);
    }

    // ── splitter can only ever claim its OWN escrow key ─────────────────

    function test_cannot_touch_creator_escrow_balance() public {
        _sweepNative(10 ether);
        splitter.pullRevenue(NATIVE, 0);
        // The creator's 70% remains intact and claimable only by the creator.
        assertEq(escrow.balanceOf(creator), 7 ether);
        vm.expectRevert(ForgeProtocolRevenueSplitter.NothingReceived.selector);
        splitter.pullRevenue(NATIVE, 0);
        uint256 before = creator.balance;
        vm.prank(creator);
        escrow.claim();
        assertEq(creator.balance - before, 7 ether);
    }

    // ── 11/13: donations and rescue transfers are non-revenue ───────────

    function test_direct_eth_and_token_transfers_are_non_revenue() public {
        // Direct ETH from a stranger (or a curve rescue) never allocates.
        vm.deal(attacker, 5 ether);
        vm.prank(attacker);
        (bool ok,) = address(splitter).call{value: 5 ether}("");
        assertTrue(ok);
        assertEq(splitter.nonRevenueHeld(NATIVE), 5 ether);
        assertEq(splitter.treasuryLiability(NATIVE), 0);
        assertEq(splitter.reserveLiability(NATIVE), 0);

        // A direct ERC-20 transfer (hook/curve rescue path) shows as surplus
        // and is recorded as unattributed, never allocated.
        usdx.mint(address(splitter), 1_000e6);
        (,, uint256 surplus,) = splitter.reconcile(address(usdx));
        assertEq(surplus, 1_000e6);
        splitter.recordUnattributed(address(usdx));
        assertEq(splitter.nonRevenueHeld(address(usdx)), 1_000e6);
        assertEq(splitter.treasuryLiability(address(usdx)), 0);
        vm.expectRevert(ForgeProtocolRevenueSplitter.NothingToRecord.selector);
        splitter.recordUnattributed(address(usdx));

        // Release goes ONLY to the treasury recipient, labelled non-revenue.
        vm.prank(attacker);
        vm.expectRevert();
        splitter.releaseNonRevenue(NATIVE, 1 ether);
        vm.prank(governance);
        splitter.releaseNonRevenue(NATIVE, 5 ether);
        assertEq(treasury.balance, 5 ether);
        _assertConserved(NATIVE);
        _assertConserved(address(usdx));
    }

    function test_launch_fee_classified_separately() public {
        vm.prank(governance);
        splitter.setForgeFactory(factory);
        vm.deal(factory, 0.1 ether);
        vm.expectEmit(true, true, false, true, address(splitter));
        emit ForgeProtocolRevenueSplitter.NonRevenueReceived(
            NATIVE, factory, 0.1 ether, ForgeProtocolRevenueSplitter.NonRevenueClass.LaunchFee
        );
        vm.prank(factory);
        (bool ok,) = address(splitter).call{value: 0.1 ether}("");
        assertTrue(ok);
        assertEq(splitter.ledger(NATIVE).revenueReceived, 0, "launch fee never enters 70/20/10");
        vm.prank(governance);
        vm.expectRevert(ForgeProtocolRevenueSplitter.FactoryAlreadySet.selector);
        splitter.setForgeFactory(attacker);
    }

    /// @notice Documented on-chain limit: a third party crediting the
    /// splitter's ESCROW key is indistinguishable on chain from a fee credit.
    /// The ledger separates it off chain by the escrow event's depositor.
    function test_escrow_credit_by_third_party_emits_depositor() public {
        vm.deal(attacker, 1 ether);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit PonsV2FeeEscrow.Credited(address(splitter), attacker, 1 ether);
        vm.prank(attacker);
        escrow.credit{value: 1 ether}(address(splitter));
    }

    // ── 12: fee-on-transfer quote assets are measured, not trusted ──────

    function test_fee_on_transfer_measured_on_receipt() public {
        FeeOnTransferToken fot = new FeeOnTransferToken(100); // 1%
        vm.prank(governance);
        splitter.setAssetApproved(address(fot), true);
        fot.mint(address(this), 1_000e18);
        fot.approve(address(escrow), type(uint256).max);
        escrow.creditToken(address(splitter), address(fot), 1_000e18); // escrow books 990
        uint256 got = splitter.pullRevenue(address(fot), 0); // receives 980.1
        assertEq(got, 980.1e18, "allocates what actually arrived");
        assertEq(splitter.reserveLiability(address(fot)), uint256(980.1e18) / 3);
        _assertConserved(address(fot));
    }

    // ── unsupported assets fail closed ───────────────────────────────────

    function test_unapproved_asset_fails_closed() public {
        ForgeTestToken other = new ForgeTestToken("Other", "OTH");
        other.mint(address(source), 100);
        source.creditToken(escrow, address(splitter), address(other), 100);
        vm.expectRevert(
            abi.encodeWithSelector(
                ForgeProtocolRevenueSplitter.AssetNotApproved.selector, address(other)
            )
        );
        splitter.pullRevenue(address(other), 0);
        // Revoking keeps existing liabilities claimable.
        _sweepToken(3_000e6);
        splitter.pullRevenue(address(usdx), 0);
        vm.prank(governance);
        splitter.setAssetApproved(address(usdx), false);
        vm.prank(treasury);
        splitter.claimTreasury(address(usdx), 0);
        assertEq(usdx.balanceOf(treasury), 600e6);
    }

    function test_cannot_approve_eoa_or_native_as_token() public {
        vm.startPrank(governance);
        vm.expectRevert(
            abi.encodeWithSelector(ForgeProtocolRevenueSplitter.NotAContract.selector, attacker)
        );
        splitter.setAssetApproved(attacker, true);
        vm.expectRevert(ForgeProtocolRevenueSplitter.InvalidRecipient.selector);
        splitter.setAssetApproved(NATIVE, false);
        vm.stopPrank();
    }

    // ── 15/28: governance, recipient substitution, timelock ─────────────

    function test_treasury_recipient_rotation_timelocked() public {
        address newTreasury = makeAddr("newTreasury");
        vm.prank(attacker);
        vm.expectRevert();
        splitter.proposeTreasuryRecipient(attacker);

        vm.prank(governance);
        splitter.proposeTreasuryRecipient(newTreasury);
        vm.expectRevert();
        splitter.executeTreasuryRecipientChange();

        vm.warp(block.timestamp + 3 days);
        splitter.executeTreasuryRecipientChange();
        assertEq(splitter.treasuryRecipient(), newTreasury);
    }

    function test_recipient_proposal_expires_and_cancels() public {
        vm.startPrank(governance);
        splitter.proposeTreasuryRecipient(attacker);
        splitter.cancelTreasuryRecipientChange();
        vm.expectRevert(ForgeProtocolRevenueSplitter.NoPendingChange.selector);
        splitter.cancelTreasuryRecipientChange();
        splitter.proposeTreasuryRecipient(attacker);
        vm.stopPrank();
        vm.warp(block.timestamp + 6 days + 1);
        vm.expectRevert();
        splitter.executeTreasuryRecipientChange();
        assertEq(splitter.treasuryRecipient(), treasury);
    }

    function test_invalid_recipient_and_renounce_refused() public {
        vm.startPrank(governance);
        vm.expectRevert(ForgeProtocolRevenueSplitter.InvalidRecipient.selector);
        splitter.proposeTreasuryRecipient(address(splitter));
        vm.expectRevert(ForgeProtocolRevenueSplitter.InvalidRecipient.selector);
        splitter.proposeTreasuryRecipient(address(escrow));
        vm.expectRevert(ForgeProtocolRevenueSplitter.OwnershipCannotBeRenounced.selector);
        splitter.renounceOwnership();
        vm.stopPrank();
    }

    function test_pause_blocks_pulls_never_claims() public {
        _sweepNative(3 ether);
        splitter.pullRevenue(NATIVE, 0.5 ether);
        vm.prank(governance);
        splitter.setPullsPaused(true);
        vm.expectRevert(ForgeProtocolRevenueSplitter.PullsPaused.selector);
        splitter.pullRevenue(NATIVE, 0);
        vm.prank(treasury);
        splitter.claimTreasury(NATIVE, 0);
        assertGt(treasury.balance, 0);
        assertGt(escrow.balanceOf(address(splitter)), 0, "unpulled funds stay in escrow");
    }

    // ── 26: the reserve cannot be swapped, burned or withdrawn ──────────

    function test_reserve_has_no_exit() public {
        _sweepNative(9 ether);
        splitter.pullRevenue(NATIVE, 0);
        assertFalse(splitter.FINCO_BURN_ENABLED());
        (bool enabled,) = splitter.burnReadiness();
        assertFalse(enabled);
        // Governance cannot reach the reserve through the non-revenue path.
        vm.prank(governance);
        vm.expectRevert(
            abi.encodeWithSelector(
                ForgeProtocolRevenueSplitter.InsufficientLiability.selector, 1, 0
            )
        );
        splitter.releaseNonRevenue(NATIVE, 1);
        // Treasury cannot over-claim into the reserve.
        vm.prank(treasury);
        vm.expectRevert(
            abi.encodeWithSelector(
                ForgeProtocolRevenueSplitter.InsufficientLiability.selector,
                2.7 ether + 1,
                1.8 ether
            )
        );
        splitter.claimTreasury(NATIVE, 2.7 ether + 1);
        assertEq(splitter.reserveLiability(NATIVE), 0.9 ether);
        assertEq(address(splitter).balance, 2.7 ether);
    }

    receive() external payable {}
}

/// @notice Invariant handler: random fee credits, donations, pulls, claims.
contract SplitterHandler is Test {
    PonsV2FeeEscrow internal escrow;
    ForgeProtocolRevenueSplitter internal splitter;
    ForgeTestToken internal usdx;
    address internal treasury;
    address internal governance;

    uint256 public ghostEthPulled;
    uint256 public ghostTokenPulled;

    constructor(
        PonsV2FeeEscrow e,
        ForgeProtocolRevenueSplitter s,
        ForgeTestToken t,
        address tr,
        address gov
    ) {
        escrow = e;
        splitter = s;
        usdx = t;
        treasury = tr;
        governance = gov;
    }

    function creditEth(uint96 amt) external {
        amt = uint96(bound(amt, 0, 1_000 ether));
        vm.deal(address(this), amt);
        escrow.credit{value: amt}(address(splitter));
    }

    function creditToken(uint96 amt) external {
        usdx.mint(address(this), amt);
        usdx.approve(address(escrow), amt);
        escrow.creditToken(address(splitter), address(usdx), amt);
    }

    function donateEth(uint96 amt) external {
        amt = uint96(bound(amt, 0, 1_000 ether));
        vm.deal(address(this), amt);
        (bool ok,) = address(splitter).call{value: amt}("");
        require(ok);
    }

    function donateToken(uint96 amt) external {
        usdx.mint(address(splitter), amt);
    }

    function pull(bool token, uint256 frac) external {
        address asset = token ? address(usdx) : address(0);
        uint256 avail = token
            ? escrow.balanceOfToken(address(splitter), address(usdx))
            : escrow.balanceOf(address(splitter));
        if (avail == 0) return;
        uint256 amt = bound(frac, 1, avail);
        uint256 got = splitter.pullRevenue(asset, amt);
        if (token) ghostTokenPulled += got;
        else ghostEthPulled += got;
    }

    function claim(bool token, uint256 frac) external {
        address asset = token ? address(usdx) : address(0);
        uint256 avail = splitter.treasuryLiability(asset);
        if (avail == 0) return;
        vm.prank(treasury);
        splitter.claimTreasury(asset, bound(frac, 1, avail));
    }

    function record(bool token) external {
        address asset = token ? address(usdx) : address(0);
        (,, uint256 surplus,) = splitter.reconcile(asset);
        if (surplus != 0) splitter.recordUnattributed(asset);
    }

    function release(bool token, uint256 frac) external {
        address asset = token ? address(usdx) : address(0);
        uint256 held = splitter.nonRevenueHeld(asset);
        if (held == 0) return;
        vm.prank(governance);
        splitter.releaseNonRevenue(asset, bound(frac, 1, held));
    }

    receive() external payable {}
}

contract ForgeRevenueSplitterInvariantTest is StdInvariant, Test {
    PonsV2FeeEscrow internal escrow;
    ForgeProtocolRevenueSplitter internal splitter;
    ForgeTestToken internal usdx;
    SplitterHandler internal handler;
    address internal treasury = makeAddr("treasury");
    address internal governance = makeAddr("governance");

    function setUp() public {
        escrow = new PonsV2FeeEscrow();
        splitter = new ForgeProtocolRevenueSplitter(escrow, governance, treasury);
        usdx = new ForgeTestToken("USD X", "USDX");
        vm.prank(governance);
        splitter.setAssetApproved(address(usdx), true);
        handler = new SplitterHandler(escrow, splitter, usdx, treasury, governance);
        targetContract(address(handler));
    }

    function _check(address asset, uint256 pulled) internal view {
        ForgeProtocolRevenueSplitter.AssetLedger memory l = splitter.ledger(asset);
        assertEq(l.revenueReceived, pulled, "revenue == measured pulls only");
        assertEq(l.treasuryAllocated + l.reserveAllocated, l.revenueReceived, "allocated once");
        assertEq(l.reserveAllocated, l.revenueReceived / 3, "reserve exact third (floor)");
        assertLe(l.treasuryPaid, l.treasuryAllocated, "no overclaim");
        assertLe(l.nonRevenueReleased, l.nonRevenueReceived, "no over-release");
        (uint256 bal, uint256 accounted,, uint256 deficit) = splitter.reconcile(asset);
        assertEq(deficit, 0, "balances cover liabilities");
        assertGe(bal, accounted);
    }

    function invariant_native_conservation() public view {
        _check(address(0), handler.ghostEthPulled());
    }

    function invariant_token_conservation() public view {
        _check(address(usdx), handler.ghostTokenPulled());
    }

    function invariant_burn_disabled() public view {
        assertFalse(splitter.FINCO_BURN_ENABLED());
    }
}
