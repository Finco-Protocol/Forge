// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PonsV2BondingCurve} from "contractsV2/src/v2/PonsV2BondingCurve.sol";
import {PonsV2LauncherToken} from "contractsV2/src/v2/PonsV2LauncherToken.sol";
import {PonsV2BuybackVault} from "contractsV2/src/v2/PonsV2BuybackVault.sol";
import {FeePolicySnapshot} from "contractsV2/src/v2/interfaces/ILaunchpadV2.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockFeeEscrow, MockFeePolicy, MockLaunchRecord} from "./mocks/MockFeeEscrow.sol";

/**
 * @notice Unit suite for PonsV2BondingCurve. The production factory does not
 * compile (see docs/BUILD.md), so this suite plays the factory's role
 * directly: the test contract is constructed as the curve's `factory` and
 * calls the onlyFactory surface the real factory would drive. Factory-side
 * launch orchestration itself is recorded as untestable in docs/BUILD.md.
 */
contract PonsV2BondingCurveTest is Test {
    MockFeeEscrow internal escrow;
    MockFeePolicy internal feePolicy;
    MockLaunchRecord internal launchRecord;
    PonsV2BuybackVault internal vault;
    PonsV2LauncherToken internal token;
    PonsV2BondingCurve internal curve;

    address internal creator = makeAddr("creator");
    address internal protocolRecipient = makeAddr("protocolRecipient");
    address internal operator = makeAddr("operator");
    address internal buyer = makeAddr("buyer");

    uint256 internal constant SUPPLY = 1_000_000e18;
    uint256 internal constant PHANTOM_QUOTE = 30e18;
    uint256 internal constant THRESHOLD = 30e18;
    uint16 internal constant FEE_BPS = 100; // 1%
    uint16 internal constant TAX_BPS = 100; // 1%
    uint16 internal constant PROTOCOL_SHARE = 3_000; // 30%
    uint16 internal constant BUYBACK_SHARE = 5_000; // 50%
    uint16 internal constant MAX_IMPACT = 300; // 3%

    uint256 internal reservedTokens;

    function setUp() public {
        escrow = new MockFeeEscrow();
        feePolicy = new MockFeePolicy(escrow);
        feePolicy.setProtocolRecipient(protocolRecipient);
        feePolicy.setOperator(operator);
        launchRecord = new MockLaunchRecord();
        vault = new PonsV2BuybackVault(makeAddr("vaultOwner"), feePolicy, escrow);
        vm.prank(address(vault.owner()));
        vault.setFactory(address(launchRecord));

        curve = new PonsV2BondingCurve(
            address(0),
            creator,
            address(this),
            feePolicy,
            FeePolicySnapshot({
                protocolFeeRecipient: protocolRecipient,
                protocolFeeShareBps: PROTOCOL_SHARE,
                buybackBurnBps: BUYBACK_SHARE,
                hookFeeBps: 0,
                maxInternalPriceImpactBps: MAX_IMPACT
            }),
            escrow,
            vault,
            PHANTOM_QUOTE,
            FEE_BPS,
            TAX_BPS,
            true,
            THRESHOLD
        );
        token = new PonsV2LauncherToken(
            "MEME",
            "MEME",
            "",
            "",
            PonsV2LauncherToken.Socials("", "", "", "", ""),
            creator,
            address(curve),
            address(this),
            SUPPLY
        );
        curve.initialize(address(token));
        reservedTokens = (SUPPLY * PHANTOM_QUOTE) / (PHANTOM_QUOTE + THRESHOLD);
        launchRecord.setCurve(address(token), address(curve));
    }

    // ── Initialization ───────────────────────────────────────────────────

    function test_initializeOnlyFactoryAndOnce() public {
        PonsV2BondingCurve fresh = new PonsV2BondingCurve(
            address(0),
            creator,
            address(this),
            feePolicy,
            _policy(),
            escrow,
            vault,
            PHANTOM_QUOTE,
            FEE_BPS,
            TAX_BPS,
            true,
            THRESHOLD
        );
        vm.prank(creator);
        vm.expectRevert(PonsV2BondingCurve.NotFactory.selector);
        fresh.initialize(address(token));

        PonsV2LauncherToken tk = new PonsV2LauncherToken(
            "M2",
            "M2",
            "",
            "",
            PonsV2LauncherToken.Socials("", "", "", "", ""),
            creator,
            address(fresh),
            address(this),
            SUPPLY
        );
        fresh.initialize(address(tk));
        vm.expectRevert(PonsV2BondingCurve.AlreadyInitialized.selector);
        fresh.initialize(address(tk));
    }

    function test_initializeFixesReservedAllocation() public view {
        assertEq(curve.reservedTokens(), reservedTokens, "reserved share must be supply*P/(P+T)");
        assertEq(curve.trackedTokens(), SUPPLY, "curve must track the entire minted supply");
        assertEq(token.balanceOf(address(curve)), SUPPLY);
        assertEq(curve.sellableTokens(), SUPPLY - reservedTokens);
    }

    function test_initializeRejectsRoundedAwayAllocation() public {
        PonsV2BondingCurve tiny = new PonsV2BondingCurve(
            address(0),
            creator,
            address(this),
            feePolicy,
            _policy(),
            escrow,
            vault,
            1,
            FEE_BPS,
            TAX_BPS,
            true,
            1e30
        );
        PonsV2LauncherToken tk = new PonsV2LauncherToken(
            "M3",
            "M3",
            "",
            "",
            PonsV2LauncherToken.Socials("", "", "", "", ""),
            creator,
            address(tiny),
            address(this),
            SUPPLY
        );
        vm.expectRevert(PonsV2BondingCurve.InvalidLaunchEconomics.selector);
        tiny.initialize(address(tk));
    }

    // ── Buying ───────────────────────────────────────────────────────────

    function test_buy_happyPathChargesFeeAndTaxOnQuoteLeg() public {
        uint256 quoteIn = 1e18;
        uint256 fee = (quoteIn * FEE_BPS) / 10_000;
        uint256 tax = (quoteIn * TAX_BPS) / 10_000;
        (uint256 qRes, uint256 tRes) = curve.getReserves();
        uint256 expectedOut = (quoteIn * (10_000 - FEE_BPS - TAX_BPS) * tRes)
            / (10_000 * qRes + quoteIn * (10_000 - FEE_BPS - TAX_BPS));

        vm.deal(buyer, quoteIn);
        vm.prank(buyer);
        uint256 got = curve.buy{value: quoteIn}(quoteIn, expectedOut, buyer);

        assertEq(got, expectedOut, "tokens out must match the CPMM quote net of fee+tax");
        assertEq(token.balanceOf(buyer), expectedOut);
        assertEq(address(curve).balance, quoteIn, "curve must hold the full spent quote");
        assertEq(curve.trackedQuote(), quoteIn);
        assertEq(curve.trackedTokens(), SUPPLY - expectedOut);
        assertEq(curve.quoteFeeBalance(), fee, "base fee must accrue on the quote leg");
        assertEq(curve.creatorTaxBalance(), tax, "creator tax must accrue on the quote leg");
        // Buyback earmark: (fee - fee*30%) * 50%
        uint256 creatorSlice = fee - (fee * PROTOCOL_SHARE) / 10_000;
        assertEq(curve.buybackQuoteBalance(), (creatorSlice * BUYBACK_SHARE) / 10_000);
    }

    function test_buy_nativeValueMismatchReverts() public {
        vm.deal(buyer, 2e18);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(PonsV2BondingCurve.NativeValueMismatch.selector, 2e18, 1e18)
        );
        curve.buy{value: 2e18}(1e18, 0, buyer);
    }

    function test_buy_overSizedBuyClampsAtSellableAndRefunds() public {
        (uint256 qRes, uint256 tRes) = curve.getReserves();
        // A buy that would consume every sellable token.
        uint256 huge = qRes * 4;
        vm.deal(buyer, huge);
        vm.prank(buyer);
        uint256 got = curve.buy{value: huge}(huge, 0, buyer);

        assertEq(got, SUPPLY - reservedTokens, "fill must stop at the reserved allocation");
        assertLt(address(curve).balance, huge, "unused quote must be refunded");
        assertEq(
            address(curve).balance, curve.trackedQuote(), "curve balance must equal tracked quote"
        );
        assertEq(curve.readyToGraduate(), true, "sellable exhaustion must arm graduation");
        // Trading is closed on both sides once the allocation is exhausted.
        vm.deal(buyer, 1e18);
        vm.prank(buyer);
        vm.expectRevert(PonsV2BondingCurve.CurveGraduated.selector);
        curve.buy{value: 1e18}(1e18, 0, buyer);
    }

    function test_buy_slippageBoundIsOnPriceNotQuantity() public {
        (uint256 qRes, uint256 tRes) = curve.getReserves();
        uint256 quoteIn = 1e18;
        uint256 netIn = quoteIn * (10_000 - FEE_BPS - TAX_BPS);
        uint256 expectedOut = (netIn * tRes) / (qRes * 10_000 + netIn);

        // A full fill must honour tokensOut >= minTokensOut strictly.
        vm.deal(buyer, quoteIn);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                PonsV2BondingCurve.SlippageExceeded.selector, expectedOut, expectedOut + 1
            )
        );
        curve.buy{value: quoteIn}(quoteIn, expectedOut + 1, buyer);
    }

    function test_buy_recipientReceivesTokensNotCaller() public {
        address recipient = makeAddr("recipient");
        vm.deal(buyer, 1e18);
        vm.prank(buyer);
        uint256 got = curve.buy{value: 1e18}(1e18, 0, recipient);
        assertEq(token.balanceOf(recipient), got);
        assertEq(token.balanceOf(buyer), 0);
    }

    // ── Selling ──────────────────────────────────────────────────────────

    function test_sell_happyPathChargesFeeOnQuoteOutput() public {
        test_buy_happyPathChargesFeeAndTaxOnQuoteLeg();
        uint256 feeBefore = curve.quoteFeeBalance();
        uint256 taxBefore = curve.creatorTaxBalance();
        uint256 tokensIn = token.balanceOf(buyer);
        (uint256 qRes, uint256 tRes) = curve.getReserves();
        uint256 gross = (tokensIn * qRes) / (tRes + tokensIn);
        uint256 fee = (gross * FEE_BPS) / 10_000;
        uint256 tax = (gross * TAX_BPS) / 10_000;
        uint256 expectedQuoteOut = gross - fee - tax;

        vm.startPrank(buyer);
        token.approve(address(curve), type(uint256).max);
        uint256 ethBefore = buyer.balance;
        uint256 got = curve.sell(tokensIn, expectedQuoteOut, buyer);
        vm.stopPrank();

        assertEq(got, expectedQuoteOut);
        assertEq(buyer.balance, ethBefore + expectedQuoteOut);
        assertEq(curve.quoteFeeBalance() - feeBefore, fee, "sell fee accrues on the quote leg");
        assertEq(curve.creatorTaxBalance() - taxBefore, tax);
        assertEq(curve.trackedTokens(), SUPPLY, "sold tokens return to the tracked reserve");
    }

    function test_sell_blockedAfterSellableExhausted() public {
        test_buy_overSizedBuyClampsAtSellableAndRefunds();
        uint256 held = token.balanceOf(buyer);
        vm.startPrank(buyer);
        token.approve(address(curve), type(uint256).max);
        vm.expectRevert(PonsV2BondingCurve.CurveGraduated.selector);
        curve.sell(held, 0, buyer);
        vm.stopPrank();
    }

    function test_sell_minQuoteOutEnforced() public {
        test_buy_happyPathChargesFeeAndTaxOnQuoteLeg();
        uint256 tokensIn = token.balanceOf(buyer);
        (uint256 qRes, uint256 tRes) = curve.getReserves();
        uint256 gross = (tokensIn * qRes) / (tRes + tokensIn);
        uint256 fee = (gross * FEE_BPS) / 10_000;
        uint256 tax = (gross * TAX_BPS) / 10_000;
        uint256 quoteOut = gross - fee - tax;

        vm.startPrank(buyer);
        token.approve(address(curve), type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(
                PonsV2BondingCurve.SlippageExceeded.selector, quoteOut, type(uint256).max
            )
        );
        curve.sell(tokensIn, type(uint256).max, buyer);
        vm.stopPrank();
    }

    // ── Fee sweeps ───────────────────────────────────────────────────────

    function test_sweepFees_onlyCreatorOrOperator() public {
        vm.deal(buyer, 1e18);
        vm.prank(buyer);
        curve.buy{value: 1e18}(1e18, 0, buyer);

        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(PonsV2BondingCurve.NotFeeSweepOperator.selector);
        curve.sweepFees(0);

        // Creator may sweep only while no buyback is pending; one buy has
        // earmarked buyback quote, so the creator is refused.
        vm.prank(creator);
        vm.expectRevert(PonsV2BondingCurve.InternalSwapRequiresOperator.selector);
        curve.sweepFees(0);
    }

    function test_sweepFees_splitsProtocolBuybackCreatorAndLocksBuyback() public {
        vm.deal(buyer, 10e18);
        vm.prank(buyer);
        curve.buy{value: 10e18}(10e18, 0, buyer);

        uint256 fee = curve.quoteFeeBalance();
        uint256 earmark = curve.buybackQuoteBalance();
        uint256 protocol = (fee * PROTOCOL_SHARE) / 10_000;
        uint256 buyback = earmark;
        // Price-impact bound: buyback*10000/(qRes+buyback) <= 300.
        (uint256 qRes, uint256 tRes) = curve.getReserves();
        uint256 movement = (buyback * 10_000) / (qRes + buyback);
        assertLe(movement, MAX_IMPACT, "test sized so the buyback executes");

        // Operator must supply an output floor.
        vm.prank(operator);
        vm.expectRevert(PonsV2BondingCurve.MinimumOutputRequired.selector);
        curve.sweepFees(0);

        (uint256 tokensOut) = (buyback * 9970 * tRes) / (qRes * 10_000 + buyback * 9970);
        vm.prank(operator);
        curve.sweepFees(tokensOut);

        assertEq(escrow.balanceOf(protocolRecipient), protocol, "protocol leg credited in escrow");
        assertGt(escrow.balanceOf(creator), 0, "creator leg credited in escrow");
        assertGt(vault.totalLocked(address(token)), 0, "buyback must land in the vault");
        assertEq(curve.quoteFeeBalance(), 0);
        assertEq(curve.buybackQuoteBalance(), 0);
        assertEq(curve.creatorTaxBalance(), 0);
        assertEq(token.balanceOf(address(vault)), vault.totalLocked(address(token)));
        assertLt(curve.trackedTokens(), SUPPLY - tokensOut + 1);
    }

    function test_sweepFees_foldsBuybackBackWhenImpactTooHigh() public {
        // The curve's price-impact bound is an immutable snapshot, so the
        // fold-back has to be reached through economics, not by mutating the
        // policy: a 10% base fee with 0% protocol share and a 100% buyback
        // share makes the earmark 10% of every trade while the reserve only
        // grows ~9% net per trade, so a trade sized near the tiny phantom
        // reserve pushes the 300bps movement bound.
        MockFeePolicy aggressivePolicy = new MockFeePolicy(escrow);
        aggressivePolicy.setProtocolRecipient(protocolRecipient);
        aggressivePolicy.setOperator(operator);
        aggressivePolicy.setProtocolFeeShareBps(0);
        aggressivePolicy.setBuybackBurnBps(10_000);

        PonsV2BondingCurve c = new PonsV2BondingCurve(
            address(0),
            creator,
            address(this),
            aggressivePolicy,
            _aggressiveSnapshot(),
            escrow,
            vault,
            1e18,
            1_000,
            0,
            true,
            1e18
        );
        PonsV2LauncherToken tk = new PonsV2LauncherToken(
            "M6",
            "M6",
            "",
            "",
            PonsV2LauncherToken.Socials("", "", "", "", ""),
            creator,
            address(c),
            address(this),
            SUPPLY
        );
        c.initialize(address(tk));
        launchRecord.setCurve(address(tk), address(c));

        vm.deal(buyer, 1e18);
        vm.prank(buyer);
        c.buy{value: 1e18}(1e18, 0, buyer);

        uint256 fee = c.quoteFeeBalance();
        assertEq(fee, 0.1e18, "10% fee on the 1 ETH spent");
        // Reserve movement would be ~0.1/(1.0+0.9) = ~526bps > 300bps.
        (uint256 qRes,) = c.getReserves();
        assertGt(
            (fee * 10_000) / (qRes + fee), 300, "test must size the earmark past the impact bound"
        );

        vm.prank(operator);
        c.sweepFees(1);

        // Whole creator bucket paid out; nothing locked in the vault. The
        // earmark is a marker on part of the bucket, not an addition: the
        // fold-back returns it, so the creator nets exactly their bucket.
        assertEq(
            vault.totalLocked(address(tk)),
            0,
            "buyback must fold back when impact bound cannot hold"
        );
        assertEq(escrow.balanceOf(protocolRecipient), 0, "zero protocol share");
        assertEq(escrow.balanceOf(creator), 0.1e18, "creator bucket with the earmark folded back");
        assertEq(c.quoteFeeBalance(), 0);
        assertEq(c.creatorTaxBalance(), 0);
    }

    function test_sweepFees_emptySweepIsNoop() public {
        vm.prank(operator);
        curve.sweepFees(1);
        assertEq(escrow.balanceOf(protocolRecipient), 0);
    }

    function test_sweepFees_revertsOnceGraduated() public {
        _graduateFully();
        vm.prank(operator);
        vm.expectRevert(PonsV2BondingCurve.AlreadyGraduated.selector);
        curve.sweepFees(1);
    }

    // ── Graduation ───────────────────────────────────────────────────────

    function test_graduate_onlyFactoryAndOnlyWhenReady() public {
        vm.prank(buyer);
        vm.expectRevert(PonsV2BondingCurve.NotFactory.selector);
        curve.graduate(buyer);
        vm.expectRevert(PonsV2BondingCurve.NotReadyToGraduate.selector);
        curve.graduate(address(this));
    }

    function test_graduate_handsReservesToRecipientAndHaltsTrading() public {
        _graduateFully();
        assertTrue(curve.graduated());
        assertEq(curve.trackedQuote(), 0);
        assertEq(curve.trackedTokens(), 0);
        // The recipient (this test, as factory-sim) holds the reserves.
        assertGt(address(this).balance, 0);
        assertEq(token.balanceOf(address(this)), reservedTokens);
        vm.deal(buyer, 1e18);
        vm.prank(buyer);
        vm.expectRevert(PonsV2BondingCurve.CurveGraduated.selector);
        curve.buy{value: 1e18}(1e18, 0, buyer);
    }

    function test_graduationSweepSkipsBuybackAndPaysWholeCreatorBucket() public {
        // Buys earmark buyback quote; graduation's internal sweep runs with
        // executeBuyback=false, so the entire creator bucket (earmark
        // included) plus tax goes to the creator, and the vault gets nothing.
        vm.deal(buyer, 200e18);
        vm.startPrank(buyer);
        curve.buy{value: 1e18}(1e18, 0, buyer);
        curve.buy{value: 1e18}(1e18, 0, buyer);
        // Exhaust the sellable allocation (clamped, refunded) so the curve is
        // ready to graduate with buyback quote pending.
        (uint256 qRes,) = curve.getReserves();
        uint256 huge = qRes * 4;
        vm.deal(buyer, huge);
        curve.buy{value: huge}(huge, 0, buyer);
        vm.stopPrank();

        uint256 feeTotal = curve.quoteFeeBalance();
        uint256 taxTotal = curve.creatorTaxBalance();
        assertGt(curve.buybackQuoteBalance(), 0, "earmarks must be pending");
        uint256 protocol = (feeTotal * PROTOCOL_SHARE) / 10_000;

        curve.graduate(address(this));
        assertEq(escrow.balanceOf(protocolRecipient), protocol);
        assertEq(escrow.balanceOf(creator), feeTotal - protocol + taxTotal);
        assertEq(vault.totalLocked(address(token)), 0, "graduation must skip the buyback leg");
    }

    // ── Rescue path ──────────────────────────────────────────────────────

    function test_rescueFees_paysRecipientsDirectly() public {
        vm.deal(buyer, 1e18);
        vm.prank(buyer);
        curve.buy{value: 1e18}(1e18, 0, buyer);

        uint256 fee = curve.quoteFeeBalance();
        uint256 tax = curve.creatorTaxBalance();
        uint256 protocol = (fee * PROTOCOL_SHARE) / 10_000;
        uint256 creatorOut = fee - protocol + tax;

        curve.rescueFees();
        assertEq(protocolRecipient.balance, protocol, "rescue bypasses the escrow");
        assertEq(creator.balance, creatorOut);
        assertEq(curve.quoteFeeBalance(), 0);
        assertEq(curve.creatorTaxBalance(), 0);
        assertEq(curve.buybackQuoteBalance(), 0, "earmark must not survive a rescue");
    }

    function test_rescueFees_onlyFactory() public {
        vm.prank(buyer);
        vm.expectRevert(PonsV2BondingCurve.NotFactory.selector);
        curve.rescueFees();
        vm.expectRevert(PonsV2BondingCurve.ZeroAmount.selector);
        curve.rescueFees();
    }

    // ── Creator controls ─────────────────────────────────────────────────

    function test_setCreatorFeeRecipient_onlyFactory() public {
        vm.prank(creator);
        vm.expectRevert(PonsV2BondingCurve.NotFactory.selector);
        curve.setCreatorFeeRecipient(makeAddr("newCreator"));
        curve.setCreatorFeeRecipient(makeAddr("newCreator"));
        assertEq(curve.deployer(), makeAddr("newCreator"));
    }

    function test_setBuybackEnabled_onlyFactory() public {
        vm.prank(creator);
        vm.expectRevert(PonsV2BondingCurve.NotFactory.selector);
        curve.setBuybackEnabled(false);
        curve.setBuybackEnabled(false);
        assertFalse(curve.buybackEnabled());
    }

    // ── ERC-20 pair variant ──────────────────────────────────────────────

    function test_erc20Pair_endToEndAccounting() public {
        MockERC20 pair = new MockERC20("PAIR", "PAIR", 18, address(0), 0);
        PonsV2BondingCurve c = new PonsV2BondingCurve(
            address(pair),
            creator,
            address(this),
            feePolicy,
            _policy(),
            escrow,
            vault,
            PHANTOM_QUOTE,
            FEE_BPS,
            TAX_BPS,
            false,
            THRESHOLD
        );
        PonsV2LauncherToken tk = new PonsV2LauncherToken(
            "M4",
            "M4",
            "",
            "",
            PonsV2LauncherToken.Socials("", "", "", "", ""),
            creator,
            address(c),
            address(this),
            SUPPLY
        );
        c.initialize(address(tk));

        pair.mint(buyer, 10e18);
        vm.deal(buyer, 1);
        vm.startPrank(buyer);
        pair.approve(address(c), type(uint256).max);
        c.buy(1e18, 0, buyer);
        // Value sent with an ERC-20 pair is refused.
        vm.expectRevert(PonsV2BondingCurve.UnexpectedNativeValue.selector);
        c.buy{value: 1}(1e18, 0, buyer);
        // Sell back for the pair asset.
        uint256 balance = tk.balanceOf(buyer);
        tk.approve(address(c), type(uint256).max);
        c.sell(balance, 0, buyer);
        vm.stopPrank();

        assertGt(pair.balanceOf(buyer), 9e18, "seller must receive quote net of fees");
        // Tracked quote must equal the physical balance: pending fees are a
        // marker inside trackedQuote, not a separate pot.
        assertEq(c.trackedQuote(), pair.balanceOf(address(c)));
    }

    function test_erc20PairFeeOnTransfer_creditsWhatArrived() public {
        MockERC20 pair = new MockERC20("FOF", "FOF", 18, makeAddr("sink"), 1_000); // 10% tax
        PonsV2BondingCurve c = new PonsV2BondingCurve(
            address(pair),
            creator,
            address(this),
            feePolicy,
            _policy(),
            escrow,
            vault,
            PHANTOM_QUOTE,
            0,
            0,
            false,
            THRESHOLD
        );
        PonsV2LauncherToken tk = new PonsV2LauncherToken(
            "M5",
            "M5",
            "",
            "",
            PonsV2LauncherToken.Socials("", "", "", "", ""),
            creator,
            address(c),
            address(this),
            SUPPLY
        );
        c.initialize(address(tk));

        pair.mint(buyer, 10e18);
        vm.startPrank(buyer);
        pair.approve(address(c), type(uint256).max);
        c.buy(1e18, 0, buyer);
        vm.stopPrank();

        // Only 0.9e18 arrived after the 10% tax; pricing must not count the
        // missing 0.1e18.
        assertEq(pair.balanceOf(address(c)), 0.9e18);
        assertEq(c.realQuoteReserve(), 0.9e18);
        (uint256 qRes,) = c.getReserves();
        assertEq(qRes, PHANTOM_QUOTE + 0.9e18);
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    function _policy() internal view returns (FeePolicySnapshot memory) {
        return FeePolicySnapshot({
            protocolFeeRecipient: protocolRecipient,
            protocolFeeShareBps: PROTOCOL_SHARE,
            buybackBurnBps: BUYBACK_SHARE,
            hookFeeBps: 0,
            maxInternalPriceImpactBps: MAX_IMPACT
        });
    }

    function _aggressiveSnapshot() internal view returns (FeePolicySnapshot memory) {
        return FeePolicySnapshot({
            protocolFeeRecipient: protocolRecipient,
            protocolFeeShareBps: 0,
            buybackBurnBps: 10_000,
            hookFeeBps: 0,
            maxInternalPriceImpactBps: MAX_IMPACT
        });
    }

    function _graduateFully() internal {
        (uint256 qRes,) = curve.getReserves();
        uint256 huge = qRes * 4;
        vm.deal(buyer, huge);
        vm.prank(buyer);
        curve.buy{value: huge}(huge, 0, buyer);
        curve.graduate(address(this));
    }

    receive() external payable {}
}
