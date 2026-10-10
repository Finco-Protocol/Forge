// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MiniPoolManager} from "./MiniPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @notice Extends the W01 MiniPoolManager with the surfaces the W02
 * graduation path drives: `initialize(key, sqrtPriceX96)` (mirroring
 * v4-core's selector) and `mintLiquidity` for the full-range seed, so
 * post-graduation trading and hook fee accounting operate on real pooled
 * balances.
 */
contract MiniPoolManagerW02 is MiniPoolManager {
    using SafeERC20 for IERC20;
    error AlreadyInitialized();

    mapping(bytes32 poolId => bool initialized) public isInitialized;
    mapping(bytes32 poolId => uint160 sqrtPriceX96) public poolPrice;

    function initialize(PoolKey calldata key, uint160 sqrtPriceX96) external returns (int24) {
        bytes32 id = PoolId.unwrap(key.toId());
        if (isInitialized[id]) revert AlreadyInitialized();
        isInitialized[id] = true;
        poolPrice[id] = sqrtPriceX96;
        sqrtPriceX96 = sqrtPriceX96; // mirror the v4 selector's return
        return 0;
    }

    /// @notice Credits a full-range mint: pulls both legs from the caller
    /// (the MiniPositionManager, which collected them via Permit2/native)
    /// into the pool's own balances, mirroring v4-core settlement.
    function mintLiquidity(PoolKey calldata key, uint256 amount0, uint256 amount1, address payer)
        external
    {
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        if (c0 == address(0)) {
            reserves[c0] += amount0; // native arrived as msg.value via the caller
        } else {
            IERC20(c0).safeTransferFrom(payer, address(this), amount0);
            reserves[c0] += amount0;
        }
        IERC20(c1).safeTransferFrom(payer, address(this), amount1);
        reserves[c1] += amount1;
    }
}
