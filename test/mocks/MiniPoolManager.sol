// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, toBalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/**
 * @notice A deliberately small stand-in for Uniswap V4's PoolManager, scoped
 * to the surface PonsV2MemeHook actually drives: `unlock`/`unlockCallback`
 * dispatch, one exact-input constant-product `swap` with an afterSwap hook
 * callback, and `sync`/`settle`/`take` flash-accounting. It exists so the
 * hook's fee-take, internal conversion and buyback paths can be exercised
 * without the real (unvendored) PoolManager.
 *
 * Accounting model: one integer ledger per unlock context (keyed by the
 * account that called `unlock`). `swap` debits/credits that ledger for the
 * swapper and applies the hook's returned unspecified-currency delta against
 * it, `take` pays out a positive entry, `settle` credits what physically
 * arrived after `sync`. `unlock` reverts unless every touched entry returned
 * to zero, mirroring V4's no-open-deltas invariant. Pool holdings are the
 * mock's own token balances / ether balance, tracked in `reserves`.
 */
contract MiniPoolManager {
    using SafeERC20 for IERC20;

    error Locked();
    error NotUnlocked();
    error NotUnlocker();
    error OpenDelta(address currency, int256 amount);
    error ExactOutputUnsupported();
    error NothingSynced();

    bool public locked;
    address public unlocker;

    mapping(address unlocker => mapping(address currency => int256 amount)) public ledger;
    mapping(address currency => uint256 amount) public reserves;
    mapping(address caller => address currency) public lastSyncedCurrency;
    mapping(address caller => mapping(address currency => uint256 amount)) public syncedBalance;
    address[] private touched;
    mapping(address currency => bool) private isTouched;

    // ── Flash accounting core ────────────────────────────────────────────

    function unlock(bytes calldata data) external returns (bytes memory) {
        if (locked) revert Locked();
        locked = true;
        unlocker = msg.sender;
        delete touched;

        bytes memory result = IUnlockCallback(msg.sender).unlockCallback(data);

        for (uint256 i = 0; i < touched.length; ++i) {
            int256 remaining = ledger[msg.sender][touched[i]];
            if (remaining != 0) revert OpenDelta(touched[i], remaining);
        }

        locked = false;
        unlocker = address(0);
        return result;
    }

    function swap(PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external
        returns (BalanceDelta delta)
    {
        if (!locked) revert NotUnlocked();
        if (msg.sender != unlocker) revert NotUnlocker();
        if (params.amountSpecified >= 0) revert ExactOutputUnsupported();

        bool zeroForOne = params.zeroForOne;
        address inputCurrency = Currency.unwrap(zeroForOne ? key.currency0 : key.currency1);
        address outputCurrency = Currency.unwrap(zeroForOne ? key.currency1 : key.currency0);

        // Exact-input constant-product swap with a 0.3% synthetic LP fee; the
        // hook's own fee is charged separately through its afterSwap take.
        uint256 amountIn = uint256(-params.amountSpecified);
        uint256 inputReserve = reserves[inputCurrency];
        uint256 outputReserve = reserves[outputCurrency];
        uint256 amountOut =
            (amountIn * 997 * outputReserve) / (inputReserve * 1000 + amountIn * 997);

        reserves[inputCurrency] = inputReserve + amountIn;
        reserves[outputCurrency] = outputReserve - amountOut;

        // Credit the gross swap to the unlocker's ledger BEFORE the hook
        // runs, so the hook's own `take` of its fee draws against the
        // swapper's positive output entry — the way v4-core's currencyDelta
        // accounting behaves.
        _debit(inputCurrency, amountIn);
        _credit(outputCurrency, amountOut);

        // forge-lint: disable-next-line(unsafe-typecast)
        delta = zeroForOne
            ? toBalanceDelta(-int128(uint128(amountIn)), int128(uint128(amountOut)))
            : toBalanceDelta(int128(uint128(amountOut)), -int128(uint128(amountIn)));

        // v4-core skips a pool's hooks when the hook itself is the caller
        // (Hooks.afterSwap); the pons hook's internal conversions rely on
        // this so their legs are never taxed by their own pool.
        if (msg.sender == address(key.hooks)) {
            return delta;
        }

        (bytes4 selector, int128 hookDelta) =
            IHooks(key.hooks).afterSwap(msg.sender, key, params, delta, hookData);
        require(selector == IHooks.afterSwap.selector, "MiniPoolManager: bad afterSwap selector");

        if (hookDelta != 0) {
            // The hook has already collected its cut via `take` (which
            // debited this ledger); report the net delta to the swapper by
            // subtracting the cut from the unspecified leg.
            bool specifiedIsCurrency0 = (params.amountSpecified < 0) == params.zeroForOne;
            address feeCurrency =
                Currency.unwrap(specifiedIsCurrency0 ? key.currency1 : key.currency0);
            uint256 cut = hookDelta < 0 ? uint256(uint128(-hookDelta)) : uint256(uint128(hookDelta));
            if (feeCurrency == inputCurrency) {
                delta = zeroForOne
                    ? toBalanceDelta(-int128(uint128(amountIn + cut)), int128(uint128(amountOut)))
                    : toBalanceDelta(int128(uint128(amountOut)), -int128(uint128(amountIn + cut)));
            } else {
                delta = zeroForOne
                    ? toBalanceDelta(-int128(uint128(amountIn)), int128(uint128(amountOut - cut)))
                    : toBalanceDelta(int128(uint128(amountOut - cut)), -int128(uint128(amountIn)));
            }
        }

        return delta;
    }

    function take(Currency currency, address to, uint256 amount) external {
        if (!locked) revert NotUnlocked();
        address c = Currency.unwrap(currency);
        int256 entry = ledger[unlocker][c];
        // forge-lint: disable-next-line(unsafe-typecast)
        if (entry < int256(amount)) revert OpenDelta(c, entry);

        ledger[unlocker][c] = entry - int256(amount);
        reserves[c] -= amount;
        if (c == address(0)) {
            (bool sent,) = payable(to).call{value: amount}("");
            require(sent, "MiniPoolManager: native take failed");
        } else {
            IERC20(c).safeTransfer(to, amount);
        }
    }

    function sync(Currency currency) external {
        if (!locked) revert NotUnlocked();
        address c = Currency.unwrap(currency);
        lastSyncedCurrency[msg.sender] = c;
        syncedBalance[msg.sender][c] =
            c == address(0) ? address(this).balance : IERC20(c).balanceOf(address(this));
    }

    function settle() external payable returns (uint256 paid) {
        if (!locked) revert NotUnlocked();
        address c = lastSyncedCurrency[msg.sender];
        if (c == address(0) && !isTouched[c]) revert NothingSynced();
        paid = c == address(0)
            ? address(this).balance - syncedBalance[msg.sender][c]
            : _tokenDelta(c, syncedBalance[msg.sender][c]);
        _credit(c, paid);
        reserves[c] += paid;
        return paid;
    }

    // ── Pool funding / inspection helpers ────────────────────────────────

    // slot0.sqrtPriceX96 returned through StateLibrary's extsload view. The
    // hook reads it only to bound its internal swaps' price movement; the
    // mock's swap math is plain CPMM on reserves.
    uint160 public sqrtPriceX96;

    function setSqrtPriceX96(uint160 price) external {
        sqrtPriceX96 = price;
    }

    function extsload(bytes32) external view returns (bytes32) {
        // Only slot0 is consumed by the code under test; encode sqrtPriceX96
        // into the low 160 bits with tick and fee fields zero.
        return bytes32(uint256(sqrtPriceX96));
    }

    function fundNative() external payable {
        reserves[address(0)] += msg.value;
    }

    function fundToken(address token, uint256 amount) external {
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        reserves[token] += IERC20(token).balanceOf(address(this)) - before;
    }

    function poolReserve(address currency) external view returns (uint256) {
        return reserves[currency];
    }

    function currencyDeltaOf(address account, address currency) external view returns (int256) {
        return ledger[account][currency];
    }

    // ── Internals ────────────────────────────────────────────────────────

    function _debit(address currency, uint256 amount) private {
        _touch(currency);
        ledger[unlocker][currency] -= int256(amount);
    }

    function _credit(address currency, uint256 amount) private {
        if (amount == 0) return;
        _touch(currency);
        ledger[unlocker][currency] += int256(amount);
    }

    function _touch(address currency) private {
        if (!isTouched[currency]) {
            isTouched[currency] = true;
            touched.push(currency);
        }
    }

    function _tokenDelta(address c, uint256 before) private view returns (uint256) {
        uint256 nowBal = IERC20(c).balanceOf(address(this));
        return nowBal > before ? nowBal - before : 0;
    }

    receive() external payable {}
}
