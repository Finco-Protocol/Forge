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
 * @notice Invariant suite for PonsV2BondingCurve under a randomized
 * buy/sell/sweep sequence with a dedicated trader actor. The protocol's
 * core accounting claims are checked after every action:
 *  1. The curve's native balance equals trackedQuote exactly (fees are a
 *     marker inside trackedQuote, not a separate pot).
 *  2. The token balance equals trackedTokens exactly.
 *  3. The quoted reserves stay internally consistent: the tradeable quote
 *     reserve never exceeds the physically held amount.
 *  4. Sold-then-bought-back supply never exceeds the minted supply.
 */
contract CurveInvariants is Test {
    MockFeeEscrow internal escrow;
    MockFeePolicy internal feePolicy;
    MockLaunchRecord internal launchRecord;
    PonsV2BuybackVault internal vault;
    PonsV2LauncherToken internal token;
    PonsV2BondingCurve internal curve;

    address internal creator = makeAddr("creator");
    address internal protocolRecipient = makeAddr("protocolRecipient");
    address internal operator;
    address internal trader = makeAddr("trader");

    uint256 internal constant SUPPLY = 1_000_000e18;
    uint256 internal constant PHANTOM_QUOTE = 30e18;
    uint256 internal constant THRESHOLD = 30e18;

    uint256[] internal quoteSpend;
    uint256[] internal tokenSell;
    uint256 internal ghost_tokenOutstanding;

    function setUp() public {
        escrow = new MockFeeEscrow();
        feePolicy = new MockFeePolicy(escrow);
        feePolicy.setProtocolRecipient(protocolRecipient);
        operator = feePolicy.operator();
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
                protocolFeeShareBps: 3_000,
                buybackBurnBps: 0, // no vault locks in the loop; sweep stays creator-safe
                hookFeeBps: 0,
                maxInternalPriceImpactBps: 300
            }),
            escrow,
            vault,
            PHANTOM_QUOTE,
            100,
            0,
            false,
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
        launchRecord.setCurve(address(token), address(curve));

        vm.deal(trader, 1_000_000e18);
        vm.startPrank(trader);
        token.approve(address(curve), type(uint256).max);
        vm.stopPrank();
    }

    function _buy(uint256 quoteIn) internal {
        if (quoteIn == 0) return;
        if (curve.readyToGraduate()) return;
        vm.prank(trader);
        try curve.buy{value: quoteIn}(quoteIn, 0, trader) returns (uint256 got) {
            ghost_tokenOutstanding += got;
        } catch {
            // Oversized buys near exhaustion can revert on slippage at the
            // clamp edge; the invariants must hold regardless.
        }
    }

    function _sell(uint256 tokenAmount) internal {
        uint256 held = token.balanceOf(trader);
        tokenAmount = tokenAmount > held ? held : tokenAmount;
        if (tokenAmount == 0 || curve.readyToGraduate()) return;
        vm.prank(trader);
        try curve.sell(tokenAmount, 0, trader) returns (uint256) {
            // received tokens return to the curve; outstanding drops
            ghost_tokenOutstanding -= tokenAmount;
        } catch {
            // readyToGraduate raced with the clamp; invariants still hold
        }
    }

    function _sweep() internal {
        vm.prank(creator);
        try curve.sweepFees(0) {} catch {}
    }

    function invariant_curveAccountingConservation() public {
        for (uint256 i = 0; i < 32; ++i) {
            uint256 action = vm.randomUint(0, 2);
            if (action == 0) {
                _buy(bound(vm.randomUint(0, 5e18), 0, 5e18));
            } else if (action == 1) {
                _sell(vm.randomUint(0, 10_000e18));
            } else {
                _sweep();
            }

            assertEq(
                address(curve).balance,
                curve.trackedQuote(),
                "native balance must equal tracked quote"
            );
            assertEq(
                token.balanceOf(address(curve)),
                curve.trackedTokens(),
                "token balance must equal tracked tokens"
            );
            assertLe(
                curve.realQuoteReserve(),
                curve.trackedQuote(),
                "tradeable quote cannot exceed physical holdings"
            );
            assertLe(ghost_tokenOutstanding, SUPPLY, "outstanding supply can never exceed the mint");
            (, uint256 tRes) = curve.getReserves();
            assertGe(tRes, curve.reservedTokens(), "the pool allocation must never be sold through");
        }
    }

    function invariant_afterGraduationCurveIsDrained() public {
        // Drive the curve to graduation exactly, then check terminal state.
        (uint256 qRes,) = curve.getReserves();
        uint256 huge = qRes * 4 + 1e18;
        vm.deal(trader, huge);
        vm.prank(trader);
        curve.buy{value: huge}(huge, 0, trader);
        assertTrue(curve.readyToGraduate());

        curve.graduate(address(this));
        assertTrue(curve.graduated());
        assertEq(curve.trackedQuote(), 0);
        assertEq(curve.trackedTokens(), 0);
        assertEq(token.balanceOf(address(curve)), 0);
        assertEq(address(curve).balance, 0);
    }

    receive() external payable {}
}
