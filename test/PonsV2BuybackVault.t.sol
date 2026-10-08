// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PonsV2BuybackVault} from "contractsV2/src/v2/PonsV2BuybackVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockFeeEscrow, MockFeePolicy, MockLaunchRecord} from "./mocks/MockFeeEscrow.sol";

contract PonsV2BuybackVaultTest is Test {
    uint256 internal constant VEST = 5 * 365 days;
    MockFeeEscrow internal escrow;
    MockFeePolicy internal feePolicy;
    MockLaunchRecord internal launchRecord;
    PonsV2BuybackVault internal vault;
    MockERC20 internal token;

    address internal owner = makeAddr("vaultOwner");
    address internal factory = makeAddr("factory");
    address internal creator = makeAddr("creator");
    address internal protocolRecipient = makeAddr("protocolRecipient");
    address internal curve = makeAddr("curve");

    uint16 internal constant SHARE = 3_000; // 30% protocol

    function setUp() public {
        escrow = new MockFeeEscrow();
        feePolicy = new MockFeePolicy(escrow);
        launchRecord = new MockLaunchRecord();
        vault = new PonsV2BuybackVault(owner, feePolicy, escrow);
        vm.prank(owner);
        vault.setFactory(address(launchRecord));
        token = new MockERC20("MEME", "MEME", 18, address(0), 0);
        // Authorize `curve` (this test plays the curve's role from `curve`'s
        // address) as the launch's locker.
        launchRecord.setCurve(address(token), curve);
    }

    function _lock(uint256 amount) internal {
        vm.startPrank(curve);
        token.mint(curve, amount);
        token.approve(address(vault), amount);
        vault.lock(address(token), amount, creator, protocolRecipient, SHARE);
        vm.stopPrank();
    }

    function test_lockRequiresAuthorizedCaller() public {
        token.mint(address(this), 1e18);
        token.approve(address(vault), 1e18);
        vm.expectRevert(PonsV2BuybackVault.NotAuthorizedLocker.selector);
        vault.lock(address(token), 1e18, creator, protocolRecipient, SHARE);
    }

    function test_feePolicyAddressIsAuthorizedLocker() public {
        // In production the meme hook IS the fee policy; the vault must
        // authorize it directly for post-graduation buybacks.
        token.mint(address(feePolicy), 1e18);
        vm.startPrank(address(feePolicy));
        token.approve(address(vault), 1e18);
        vault.lock(address(token), 1e18, creator, protocolRecipient, SHARE);
        vm.stopPrank();
        assertEq(vault.totalLocked(address(token)), 1e18);
    }

    function test_lockRecordsReceivedAmountAndSchedulesVest() public {
        _lock(1000e18);
        assertEq(vault.totalLocked(address(token)), 1000e18);
        assertEq(token.balanceOf(address(vault)), 1000e18);
        (address creatorRecipient, address protocolRecipient_, uint16 shareBps) =
            vault.vestingTerms(address(token));
        assertEq(creatorRecipient, creator);
        assertEq(protocolRecipient_, protocolRecipient);
        assertEq(shareBps, SHARE);
        assertEq(vault.vestingStart(address(token)), block.timestamp);
        assertEq(vault.vestedAmount(address(token)), 0, "nothing vested at t=0");
    }

    function test_vestingIsLinearOverFiveYears() public {
        _lock(1000e18);
        assertEq(vault.releasable(address(token)), 0);
        uint256 start = vm.getBlockTimestamp();
        vm.warp(start + (365 days * 5) / 2);
        assertApproxEqRel(
            vault.releasable(address(token)), 500e18, 1e15, "half the vest must be releasable"
        );
        vm.warp(start + 365 days * 5);
        assertEq(vault.releasable(address(token)), 1000e18, "full vest after five years");
    }

    function test_topUpShiftsClockByWeightedAverage() public {
        _lock(1000e18);
        uint256 start = vm.getBlockTimestamp();
        uint256 firstEnd = start + VEST;

        uint256 delta = 365 days;
        vm.warp(start + delta);
        uint256 topUpAt = vm.getBlockTimestamp();
        _lock(1000e18);

        // The checkpoint banks the fraction vested before the top-up:
        //   banked = 1000e18 * Δ / 5y, unvested = 1000e18 - banked
        // then re-averages over what remains unvested.
        uint256 banked = (1000e18 * delta) / VEST;
        uint256 unvested = 1000e18 - banked;
        uint256 remaining = VEST - delta;
        uint256 combined = (unvested * remaining + 1000e18 * VEST) / (unvested + 1000e18);
        assertEq(vault.vestingStart(address(token)), topUpAt - (VEST - combined));
        assertEq(vault.totalLocked(address(token)), 2000e18);

        // Fully vested when the combined clock matures.
        vm.warp(topUpAt + combined + 1);
        assertEq(
            vault.releasable(address(token)), 2000e18, "combined clock must cover both deposits"
        );
    }

    function test_releaseSplitsAcrossBeneficiariesThroughEscrow() public {
        _lock(1000e18);
        vm.warp(block.timestamp + VEST + 1);

        vm.prank(creator);
        vault.release(address(token));
        assertEq(escrow.balanceOfToken(creator, address(token)), 700e18, "creator leg 70%");
        assertEq(
            escrow.balanceOfToken(protocolRecipient, address(token)), 300e18, "protocol leg 30%"
        );
        assertEq(vault.totalReleased(address(token)), 1000e18);
        assertEq(token.balanceOf(address(vault)), 0);
    }

    function test_releaseOnlyBeneficiaries() public {
        _lock(1000e18);
        vm.warp(block.timestamp + VEST + 1);
        address outsider = makeAddr("outsider");
        vm.prank(outsider);
        vm.expectRevert(PonsV2BuybackVault.NotVestBeneficiary.selector);
        vault.release(address(token));
    }

    function test_protocolTermsImmutableWithinEpochAndReseededPerEpoch() public {
        _lock(1000e18);

        // Mid-epoch, a mismatched protocol share must revert: the active
        // vest is bound to one immutable set of beneficiaries.
        vm.startPrank(curve);
        token.mint(curve, 1e18);
        token.approve(address(vault), 1e18);
        vm.expectRevert(PonsV2BuybackVault.VestingTermsMismatch.selector);
        vault.lock(address(token), 1e18, creator, protocolRecipient, 4_000);
        vm.stopPrank();

        // Drain the epoch, then observe that a fresh epoch re-seeds the
        // protocol terms from the caller's arguments (the curve and hook
        // always pass the launch's frozen snapshot, so this only diverges if
        // an authorized locker itself deviates).
        vm.warp(block.timestamp + VEST + 1);
        vm.prank(creator);
        vault.release(address(token));
        vm.startPrank(curve);
        token.mint(curve, 1e18);
        token.approve(address(vault), 1e18);
        vault.lock(address(token), 1e18, creator, protocolRecipient, 4_000);
        vm.stopPrank();
        (,, uint16 shareBps) = vault.vestingTerms(address(token));
        assertEq(shareBps, 4_000, "fresh epoch re-seeds protocol terms from the lock call");
    }

    function test_creatorRecipientSurvivesEpochResetAfterRotation() public {
        _lock(1000e18);
        address newCreator = makeAddr("newCreator");
        vm.prank(address(launchRecord));
        vault.updateCreatorRecipient(address(token), newCreator);

        vm.warp(block.timestamp + VEST + 1);
        vm.prank(newCreator);
        vault.release(address(token));

        // A fresh epoch must not silently reset the rotated recipient.
        vm.startPrank(curve);
        token.mint(curve, 1e18);
        token.approve(address(vault), 1e18);
        vault.lock(address(token), 1e18, creator, protocolRecipient, SHARE);
        vm.stopPrank();
        (address creatorRecipient,,) = vault.vestingTerms(address(token));
        assertEq(creatorRecipient, newCreator, "rotated creator recipient must survive a new epoch");
    }

    function test_updateCreatorRecipientOnlyFactory() public {
        _lock(1000e18);
        vm.expectRevert(PonsV2BuybackVault.NotFactory.selector);
        vault.updateCreatorRecipient(address(token), makeAddr("x"));
    }

    function test_lockWithTaxedTokenRecordsWhatArrived() public {
        MockERC20 taxed = new MockERC20("TAX", "TAX", 18, makeAddr("sink"), 500); // 5% transfer tax
        launchRecord.setCurve(address(taxed), curve);
        vm.startPrank(curve);
        taxed.mint(curve, 1000e18);
        taxed.approve(address(vault), 1000e18);
        vault.lock(address(taxed), 1000e18, creator, protocolRecipient, SHARE);
        vm.stopPrank();
        // 950e18 arrived after the 5% tax; the vest must schedule 950e18,
        // never 1000e18 it cannot pay out.
        vm.warp(block.timestamp + VEST + 1);
        assertEq(
            vault.releasable(address(taxed)), 950e18, "vest must track received, not requested"
        );
        assertEq(vault.totalLocked(address(taxed)), 950e18);
    }

    function test_vestedNeverExceedsLocked() public {
        _lock(500e18);
        for (uint256 i = 1; i <= 20; ++i) {
            vm.warp(vm.getBlockTimestamp() + (VEST / 10));
            assertLe(vault.vestedAmount(address(token)), vault.totalLocked(address(token)));
            if (i % 4 == 0) {
                _lock(100e18);
            }
        }
        vm.warp(block.timestamp + VEST * 2);
        assertEq(vault.releasable(address(token)), vault.totalLocked(address(token)));
    }
}
