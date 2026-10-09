// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PonsV2BondingCurveMath} from "contractsV2/src/v2/libraries/PonsV2BondingCurveMath.sol";

contract PonsV2BondingCurveMathTest is Test {
    using PonsV2BondingCurveMath for *;

    uint256 private constant BP = 10_000;

    /// @notice External wrapper so library reverts happen at a lower call
    /// depth, where vm.expectRevert can intercept them.
    function callGetAmountOut(uint256 a, uint256 ri, uint256 ro, uint256 f)
        external
        pure
        returns (uint256)
    {
        return PonsV2BondingCurveMath.getAmountOut(a, ri, ro, f);
    }

    function callGetAmountIn(uint256 o, uint256 ri, uint256 ro, uint256 f)
        external
        pure
        returns (uint256)
    {
        return PonsV2BondingCurveMath.getAmountIn(o, ri, ro, f);
    }

    function test_getAmountOut_matchesConstantProductWithFee() public pure {
        // 1000 in, 10_000/5_000 reserves, 3% fee:
        // out = (1000*9970*5000) / (10000*10000 + 1000*9970) = 4_982_510_731_752... (checked below)
        uint256 amountIn = 1000e18;
        uint256 out = PonsV2BondingCurveMath.getAmountOut(amountIn, 10_000e18, 5_000e18, 300);
        uint256 inWithFee = amountIn * (BP - 300);
        uint256 expected = (inWithFee * 5_000e18) / (10_000e18 * BP + inWithFee);
        assertEq(out, expected, "getAmountOut mismatch");
        // Fee must reduce output relative to a feeless trade.
        uint256 feeless = PonsV2BondingCurveMath.getAmountOut(amountIn, 10_000e18, 5_000e18, 0);
        assertGt(feeless, out, "fee must reduce output");
    }

    function test_getAmountOut_revertsOnZeroInputs() public {
        vm.expectRevert(PonsV2BondingCurveMath.InsufficientInputAmount.selector);
        this.callGetAmountOut(0, 1e18, 1e18, 100);
        vm.expectRevert(PonsV2BondingCurveMath.InsufficientLiquidity.selector);
        this.callGetAmountOut(1e18, 0, 1e18, 100);
        vm.expectRevert(PonsV2BondingCurveMath.InsufficientLiquidity.selector);
        this.callGetAmountOut(1e18, 1e18, 0, 100);
        vm.expectRevert(PonsV2BondingCurveMath.InsufficientOutputAmount.selector);
        // Dust trade against huge reserves rounds to zero output.
        this.callGetAmountOut(1, 1e30, 1e30, 10_000);
    }

    function test_quoteAmountOut_returnsZeroInsteadOfReverting() public pure {
        assertEq(PonsV2BondingCurveMath.quoteAmountOut(0, 1e18, 1e18, 100), 0);
        assertEq(PonsV2BondingCurveMath.quoteAmountOut(1e18, 0, 1e18, 100), 0);
        assertEq(PonsV2BondingCurveMath.quoteAmountOut(1e18, 1e18, 0, 100), 0);
        // A full-fee trade quotes to zero rather than reverting; the fold-back
        // path in the curve's sweep depends on this.
        assertEq(PonsV2BondingCurveMath.quoteAmountOut(1e18, 1e18, 1e18, BP), 0);
        assertGt(PonsV2BondingCurveMath.quoteAmountOut(1e18, 1e18, 1e18, 100), 0);
    }

    function test_getAmountIn_roundsUpToCoverExactOutput() public pure {
        uint256 amountIn = PonsV2BondingCurveMath.getAmountIn(1e18, 10_000e18, 5_000e18, 300);
        // Round-trip: the quoted input must produce at least the exact output.
        uint256 out = PonsV2BondingCurveMath.getAmountOut(amountIn, 10_000e18, 5_000e18, 300);
        assertGe(out, 1e18, "getAmountIn must round up to cover the exact output");
        // And one wei less must not.
        uint256 outLess =
            PonsV2BondingCurveMath.getAmountOut(amountIn - 1, 10_000e18, 5_000e18, 300);
        assertLt(outLess, 1e18, "input one wei lower must undershoot");
    }

    function test_getAmountIn_revertsOnUnachievableOutput() public {
        vm.expectRevert(PonsV2BondingCurveMath.InsufficientOutputAmount.selector);
        this.callGetAmountIn(0, 1e18, 1e18, 100);
        vm.expectRevert(PonsV2BondingCurveMath.InsufficientLiquidity.selector);
        this.callGetAmountIn(2e18, 1e18, 1e18, 100);
        vm.expectRevert(PonsV2BondingCurveMath.InsufficientLiquidity.selector);
        this.callGetAmountIn(1e18, 1e18, 2e18, BP);
    }

    function testFuzz_getAmountOut_monotonicInInput(
        uint128 amountIn,
        uint128 reserveIn,
        uint128 reserveOut,
        uint16 feeBps
    ) public pure {
        // Bound to production-plausible magnitudes: the library's raw
        // multiplication overflows for pathological uint128-maximum inputs,
        // which real curves cannot reach (supplies are int128-capped and
        // quote reserves scale with them).
        amountIn = uint128(bound(uint256(amountIn), 1, 1e30));
        reserveIn = uint128(bound(uint256(reserveIn), 1, 1e33));
        reserveOut = uint128(bound(uint256(reserveOut), 1, 1e33));
        feeBps = uint16(bound(uint256(feeBps), 0, 1999));

        // Use the non-reverting variant: dust trades against huge reserves
        // legitimately round to zero output.
        uint256 out1 =
            PonsV2BondingCurveMath.quoteAmountOut(amountIn, reserveIn, reserveOut, feeBps);
        uint256 out2 = PonsV2BondingCurveMath.quoteAmountOut(
            uint256(amountIn) + 1, reserveIn, reserveOut, feeBps
        );
        assertGe(out2, out1, "output must be monotonic in input");
        assertLe(out2, reserveOut, "output can never exceed the output reserve");
    }
}
