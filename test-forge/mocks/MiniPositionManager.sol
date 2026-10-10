// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {MockPermit2} from "./MockPermit2.sol";
import {MiniPoolManagerW02} from "./MiniPoolManagerW02.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";

/**
 * @notice Minimal stand-in for Uniswap v4 PositionManager, scoped to the
 * W02 lifecycle path: modifyLiquidities with MINT_POSITION (full-range
 * mint on the MiniPoolManager), SETTLE_PAIR (pull both legs from the
 * caller via Permit2/native value), SWEEP (forward leftover balances),
 * nextTokenId, and poolManager() for the factory's wiring check. Positions
 * are ERC-721s minted to the caller-designated recipient (the locker), so
 * the lifecycle test can assert permanent custody.
 */
contract MiniPositionManager is ERC721 {
    using SafeERC20 for IERC20;

    uint256 private _nextId = 1;

    MiniPoolManagerW02 public immutable poolManager;
    MockPermit2 public immutable permit2;

    struct Position {
        PoolKey key;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        address owner;
    }

    mapping(uint256 tokenId => Position position) public positions;

    error UnknownAction(uint8 action);
    error NotUnlocker();
    error WrongCurrencyOrder();

    constructor(MiniPoolManagerW02 poolManager_, MockPermit2 permit2_) ERC721("MiniPosMgr", "MPM") {
        poolManager = poolManager_;
        permit2 = permit2_;
    }

    function modifyLiquidities(bytes calldata unlockData, uint256)
        external
        payable
        returns (bytes memory)
    {
        // The executor's argument is abi.encode(actions, params).
        (bytes memory actions, bytes[] memory params) = abi.decode(unlockData, (bytes, bytes[]));
        (
            PoolKey memory key,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 amount0Max,
            uint256 amount1Max,
            address recipient,,
            bool hasSweep
        ) = _decodeMint(actions, params);

        // Pull both legs from msg.sender (the graduation executor).
        bool hasNative = Currency.unwrap(key.currency0) == address(0);
        if (hasNative) {
            // native arrives as msg.value; refund nothing (executor sweeps)
            if (msg.value < amount0Max) revert("MPM: insufficient native");
        } else {
            permit2.transferFrom(
                msg.sender, address(this), uint160(amount0Max), Currency.unwrap(key.currency0)
            );
        }
        permit2.transferFrom(
            msg.sender, address(this), uint160(amount1Max), Currency.unwrap(key.currency1)
        );

        // Approve the pool manager for what we pulled, then credit the
        // pool's reserves (it pulls from us, mirroring v4 settlement).
        if (!hasNative) {
            IERC20(Currency.unwrap(key.currency0)).approve(address(poolManager), amount0Max);
        }
        IERC20(Currency.unwrap(key.currency1)).approve(address(poolManager), amount1Max);
        poolManager.mintLiquidity(key, amount0Max, amount1Max, address(this));

        uint256 tokenId = _nextId++;
        positions[tokenId] = Position({
            key: key,
            tickLower: tickLower,
            tickUpper: tickUpper,
            liquidity: liquidity,
            owner: recipient
        });
        _mint(recipient, tokenId);

        // SWEEP leg (present when native): forward leftover native to the
        // executor-designated sweeper.
        if (hasSweep && address(this).balance != 0) {
            (, address sweeper) = abi.decode(params[2], (Currency, address));
            (bool sent,) = payable(sweeper).call{value: address(this).balance}("");
            require(sent, "MPM: sweep failed");
        }
        return "";
    }

    function nextTokenId() external view returns (uint256) {
        return _nextId;
    }

    function _parseActions(bytes calldata actions) internal pure returns (uint8[] memory) {
        uint256 count = actions.length;
        uint8[] memory acts = new uint8[](count);
        for (uint256 i = 0; i < count; ++i) {
            acts[i] = uint8(actions[i]);
        }
        return acts;
    }

    function _decodeMint(bytes memory actions, bytes[] memory params)
        internal
        pure
        returns (
            PoolKey memory key,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 amount0Max,
            uint256 amount1Max,
            address recipient,
            bytes[] memory paramsOut,
            bool hasSweep
        )
    {
        hasSweep = actions.length == 3;
        (key, tickLower, tickUpper, liquidity, amount0Max, amount1Max, recipient,) = abi.decode(
            params[0], (PoolKey, int24, int24, uint128, uint256, uint256, address, bytes)
        );
        paramsOut = params;
    }

    function _countActions(bytes calldata actions) internal pure returns (uint256 count) {
        // The executor's params array begins after the action bytes; locate
        // it by decoding from the tail: the executor always appends
        // abi.encode(params) after the action bytes, and the params array
        // length prefix (0x20) sits at a known position relative to the end.
        // Instead of fragile offsets, the executor's own layout is fixed:
        // MINT(1) + SETTLE(1) + optional SWEEP(1). Detect SWEEP by checking
        // whether actions[2] is a plausible action byte (0x10 SWEEP) vs the
        // 0x20 offset marker of the params array.
        count = 2;
        if (actions.length > 2 && uint8(actions[2]) == uint8(Actions.SWEEP)) count = 3;
    }
}
