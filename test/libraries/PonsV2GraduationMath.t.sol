// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PonsV2GraduationMath} from "contractsV2/src/v2/libraries/PonsV2GraduationMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

contract PonsV2GraduationMathTest is Test {
    uint256 internal constant Q96 = 1 << 96;

    /// @notice External wrapper so library reverts happen at a lower call
    /// depth, where vm.expectRevert can intercept them.
    function callSqrtPrice(uint256 amount0, uint256 amount1) external pure returns (uint160) {
        return PonsV2GraduationMath.sqrtPriceX96FromAmounts(amount0, amount1);
    }

    function test_sqrtPriceX96FromAmounts_matchesPriceRatio() public pure {
        uint256 amount0 = 10_000e18;
        uint256 amount1 = 40_000e18;
        uint160 sqrtPriceX96 = PonsV2GraduationMath.sqrtPriceX96FromAmounts(amount0, amount1);

        // Expected: sqrt(amount1/amount0) * 2^96 = sqrt(4) * 2^96 = 2 * 2^96.
        assertApproxEqRel(uint256(sqrtPriceX96), 2 * Q96, 1e15, "sqrt price mismatch for 4x ratio");
    }

    function test_sqrtPriceX96FromAmounts_revertsOnZeroAmounts() public {
        vm.expectRevert(PonsV2GraduationMath.ZeroAmount.selector);
        this.callSqrtPrice(0, 1);
        vm.expectRevert(PonsV2GraduationMath.ZeroAmount.selector);
        this.callSqrtPrice(1, 0);
    }

    function test_sqrtPriceX96FromAmounts_largeRatioUsesQ128Path() public pure {
        // amount1/amount0 = 2^70 exceeds the Q192 quotient's representable
        // range (2^64), forcing the Q128 fallback. Expected price:
        // sqrt(2^70) * 2^96 = 2^35 * 2^96 = 2^131.
        uint256 amount0 = 1;
        uint256 amount1 = 1 << 70;
        uint160 sqrtPriceX96 = PonsV2GraduationMath.sqrtPriceX96FromAmounts(amount0, amount1);
        assertEq(uint256(sqrtPriceX96), uint256(1) << 131, "Q128 path should yield the exact power-of-two price");
    }

    function test_sqrtPriceX96FromAmounts_revertsWhenRatioUnrepresentable() public {
        // amount1/amount0 = 2^160 exceeds even the Q128 fallback's ceiling.
        vm.expectRevert(PonsV2GraduationMath.UnsupportedPrice.selector);
        this.callSqrtPrice(1, 1 << 160);
    }

    function testFuzz_sqrtPriceX96FromAmounts_consistentWithAmounts(uint128 amount0, uint128 amount1) public {
        amount0 = uint128(bound(uint256(amount0), 1e6, type(uint128).max));
        amount1 = uint128(bound(uint256(amount1), 1, type(uint128).max));
        // Keep the ratio inside the Q192 representable band so the expected
        // value below cannot overflow its Q192 quotient (the Q128 fallback
        // has dedicated tests above).
        vm.assume(uint256(amount1) < uint256(amount0) * (1 << 40));

        uint160 sqrtPriceX96 = PonsV2GraduationMath.sqrtPriceX96FromAmounts(amount0, amount1);
        assertGt(uint256(sqrtPriceX96), 0);

        // sqrtPrice^2/2^96 must approximate (amount1/amount0) * 2^96. The
        // square of a floored sqrt loses relative precision as the price
        // itself shrinks, so the tolerance scales with the price magnitude.
        uint256 priceSquaredOverQ96 = FullMath.mulDiv(uint256(sqrtPriceX96), uint256(sqrtPriceX96), Q96);
        uint256 expected = FullMath.mulDiv(uint256(amount1), Q96, uint256(amount0));
        uint256 tolerance = uint256(sqrtPriceX96) < 1e18 ? 5e16 : 1e15;
        assertApproxEqRel(priceSquaredOverQ96, expected, tolerance);
    }

    function test_seedPriceDeterminism_exactPair() public pure {
        // At graduation the curve holds reserved = supply*P/(P+T) tokens
        // against T of real quote; the pool seeds with
        // poolTokens = reserved*T/(T+P) tokens plus T of quote. The seeded
        // price T/poolTokens equals the curve's terminal trade price
        // (P+T)/reserved, which is the determinism the factory promises.
        uint256 supply = 1_000_000e18;
        uint256 P = 30e18;
        uint256 T = 30e18;
        uint256 reserved = FullMath.mulDiv(supply, P, P + T);
        uint256 poolTokens = FullMath.mulDiv(reserved, T, T + P);

        uint160 seeded = PonsV2GraduationMath.sqrtPriceX96FromAmounts(poolTokens, T);
        uint160 expected = uint160(Math.sqrt(FullMath.mulDiv(P + T, 1 << 192, reserved)));
        assertApproxEqRel(uint256(seeded), uint256(expected), 1e15, "seed price deviates from terminal price");
    }
}
