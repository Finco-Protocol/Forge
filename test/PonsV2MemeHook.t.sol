// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PonsV2MemeHook} from "contractsV2/src/v2/hooks/PonsV2MemeHook.sol";
import {PonsV2BuybackVault} from "contractsV2/src/v2/PonsV2BuybackVault.sol";
import {FeePolicySnapshot} from "contractsV2/src/v2/interfaces/ILaunchpadV2.sol";
import {MiniPoolManager} from "./mocks/MiniPoolManager.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockFeeEscrow} from "./mocks/MockFeeEscrow.sol";
import {HookDeployer} from "./mocks/HookDeployer.sol";
import {ImmutableState} from "@uniswap/v4-periphery/src/base/ImmutableState.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";

/**
 * @notice Unit suite for PonsV2MemeHook against a mini PoolManager that
 * reproduces the flash-accounting the hook programs against: unlock dispatch
 * (which only ever calls back into the unlocker), exact-input CPMM swap with
 * an afterSwap hook delta charged to the swapper, and sync/settle/take. The
 * hook is CREATE2-deployed at an address whose low 14 bits carry exactly its
 * permission flags, as BaseHook's constructor demands.
 */
contract PonsV2MemeHookTest is Test, IUnlockCallback {
    MiniPoolManager internal pm;
    MockFeeEscrow internal escrow;
    PonsV2MemeHook internal hook;
    PonsV2BuybackVault internal vault;
    MockERC20 internal memecoin;
    MockERC20 internal quote;
    HookDeployer internal deployer;

    PoolKey internal key;
    bool internal memecoinIsCurrency0;

    address internal hookOwner = makeAddr("hookOwner");
    address internal creator = makeAddr("creator");
    address internal protocolRecipient = makeAddr("protocolRecipient");
    address internal operator = makeAddr("operator");
    address internal stranger = makeAddr("stranger");
    address internal vaultOwner = makeAddr("vaultOwner");

    uint16 internal constant HOOK_FEE_BPS = 100; // 1%
    uint16 internal constant CREATOR_TAX_BPS = 100; // 1%
    uint16 internal constant PROTOCOL_SHARE = 3_000;
    uint16 internal constant BUYBACK_SHARE = 5_000;
    uint16 internal constant MAX_IMPACT = 300;

    // Swap-driver state consumed by this contract's own unlockCallback.
    bool internal swapMode;
    bool internal zeroForOne;
    uint256 internal swapAmountIn;
    PoolKey internal swapKey;

    function setUp() public {
        escrow = new MockFeeEscrow();
        pm = new MiniPoolManager();
        memecoin = new MockERC20("MEME", "MEME", 18, address(0), 0);
        quote = new MockERC20("QUOTE", "QUOTE", 18, address(0), 0);
        deployer = new HookDeployer();

        hook = _deployHookAtFlaggedAddress();

        // The vault treats the hook as feePolicy, exactly as production does,
        // which is what authorizes the hook's buyback locks.
        vault = new PonsV2BuybackVault(vaultOwner, hook, escrow);
        vm.startPrank(hookOwner);
        hook.setFactory(address(this));
        hook.setBuybackVault(vault);
        hook.setFeeSweepOperator(operator);
        vm.stopPrank();
        vm.prank(vaultOwner);
        vault.setFactory(address(this));

        // Register a pool: sorted currencies, meme hook as IHooks, zero core
        // LP fee (the hook charges instead), tick spacing 10.
        memecoinIsCurrency0 = address(memecoin) < address(quote);
        key = PoolKey({
            currency0: memecoinIsCurrency0 ? Currency.wrap(address(memecoin)) : Currency.wrap(address(quote)),
            currency1: memecoinIsCurrency0 ? Currency.wrap(address(quote)) : Currency.wrap(address(memecoin)),
            fee: 0,
            tickSpacing: 10,
            hooks: hook
        });
        hook.registerPool(key, address(memecoin), creator, creator, CREATOR_TAX_BPS, true, _policy());

        // Seed 1 quote : 1000 token and publish the matching slot0 price so
        // the hook's internal price-impact bound operates on a real figure.
        uint256 qAmt = 10e18;
        uint256 mAmt = 10_000e18;
        quote.mint(address(this), qAmt);
        memecoin.mint(address(this), mAmt);
        quote.approve(address(pm), type(uint256).max);
        memecoin.approve(address(pm), type(uint256).max);
        pm.fundToken(address(quote), qAmt);
        pm.fundToken(address(memecoin), mAmt);
        uint256 price = memecoinIsCurrency0
            ? FullMath.mulDiv(qAmt, 1 << 192, mAmt)
            : FullMath.mulDiv(mAmt, 1 << 192, qAmt);
        pm.setSqrtPriceX96(uint160(Math_.sqrt(price)));

        // Trading inventory for this contract (the driver of all swaps).
        quote.mint(address(this), 1_000e18);
        memecoin.mint(address(this), 1_000_000e18);
        quote.approve(address(pm), type(uint256).max);
        memecoin.approve(address(pm), type(uint256).max);
    }

    // ── Deployment / registration ────────────────────────────────────────

    function _deployHookAtFlaggedAddress() internal returns (PonsV2MemeHook) {
        bytes memory initCode = abi.encodePacked(
            type(PonsV2MemeHook).creationCode,
            abi.encode(IPoolManager(address(pm)), escrow, protocolRecipient, hookOwner)
        );
        bytes32 initCodeHash = keccak256(initCode);
        uint160 flags =
            uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);
        bytes32 salt = 0;
        while (uint160(_create2Address(salt, initCodeHash, address(deployer))) & 0x3FFF != flags) {
            salt = bytes32(uint256(salt) + 1);
        }
        return PonsV2MemeHook(payable(deployer.deploy(initCode, salt)));
    }

    function _create2Address(bytes32 salt, bytes32 initCodeHash, address deployer)
        internal
        pure
        returns (address)
    {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
    }

    function test_hookAddressCarriesPermissionFlags() public view {
        uint160 flags =
            uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);
        assertEq(uint160(address(hook)) & 0x3FFF, flags, "hook address must encode its permissions");
    }

    function test_registerPool_onlyFactory() public {
        vm.prank(creator);
        vm.expectRevert(PonsV2MemeHook.NotFactory.selector);
        hook.registerPool(key, address(memecoin), creator, creator, 0, true, _policy());
    }

    function test_registerPool_rejectsDuplicateAndInvalidKeys() public {
        vm.expectRevert(PonsV2MemeHook.AlreadyRegistered.selector);
        hook.registerPool(key, address(memecoin), creator, creator, 0, true, _policy());

        PoolKey memory foreign = key;
        foreign.hooks = IHooks(makeAddr("notThisHook"));
        vm.expectRevert(PonsV2MemeHook.InvalidPoolKey.selector);
        hook.registerPool(foreign, address(memecoin), creator, creator, 0, true, _policy());

        PoolKey memory missingMeme = PoolKey({
            currency0: Currency.wrap(address(quote)),
            currency1: Currency.wrap(makeAddr("other")),
            fee: 0,
            tickSpacing: 10,
            hooks: hook
        });
        vm.expectRevert(PonsV2MemeHook.InvalidPoolKey.selector);
        hook.registerPool(missingMeme, address(memecoin), creator, creator, 0, true, _policy());
    }

    function test_registerPool_enforcesPolicyCeilings() public {
        PoolKey memory k = PoolKey({
            currency0: Currency.wrap(address(memecoin)),
            currency1: Currency.wrap(makeAddr("zquote2")),
            fee: 0,
            tickSpacing: 10,
            hooks: hook
        });

        FeePolicySnapshot memory bad = _policy();
        bad.protocolFeeShareBps = 5_001; // above the 50% ceiling
        vm.expectRevert(PonsV2MemeHook.InvalidBps.selector);
        hook.registerPool(k, address(memecoin), creator, creator, 0, true, bad);

        vm.expectRevert(PonsV2MemeHook.InvalidBps.selector);
        hook.registerPool(k, address(memecoin), creator, creator, 1_901, true, _policy()); // tax + hook fee > 20%
    }

    // ── Swap fee collection ──────────────────────────────────────────────

    function test_afterSwap_takesFeeAndTaxIntoPendingBuckets() public {
        (uint256 grossOut, uint256 received) = _buyTokens(1e18);

        // Exact-input quote->token swap: the unspecified leg is the token
        // side, so fee and tax accrue in MEMECOIN.
        PoolId poolId = key.toId();
        uint256 pendingFee = hook.pendingFees(poolId, address(memecoin));
        uint256 pendingTax = hook.pendingCreatorTax(poolId, address(memecoin));
        assertGt(pendingFee, 0, "hook fee must accrue in the output currency");
        assertGt(pendingTax, 0, "creator tax must accrue in the output currency");
        assertEq(pendingFee, (grossOut * HOOK_FEE_BPS) / 10_000, "fee must be the configured cut");
        assertEq(pendingTax, (grossOut * CREATOR_TAX_BPS) / 10_000, "tax must be the configured cut");
        // The trader received exactly gross output minus both cuts.
        assertEq(received, grossOut - pendingFee - pendingTax, "swapper must pay the hook's cuts");
        // Buyback earmark: (fee - fee*30%) * 50%
        uint256 creatorSlice = pendingFee - (pendingFee * PROTOCOL_SHARE) / 10_000;
        assertEq(hook.pendingBuyback(poolId, address(memecoin)), (creatorSlice * BUYBACK_SHARE) / 10_000);
    }

    function test_afterSwap_quoteDenominatedFeesAccrueInQuote() public {
        (uint256 grossOut, uint256 received) = _sellTokens(1_000e18);

        PoolId poolId = key.toId();
        uint256 pendingFee = hook.pendingFees(poolId, address(quote));
        uint256 pendingTax = hook.pendingCreatorTax(poolId, address(quote));
        assertGt(pendingFee, 0, "sell-side fee must accrue in quote");
        assertEq(pendingFee, (grossOut * HOOK_FEE_BPS) / 10_000);
        assertEq(received, grossOut - pendingFee - pendingTax);
        assertEq(hook.pendingFees(poolId, address(memecoin)), 0, "no memecoin-denominated fee on sells");
    }

    // ── Sweep / distribute ───────────────────────────────────────────────

    function test_sweepPoolFees_creatorMayDistributeQuoteBalancesOnly() public {
        // A pool with buyback disabled accrues no earmark, so quote-side
        // fees can be distributed by the creator alone. (With buyback on,
        // the earmark rides the fee bucket and demands the operator.)
        MockERC20 quote2 = new MockERC20("QUOTE2", "Q2", 18, address(0), 0);
        PoolKey memory k2 = PoolKey({
            currency0: memecoinIsCurrency0 ? Currency.wrap(address(memecoin)) : Currency.wrap(address(quote2)),
            currency1: memecoinIsCurrency0 ? Currency.wrap(address(quote2)) : Currency.wrap(address(memecoin)),
            fee: 0,
            tickSpacing: 10,
            hooks: hook
        });
        hook.registerPool(k2, address(memecoin), creator, creator, CREATOR_TAX_BPS, false, _policy());
        quote2.mint(address(this), 110e18);
        quote2.approve(address(pm), type(uint256).max);
        pm.fundToken(address(quote2), 10e18);
        memecoin.approve(address(pm), type(uint256).max);

        // Sell tokens into pool2: fees accrue in quote2 with no earmark.
        (uint256 grossOut, uint256 received) = _sellTokensOn(k2, 1_000e18);
        PoolId poolId2 = k2.toId();
        uint256 fee = hook.pendingFees(poolId2, address(quote2));
        uint256 tax = hook.pendingCreatorTax(poolId2, address(quote2));
        assertGt(fee, 0);
        assertEq(received, grossOut - fee - tax);
        assertEq(hook.pendingBuyback(poolId2, address(quote2)), 0, "no earmark while buyback is off");

        vm.prank(creator);
        hook.sweepPoolFees(poolId2, 0, 0);

        uint256 protocol = (fee * PROTOCOL_SHARE) / 10_000;
        assertEq(escrow.balanceOfToken(protocolRecipient, address(quote2)), protocol);
        assertEq(escrow.balanceOfToken(creator, address(quote2)), fee - protocol + tax);
        assertEq(hook.pendingFees(poolId2, address(quote2)), 0);

        // A stranger cannot sweep someone else's pool at all ' the
        // authorization check runs before any pending-balance logic.
        vm.prank(stranger);
        vm.expectRevert(PonsV2MemeHook.NotFeeSweepOperator.selector);
        hook.sweepPoolFees(poolId2, 0, 0);
    }

    function test_sweepPoolFees_memecoinFeesRequireOperator() public {
        test_afterSwap_takesFeeAndTaxIntoPendingBuckets();
        PoolId poolId = key.toId();
        vm.prank(creator);
        vm.expectRevert(PonsV2MemeHook.InternalSwapRequiresOperator.selector);
        hook.sweepPoolFees(poolId, 0, 0);
        vm.prank(stranger);
        vm.expectRevert(PonsV2MemeHook.NotFeeSweepOperator.selector);
        hook.sweepPoolFees(poolId, 0, 0);
    }

    function test_sweepPoolFees_operatorConvertsMemecoinFeesToQuote() public {
        test_afterSwap_takesFeeAndTaxIntoPendingBuckets();
        PoolId poolId = key.toId();

        // A floor of zero is refused outright whenever a conversion would run.
        vm.prank(operator);
        vm.expectRevert(PonsV2MemeHook.MinimumOutputRequired.selector);
        hook.sweepPoolFees(poolId, 0, 0);

        // The buyback executes whenever quote inventory exists, so both the
        // conversion floor and the buyback floor must be supplied.
        vm.prank(operator);
        hook.sweepPoolFees(poolId, 1 wei, 1 wei);

        // Everything distributed in quote through the escrow.
        assertEq(hook.pendingFees(poolId, address(memecoin)), 0);
        assertEq(hook.pendingCreatorTax(poolId, address(memecoin)), 0);
        assertGt(escrow.balanceOfToken(protocolRecipient, address(quote)), 0);
        assertGt(escrow.balanceOfToken(creator, address(quote)), 0);
        // The buyback earmark executed in memecoin and reached the vest.
        assertGt(vault.totalLocked(address(memecoin)), 0, "buyback earmark must reach the vault");
        assertEq(memecoin.balanceOf(address(vault)), vault.totalLocked(address(memecoin)));
    }

    function test_sweepPoolFees_impossibleConversionFloorRevertsAndKeepsBuckets() public {
        test_afterSwap_takesFeeAndTaxIntoPendingBuckets();
        PoolId poolId = key.toId();
        uint256 pendingFee = hook.pendingFees(poolId, address(memecoin));
        uint256 pendingTax = hook.pendingCreatorTax(poolId, address(memecoin));
        uint256 pendingBuyback = hook.pendingBuyback(poolId, address(memecoin));

        vm.prank(operator);
        vm.expectRevert();
        hook.sweepPoolFees(poolId, type(uint256).max / 2, 0);

        assertEq(hook.pendingFees(poolId, address(memecoin)), pendingFee, "fee bucket must survive the revert");
        assertEq(hook.pendingCreatorTax(poolId, address(memecoin)), pendingTax);
        assertEq(hook.pendingBuyback(poolId, address(memecoin)), pendingBuyback);
    }

    function test_sweepPoolFees_unknownPoolReverts() public {
        PoolId unknown = PoolKey({
            currency0: Currency.wrap(makeAddr("a")),
            currency1: Currency.wrap(makeAddr("b")),
            fee: 0,
            tickSpacing: 1,
            hooks: hook
        }).toId();
        vm.expectRevert(PonsV2MemeHook.UnknownPool.selector);
        hook.sweepPoolFees(unknown, 0, 0);
    }

    // ── Rescue path ──────────────────────────────────────────────────────

    function test_rescuePoolFees_ownerBypassesEscrow() public {
        test_afterSwap_quoteDenominatedFeesAccrueInQuote();
        PoolId poolId = key.toId();
        uint256 fee = hook.pendingFees(poolId, address(quote));
        uint256 tax = hook.pendingCreatorTax(poolId, address(quote));
        uint256 protocolAmount = (fee * PROTOCOL_SHARE) / 10_000;

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        hook.rescuePoolFees(poolId);

        vm.prank(hookOwner);
        hook.rescuePoolFees(poolId);

        assertEq(quote.balanceOf(protocolRecipient), protocolAmount);
        assertEq(quote.balanceOf(creator), fee - protocolAmount + tax);
        assertEq(hook.pendingFees(poolId, address(quote)), 0);
    }

    // ── Creator controls ─────────────────────────────────────────────────

    function test_setCreatorFeeRecipient_onlyFactory() public {
        PoolId poolId = key.toId();
        vm.prank(creator);
        vm.expectRevert(PonsV2MemeHook.NotFactory.selector);
        hook.setCreatorFeeRecipient(poolId, makeAddr("x"));

        address next = makeAddr("nextCreator");
        hook.setCreatorFeeRecipient(poolId, next);
        (, , , , address creatorNow, , , , , , , ,) = hook.launches(poolId);
        assertEq(creatorNow, next);
    }

    function test_setBuybackEnabled_onlyFactory() public {
        PoolId poolId = key.toId();
        vm.prank(creator);
        vm.expectRevert(PonsV2MemeHook.NotFactory.selector);
        hook.setBuybackEnabled(poolId, false);

        hook.setBuybackEnabled(poolId, false);
        (bool registered, , , , , , , , , , , , bool buybackNow) = hook.launches(poolId);
        assertTrue(registered);
        assertFalse(buybackNow);
    }

    // ── unlockCallback trust boundary ────────────────────────────────────

    function test_unlockCallback_revertsForNonPoolManager() public {
        // The conversion machinery must only run inside the PoolManager's
        // unlock context, and V4's unlock only ever calls the unlocker's own
        // callback — so the hook's callback is reachable only through its own
        // operator/creator-gated sweep path.
        bytes memory data = abi.encode(key.toId(), PonsV2MemeHook.SwapDirection.MemecoinToQuote, 1e18);
        vm.expectRevert(ImmutableState.NotPoolManager.selector);
        hook.unlockCallback(data);
    }

    // ── Policy setters ───────────────────────────────────────────────────

    function test_policySetters_onlyOwnerAndBounded() public {
        vm.startPrank(hookOwner);
        hook.setProtocolFeeShareBps(4_000);
        hook.setHookFeeBps(1_000);
        hook.setBuybackBurnBps(10_000);
        hook.setMaxInternalPriceImpactBps(500);
        vm.stopPrank();

        vm.prank(hookOwner);
        vm.expectRevert(PonsV2MemeHook.InvalidBps.selector);
        hook.setProtocolFeeShareBps(5_001);
        vm.prank(hookOwner);
        vm.expectRevert(PonsV2MemeHook.InvalidBps.selector);
        hook.setHookFeeBps(1_001);
        vm.prank(hookOwner);
        vm.expectRevert(PonsV2MemeHook.InvalidBps.selector);
        hook.setMaxInternalPriceImpactBps(0);

        FeePolicySnapshot memory snap = hook.currentFeePolicy();
        assertEq(snap.protocolFeeShareBps, 4_000);
        assertEq(snap.hookFeeBps, 1_000);
    }

    // ── Swap driver: this contract is the unlocker ───────────────────────

    function _buyTokens(uint256 amountIn) internal returns (uint256 grossOut, uint256 received) {
        return _buyTokensOn(key, amountIn);
    }

    function _sellTokens(uint256 amountIn) internal returns (uint256 grossOut, uint256 received) {
        return _sellTokensOn(key, amountIn);
    }

    function _buyTokensOn(PoolKey memory k, uint256 amountIn) internal returns (uint256 grossOut, uint256 received) {
        bool zfo = Currency.unwrap(k.currency0) != address(memecoin);
        grossOut = _quoteGross(k, zfo, amountIn);
        uint256 balBefore = memecoin.balanceOf(address(this));
        swapMode = true;
        swapKey = k;
        zeroForOne = zfo;
        swapAmountIn = amountIn;
        pm.unlock("");
        swapMode = false;
        received = memecoin.balanceOf(address(this)) - balBefore;
    }

    function _sellTokensOn(PoolKey memory k, uint256 amountIn) internal returns (uint256 grossOut, uint256 received) {
        bool zfo = Currency.unwrap(k.currency0) == address(memecoin);
        grossOut = _quoteGross(k, zfo, amountIn);
        uint256 balBefore = quoteCurrencyOf(k).balanceOf(address(this));
        swapMode = true;
        swapKey = k;
        zeroForOne = zfo;
        swapAmountIn = amountIn;
        pm.unlock("");
        swapMode = false;
        received = quoteCurrencyOf(k).balanceOf(address(this)) - balBefore;
    }

    function quoteCurrencyOf(PoolKey memory k) internal view returns (MockERC20) {
        return Currency.unwrap(k.currency0) == address(memecoin)
            ? MockERC20(Currency.unwrap(k.currency1))
            : MockERC20(Currency.unwrap(k.currency0));
    }

    function _quoteGross(PoolKey memory k, bool zeroForOne_, uint256 amountIn) internal view returns (uint256) {
        address inputCurrency = Currency.unwrap(zeroForOne_ ? k.currency0 : k.currency1);
        address outputCurrency = Currency.unwrap(zeroForOne_ ? k.currency1 : k.currency0);
        uint256 inReserve = pm.poolReserve(inputCurrency);
        uint256 outReserve = pm.poolReserve(outputCurrency);
        return (amountIn * 997 * outReserve) / (inReserve * 1000 + amountIn * 997);
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(pm), "only manager");
        if (!swapMode) return "";
        SwapParams memory p =
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(swapAmountIn), sqrtPriceLimitX96: 0});
        BalanceDelta delta = pm.swap(swapKey, p, "");
        _settleLeg(delta);
        return "";
    }

    function _settleLeg(BalanceDelta delta) internal {
        int128 a0 = delta.amount0();
        int128 a1 = delta.amount1();
        if (a0 < 0) _payIn(Currency.unwrap(swapKey.currency0), uint256(uint128(-a0)));
        if (a1 < 0) _payIn(Currency.unwrap(swapKey.currency1), uint256(uint128(-a1)));
        if (a0 > 0) pm.take(swapKey.currency0, address(this), uint256(uint128(a0)));
        if (a1 > 0) pm.take(swapKey.currency1, address(this), uint256(uint128(a1)));
    }

    function _payIn(address currency, uint256 amount) internal {
        if (currency == address(0)) return;
        pm.sync(Currency.wrap(currency));
        IERC20(currency).transfer(address(pm), amount);
        pm.settle();
    }

    function _policy() internal view returns (FeePolicySnapshot memory) {
        return FeePolicySnapshot({
            protocolFeeRecipient: protocolRecipient,
            protocolFeeShareBps: PROTOCOL_SHARE,
            buybackBurnBps: BUYBACK_SHARE,
            hookFeeBps: HOOK_FEE_BPS,
            maxInternalPriceImpactBps: MAX_IMPACT
        });
    }
}

library Math_ {
    function sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        uint256 y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
        return y;
    }
}
