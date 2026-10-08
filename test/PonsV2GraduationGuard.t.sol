// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PonsV2GraduationGuard} from "contractsV2/src/v2/PonsV2GraduationGuard.sol";
import {PonsV2GraduationMath} from "contractsV2/src/v2/libraries/PonsV2GraduationMath.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

contract PonsV2GraduationGuardTest is Test {
    PonsV2GraduationGuard internal guard;

    address internal token = makeAddr("token");
    address internal pairToken = makeAddr("pair");

    function setUp() public {
        guard = new PonsV2GraduationGuard();
    }

    function test_typicalSeedIsSeedable() public view {
        guard.assertSeedable(token, pairToken, 10, 30e18, 500_000e18);
        guard.assertSeedableEitherOrdering(10, 30e18, 500_000e18);
    }

    function test_nativeQuoteOrdering() public view {
        // Native quote (address(0)) always sorts as currency0.
        guard.assertSeedable(token, address(0), 10, 30e18, 500_000e18);
    }

    function test_zeroAmountsRevertWithZeroAmount() public {
        // Zero sides are caught by PonsV2GraduationMath before the guard's
        // own viability checks.
        vm.expectRevert(PonsV2GraduationMath.ZeroAmount.selector);
        guard.assertSeedable(token, pairToken, 10, 0, 500_000e18);
        vm.expectRevert(PonsV2GraduationMath.ZeroAmount.selector);
        guard.assertSeedableEitherOrdering(10, 30e18, 0);
    }

    function test_zeroTokenAddressIsNotSeedable() public {
        vm.expectRevert(PonsV2GraduationGuard.GraduationSeedNotViable.selector);
        guard.assertSeedable(address(0), pairToken, 10, 30e18, 500_000e18);
    }

    function test_amountsAboveInt128Revert() public {
        uint256 tooBig = uint256(uint128(type(int128).max)) + 1;
        vm.expectRevert(PonsV2GraduationGuard.GraduationSeedNotViable.selector);
        guard.assertSeedable(token, pairToken, 10, tooBig, 1e18);
        vm.expectRevert(PonsV2GraduationGuard.GraduationSeedNotViable.selector);
        guard.assertSeedable(token, pairToken, 10, 1e18, tooBig);
    }

    function test_extremeProportionsAreRejected() public {
        // A seed whose sides are dozens of orders of magnitude apart cannot
        // mint: the guard models V4's rejection rather than passing it
        // through to the irreversible sweep phase.
        vm.expectRevert(PonsV2GraduationGuard.GraduationSeedNotViable.selector);
        guard.assertSeedable(token, pairToken, 10, 1e18, 1 << 200);
    }
}
