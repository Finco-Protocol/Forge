// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {MiniPoolManagerW02} from "./MiniPoolManagerW02.sol";

/// @notice TEST-ONLY exact-input swap router for the W02 mini pool manager, so
/// sandbox E2E (W04) can trade a graduated Forge pool from an EOA and exercise
/// the REAL PonsV2MemeHook fee path. Never part of any deployable stack.
contract SandboxSwapRouter is IUnlockCallback {
    MiniPoolManagerW02 public immutable manager;

    PoolKey private _key;
    bool private _zeroForOne;
    uint256 private _amountIn;
    address private _payer;
    address private _recipient;

    constructor(MiniPoolManagerW02 manager_) {
        manager = manager_;
    }

    function swapExactIn(PoolKey calldata key, bool zeroForOne, uint256 amountIn, address recipient)
        external
        payable
    {
        _key = key;
        _zeroForOne = zeroForOne;
        _amountIn = amountIn;
        _payer = msg.sender;
        _recipient = recipient;
        manager.unlock("");
        delete _key;
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(manager), "only manager");
        BalanceDelta delta = manager.swap(
            _key,
            SwapParams({
                zeroForOne: _zeroForOne, amountSpecified: -int256(_amountIn), sqrtPriceLimitX96: 0
            }),
            ""
        );
        _settle(_key.currency0, delta.amount0());
        _settle(_key.currency1, delta.amount1());
        return "";
    }

    function _settle(Currency c, int128 amount) private {
        if (amount < 0) {
            uint256 owed = uint256(uint128(-amount));
            manager.sync(c);
            if (Currency.unwrap(c) == address(0)) {
                manager.settle{value: owed}();
            } else {
                IERC20(Currency.unwrap(c)).transferFrom(_payer, address(manager), owed);
                manager.settle();
            }
        } else if (amount > 0) {
            manager.take(c, _recipient, uint256(uint128(amount)));
        }
    }

    receive() external payable {}
}
