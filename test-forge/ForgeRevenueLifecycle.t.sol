// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MiniPoolManagerW02} from "./mocks/MiniPoolManagerW02.sol";
import {MiniPositionManager} from "./mocks/MiniPositionManager.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";
import {HookDeployer} from "./mocks/HookDeployer.sol";
import {ForgeTestToken} from "./mocks/ForgeTestToken.sol";
import {AttestationHelpers} from "./ForgeRevenueSplitter.t.sol";

import {PonsV2FeeEscrow} from "contractsV2-forge/src/v2/PonsV2FeeEscrow.sol";
import {PonsV2MemeHook} from "contractsV2-forge/src/v2/hooks/PonsV2MemeHook.sol";
import {PonsV2BuybackVault} from "contractsV2-forge/src/v2/PonsV2BuybackVault.sol";
import {PonsV2LaunchLocker} from "contractsV2-forge/src/v2/PonsV2LaunchLocker.sol";
import {PonsV2LaunchFactory} from "contractsV2-forge/src/v2/PonsV2LaunchFactory.sol";
import {PonsV2LaunchDeployer} from "contractsV2-forge/src/v2/PonsV2LaunchDeployer.sol";
import {PonsV2GraduationExecutor} from "contractsV2-forge/src/v2/PonsV2GraduationExecutor.sol";
import {PonsV2BondingCurve} from "contractsV2-forge/src/v2/PonsV2BondingCurve.sol";
import {PonsV2LauncherToken} from "contractsV2-forge/src/v2/PonsV2LauncherToken.sol";
import {ForgeBindingRegistry} from "contractsV2-forge/src/v2/forge/ForgeBindingRegistry.sol";
import {ForgeLaunchAuthorizer} from "contractsV2-forge/src/v2/forge/ForgeLaunchAuthorizer.sol";
import {IForgeLaunchAuthorizer} from "contractsV2-forge/src/v2/forge/IForgeLaunchAuthorizer.sol";
import {
    ForgeProtocolRevenueSplitter
} from "contractsV2-forge/src/v2/forge/ForgeProtocolRevenueSplitter.sol";
import {GraduationPhase} from "contractsV2-forge/src/v2/interfaces/ILaunchpadV2.sol";

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Vm} from "forge-std/Vm.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/**
 * @title ForgeRevenueLifecycleTest
 * @notice W04 end-to-end economics over the REAL Forge-owned stack with the
 * CANONICAL PonsV2FeeEscrow (not the W02 mock) and the
 * ForgeProtocolRevenueSplitter as the hook's protocol fee recipient:
 *
 *   factory → curve → (sweep) → escrow → splitter → treasury/reserve
 *   graduation → V4 pool → hook → (sweep) → escrow → splitter
 *
 * No financial contract is modified; the splitter only receives the protocol
 * leg the frozen launch snapshot already routes to its address.
 *
 * Correction A: pulls are bounded by an attested eligible-revenue ceiling.
 * `_attestEligible` is a test-side model of the off-chain attestor: it
 * recomputes the cumulative eligible protocol-leg credits ONLY from the
 * canonical escrow's own `Credited`/`CreditedToken` events whose depositor is
 * an ELIGIBLE Forge curve (30% snapshot naming the splitter) or the Forge
 * hook sweeping an eligible launch's pool, and signs the ceiling.
 */
contract ForgeRevenueLifecycleTest is AttestationHelpers, IUnlockCallback {
    MiniPoolManagerW02 internal poolManager;
    MiniPositionManager internal positionManager;
    MockPermit2 internal permit2;
    PonsV2FeeEscrow internal escrow;
    PonsV2MemeHook internal hook;
    PonsV2BuybackVault internal vault;
    PonsV2LaunchLocker internal locker;
    PonsV2LaunchFactory internal factory;
    ForgeBindingRegistry internal registry;
    ForgeLaunchAuthorizer internal authorizer;
    ForgeProtocolRevenueSplitter internal splitter;
    ForgeTestToken internal usdx;

    uint256 internal attestorPk = 0xA77E57;
    mapping(address curve => bool) internal eligibleCurve;
    mapping(address token => bool) internal eligibleLaunch;
    mapping(bytes32 poolId => address memecoin) internal poolToken;
    mapping(address asset => uint256) internal attested;
    mapping(address asset => uint64) internal attestNonce;

    uint256 internal authorityPk = 0xA11CE;
    address internal authority;
    uint256 internal creatorPk = 0xC0DEC0DE;
    address internal creator;
    address internal governance = makeAddr("governance");
    address internal treasury = makeAddr("treasury");
    address internal buyer = makeAddr("buyer");

    uint64 internal constant REPO_ID = 42;
    uint64 internal nextNonce;

    PoolKey internal swapKey;
    bool internal swapZeroForOne;
    uint256 internal swapAmountIn;
    address internal swapBeneficiary;

    struct LaunchOpts {
        address pairToken;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        bytes32 salt;
        uint256 value;
    }

    function setUp() public {
        authority = vm.addr(authorityPk);
        creator = vm.addr(creatorPk);
        poolManager = new MiniPoolManagerW02();
        permit2 = new MockPermit2();
        positionManager = new MiniPositionManager(poolManager, permit2);
        escrow = new PonsV2FeeEscrow();
        splitter =
            new ForgeProtocolRevenueSplitter(escrow, governance, treasury, vm.addr(attestorPk));
        vm.recordLogs();

        HookDeployer hookDeployer = new HookDeployer();
        bytes memory hookInit = abi.encodePacked(
            type(PonsV2MemeHook).creationCode,
            abi.encode(IPoolManager(address(poolManager)), escrow, address(splitter), governance)
        );
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        bytes32 salt = 0;
        while (
            uint160(_create2(salt, keccak256(hookInit), address(hookDeployer))) & 0x3FFF != flags
        ) {
            salt = bytes32(uint256(salt) + 1);
        }
        hook = PonsV2MemeHook(payable(hookDeployer.deploy(hookInit, salt)));
        vault = new PonsV2BuybackVault(governance, hook, escrow);
        locker = new PonsV2LaunchLocker(governance, address(positionManager));
        registry = new ForgeBindingRegistry(authority);
        authorizer = new ForgeLaunchAuthorizer(registry, authority);
        factory = new PonsV2LaunchFactory(
            governance,
            IPoolManager(address(poolManager)),
            IPositionManager(address(positionManager)),
            IAllowanceTransfer(address(permit2)),
            locker,
            hook,
            escrow,
            vault,
            authorizer,
            0
        );
        PonsV2LaunchDeployer launchDeployer = new PonsV2LaunchDeployer(address(factory));
        PonsV2GraduationExecutor executor = new PonsV2GraduationExecutor(
            IPositionManager(address(positionManager)),
            IAllowanceTransfer(address(permit2)),
            locker,
            address(factory)
        );
        authorizer.setForgeFactory(address(factory));
        usdx = new ForgeTestToken("USD X", "USDX");

        vm.startPrank(governance);
        hook.setFactory(address(factory));
        hook.setBuybackVault(vault);
        vault.setFactory(address(factory));
        locker.setFactory(address(factory));
        factory.setLaunchDeployer(launchDeployer);
        factory.setGraduationExecutor(executor);
        factory.setLaunchFee(0);
        factory.setSnipeTaxStartBps(0);
        factory.addLaunchConfig(
            PonsV2LaunchFactory.LaunchConfig({
                supply: 1_000_000e18,
                curveFeeBps: 100,
                phantomQuote: 30e18,
                graduationThreshold: 30e18,
                poolFee: 0,
                tickSpacing: 10,
                enabled: true
            })
        );
        factory.setPairTokenEconomics(address(usdx), 30e18, 30e18, 18);
        factory.setPairTokenApproved(address(usdx), true);
        factory.setLaunchEnabled(true);
        splitter.setForgeFactory(address(factory));
        splitter.setAssetApproved(address(usdx), true);
        vm.stopPrank();

        _bind();
    }

    // ── helpers ──────────────────────────────────────────────────────────

    function _create2(bytes32 s, bytes32 initHash, address d) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), d, s, initHash)))));
    }

    function _bind() internal {
        ForgeBindingRegistry.BindingOp memory op = ForgeBindingRegistry.BindingOp({
            githubRepoId: REPO_ID,
            creator: creator,
            bindingExpiresAt: uint64(block.timestamp + 30 days),
            opDeadline: uint64(block.timestamp + 5 minutes),
            opNonce: registry.operationSequence(REPO_ID) + 1,
            parentOpDigest: registry.headOpDigest(REPO_ID),
            repoFullName: "finco/forge",
            revoke: false
        });
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(authorityPk, registry.attestationDigestForBindingOp(op));
        registry.applyBindingOp(op, abi.encodePacked(r, s, v));
    }

    function _launch(LaunchOpts memory o) internal returns (address token, address curve) {
        PonsV2LauncherToken.Socials memory socials = PonsV2LauncherToken.Socials("", "", "", "", "");
        IForgeLaunchAuthorizer.LaunchIntent memory intent = IForgeLaunchAuthorizer.LaunchIntent({
            factory: address(factory),
            creator: creator,
            githubRepoId: REPO_ID,
            launchConfigId: 0,
            pairToken: o.pairToken,
            tokenMetadataHash: keccak256(abi.encode("Rev Token", "REV", "", "", socials)),
            economicsDigest: factory.previewLaunchEconomics(0, o.pairToken),
            salt: o.salt,
            expiresAt: uint64(block.timestamp + 10 minutes),
            nonce: nextNonce,
            creatorTaxBps: o.creatorTaxBps,
            exemptionListHash: keccak256(abi.encode(new address[](0)))
        });
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(creatorPk, authorizer.consentDigest(intent, creator, o.buybackEnabled));
        (uint8 av, bytes32 ar, bytes32 asr) = vm.sign(
            authorityPk,
            authorizer.attestationDigest(
                REPO_ID,
                creator,
                registry.bindingEpoch(REPO_ID),
                uint64(block.timestamp),
                uint64(block.timestamp + 1 days)
            )
        );
        PonsV2LaunchFactory.TokenParams memory p = PonsV2LaunchFactory.TokenParams({
            name: "Rev Token",
            symbol: "REV",
            logo: "",
            description: "",
            socials: socials,
            creatorFeeRecipient: address(0),
            creatorTaxBps: o.creatorTaxBps,
            buybackEnabled: o.buybackEnabled,
            expectedEconomics: intent.economicsDigest,
            salt: o.salt,
            githubRepoId: REPO_ID,
            authorizationExpiresAt: intent.expiresAt,
            authorizationNonce: nextNonce,
            creatorSignature: abi.encodePacked(r, s, v),
            attestationPayload: abi.encodePacked(
                uint64(block.timestamp), uint64(block.timestamp + 1 days), ar, asr, bytes1(av)
            )
        });
        nextNonce++;
        vm.deal(creator, o.value);
        vm.prank(creator);
        (token, curve) = factory.launchToken{value: o.value}(p, 0, o.pairToken);
        PonsV2BondingCurve c = PonsV2BondingCurve(payable(curve));
        bool ok = c.protocolFeeShareBps() == 3_000 && c.protocolFeeRecipient() == address(splitter);
        eligibleCurve[curve] = ok;
        eligibleLaunch[token] = ok;
    }

    /// Test model of the off-chain attestor (see contract notes).
    function _attestEligible() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 credited = keccak256("Credited(address,address,uint256)");
        bytes32 creditedToken = keccak256("CreditedToken(address,address,address,uint256)");
        bytes32 registered = keccak256("PoolRegistered(bytes32,address,address,address)");
        bytes32 swept = keccak256("PoolFeesSwept(bytes32,uint256,uint256,uint256,uint256)");
        bool hookSweepEligible;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter == address(hook) && l.topics[0] == registered) {
                (address memecoin,,) = abi.decode(l.data, (address, address, address));
                poolToken[l.topics[1]] = memecoin;
            } else if (l.emitter == address(hook) && l.topics[0] == swept) {
                hookSweepEligible = eligibleLaunch[poolToken[l.topics[1]]];
            }
        }
        address[2] memory assets = [address(0), address(usdx)];
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != address(escrow)) continue;
            address depositor;
            address asset;
            if (l.topics[0] == credited) {
                depositor = address(uint160(uint256(l.topics[2])));
            } else if (l.topics[0] == creditedToken) {
                asset = address(uint160(uint256(l.topics[2])));
                depositor = address(uint160(uint256(l.topics[3])));
            } else {
                continue;
            }
            if (address(uint160(uint256(l.topics[1]))) != address(splitter)) continue;
            bool eligible =
                eligibleCurve[depositor] || (depositor == address(hook) && hookSweepEligible);
            if (eligible && splitter.approvedAsset(asset)) {
                attested[asset] += abi.decode(l.data, (uint256));
            }
        }
        for (uint256 i; i < assets.length; ++i) {
            address asset = assets[i];
            if (attested[asset] == splitter.ledger(asset).eligibleCeiling) continue;
            ForgeProtocolRevenueSplitter.EligibleRevenue memory a =
                _authFor(splitter, address(factory), asset, attested[asset], ++attestNonce[asset]);
            splitter.authorizeEligibleRevenue(a, _sign(splitter, attestorPk, a));
        }
    }

    function _opts(bytes32 salt) internal pure returns (LaunchOpts memory) {
        return LaunchOpts({
            pairToken: address(0), creatorTaxBps: 0, buybackEnabled: false, salt: salt, value: 0
        });
    }

    function _buyNative(PonsV2BondingCurve c, uint256 amount) internal returns (uint256) {
        vm.deal(buyer, amount);
        vm.prank(buyer);
        return c.buy{value: amount}(amount, 0, buyer);
    }

    // ── 1/2/3/20: curve phase, eligible 70/20/10, creator tax excluded ───

    function test_curve_fees_70_20_10_creator_tax_excluded() public {
        LaunchOpts memory o = _opts("tax");
        o.creatorTaxBps = 200; // 2% creator tax on top of the 1% base fee
        (, address curve) = _launch(o);
        PonsV2BondingCurve c = PonsV2BondingCurve(payable(curve));
        assertEq(c.protocolFeeRecipient(), address(splitter), "snapshot names the splitter");
        assertEq(c.protocolFeeShareBps(), 3_000, "eligible: 30% protocol snapshot");

        _buyNative(c, 10e18);
        uint256 baseFee = c.quoteFeeBalance();
        uint256 tax = c.creatorTaxBalance();
        assertEq(baseFee, 0.1e18);
        assertEq(tax, 0.2e18);

        vm.prank(creator);
        c.sweepFees(0);

        uint256 protocol = (baseFee * 3_000) / 10_000;
        assertEq(escrow.balanceOf(address(splitter)), protocol, "protocol leg = 30% of BASE only");
        assertEq(
            escrow.balanceOf(creator), baseFee - protocol + tax, "creator: 70% base + 100% tax"
        );

        _attestEligible();
        splitter.pullRevenue(address(0), 0);
        // 20 / 10 percentage points of the BASE fee; the tax never entered.
        assertEq(splitter.treasuryLiability(address(0)), (baseFee * 2_000) / 10_000);
        assertEq(splitter.reserveLiability(address(0)), (baseFee * 1_000) / 10_000);

        uint256 before = creator.balance;
        vm.prank(creator);
        escrow.claim();
        assertEq(creator.balance - before, baseFee - protocol + tax, "creator claims own escrow");
    }

    // ── 20: post-graduation hook fees reach the same splitter ───────────

    function test_post_graduation_hook_fees_reach_splitter() public {
        (address token, address curve) = _launch(_opts("grad"));
        PonsV2BondingCurve c = PonsV2BondingCurve(payable(curve));
        uint256 tokens = _buyNative(c, 10e18);
        vm.deal(buyer, 200e18);
        vm.prank(buyer);
        c.buy{value: 100e18}(100e18, 0, buyer); // crosses threshold, auto-sweeps
        factory.createGraduatedPool(token);
        assertEq(uint8(factory.getLaunchedToken(token).phase), uint8(GraduationPhase.PoolCreated));

        uint256 escrowedBefore = escrow.balanceOf(address(splitter));
        assertGt(escrowedBefore, 0, "curve-phase protocol fees credited at graduation sweep");

        // Sell memecoin into the pool: the fee is taken on the ETH (quote) leg.
        swapKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: 0,
            tickSpacing: 10,
            hooks: hook
        });
        swapZeroForOne = false;
        swapAmountIn = tokens / 2;
        swapBeneficiary = buyer;
        vm.prank(buyer);
        IERC20(token).transfer(address(this), tokens / 2);
        // The W02 mini manager books seeded native reserves without holding
        // the ETH (mock limitation); back its own ledger before a native take.
        vm.deal(address(poolManager), poolManager.poolReserve(address(0)));
        poolManager.unlock("");

        PoolId pid = swapKey.toId();
        uint256 hookFee = hook.pendingFees(pid, address(0));
        assertGt(hookFee, 0, "hook fee accrued in the quote asset");
        vm.prank(creator);
        hook.sweepPoolFees(pid, 0, 0);
        uint256 hookProtocol = (hookFee * 3_000) / 10_000;
        assertEq(escrow.balanceOf(address(splitter)) - escrowedBefore, hookProtocol);

        uint256 total = escrow.balanceOf(address(splitter));
        _attestEligible();
        splitter.pullRevenue(address(0), 0);
        assertEq(splitter.reserveLiability(address(0)), total / 3);
        assertEq(splitter.treasuryLiability(address(0)), total - total / 3);
    }

    // ── 18/19: buyback enabled — vest separation; vest releases ineligible

    function test_buyback_vest_is_separate_and_not_revenue() public {
        LaunchOpts memory o = _opts("buyback");
        o.buybackEnabled = true;
        (address token, address curve) = _launch(o);
        PonsV2BondingCurve c = PonsV2BondingCurve(payable(curve));
        _buyNative(c, 5e18);
        uint256 baseFee = c.quoteFeeBalance();
        uint256 protocol = (baseFee * 3_000) / 10_000;

        vm.prank(governance); // buyback execution needs the sweep operator
        c.sweepFees(1);
        assertEq(escrow.balanceOf(address(splitter)), protocol, "protocol leg unchanged by buyback");
        // Creator cash is below 70%: half the creator bucket bought tokens.
        assertLt(escrow.balanceOf(creator), baseFee - protocol, "effective creator cash < 70%");
        uint256 locked = vault.totalLocked(token);
        assertGt(locked, 0, "buyback tokens locked in the 5-year PONS vest");

        // A year later the vest releases 30% of vested tokens to the splitter's
        // escrow key — in the MEMECOIN, which can never be revenue here.
        vm.warp(block.timestamp + 365 days);
        vm.prank(creator);
        vault.release(token);
        uint256 vestToSplitter = escrow.balanceOfToken(address(splitter), token);
        assertGt(vestToSplitter, 0);
        vm.expectRevert(
            abi.encodeWithSelector(ForgeProtocolRevenueSplitter.AssetNotApproved.selector, token)
        );
        splitter.pullRevenue(token, 0);
        vm.prank(governance);
        vm.expectRevert(
            abi.encodeWithSelector(ForgeProtocolRevenueSplitter.AssetIsLaunchToken.selector, token)
        );
        splitter.setAssetApproved(token, true);
    }

    // ── 15/16/17: frozen snapshots; different policies across launches ──

    function test_policy_snapshot_frozen_across_launches() public {
        (, address curve1) = _launch(_opts("p1"));
        vm.prank(governance);
        hook.setProtocolFeeShareBps(2_000);
        (, address curve2) = _launch(_opts("p2"));
        assertEq(
            PonsV2BondingCurve(payable(curve1)).protocolFeeShareBps(), 3_000, "launch 1 frozen"
        );
        assertEq(
            PonsV2BondingCurve(payable(curve2)).protocolFeeShareBps(), 2_000, "launch 2 differs"
        );

        // Launch 2 is NOT 70/20/10 eligible: its protocol leg is 20%.
        PonsV2BondingCurve c2 = PonsV2BondingCurve(payable(curve2));
        _buyNative(c2, 10e18);
        uint256 fee2 = c2.quoteFeeBalance();
        vm.prank(creator);
        c2.sweepFees(0);
        assertEq(escrow.balanceOf(address(splitter)), (fee2 * 2_000) / 10_000);
        assertEq(escrow.balanceOf(creator), fee2 - (fee2 * 2_000) / 10_000, "creator 80%");
        // The ineligible launch's protocol leg is never attested, so it can
        // never enter 70/20/10; it stays in the escrow.
        _attestEligible();
        assertEq(splitter.verifiedHeadroom(address(0)), 0, "ineligible launch never attested");
        vm.expectRevert(ForgeProtocolRevenueSplitter.NothingReceived.selector);
        splitter.pullRevenue(address(0), 0);
    }

    // ── Correction A: provenance through the real stack ─────────────────

    function test_third_party_credit_amid_real_fees_is_not_allocated() public {
        (, address curve) = _launch(_opts("prov"));
        PonsV2BondingCurve c = PonsV2BondingCurve(payable(curve));
        _buyNative(c, 10e18);
        uint256 baseFee = c.quoteFeeBalance();
        // A third party credits the splitter's escrow key before and after
        // the real sweep (same block span the attestor scans).
        address donor = makeAddr("donor");
        vm.deal(donor, 3 ether);
        vm.prank(donor);
        escrow.credit{value: 1 ether}(address(splitter));
        vm.prank(creator);
        c.sweepFees(0);
        vm.prank(donor);
        escrow.credit{value: 2 ether}(address(splitter));
        _attestEligible();

        uint256 protocol = (baseFee * 3_000) / 10_000;
        assertEq(splitter.verifiedHeadroom(address(0)), protocol, "only the curve's protocol leg");
        assertEq(splitter.pullRevenue(address(0), 0), protocol);
        assertEq(splitter.treasuryLiability(address(0)), (baseFee * 2_000) / 10_000);
        assertEq(splitter.reserveLiability(address(0)), (baseFee * 1_000) / 10_000);
        assertEq(escrow.balanceOf(address(splitter)), 3 ether, "third-party credit stays");
        assertEq(escrow.balanceOf(creator), baseFee - protocol, "creator 70% untouched");
        vm.expectRevert(ForgeProtocolRevenueSplitter.NothingReceived.selector);
        splitter.pullRevenue(address(0), 0);
    }

    // ── 14: creator fee recipient rotation never touches the splitter ───

    function test_creator_recipient_rotation() public {
        (address token, address curve) = _launch(_opts("rot"));
        address newRecipient = makeAddr("newRecipient");
        vm.prank(creator);
        factory.transferCreatorFeeRecipient(token, newRecipient);
        PonsV2BondingCurve c = PonsV2BondingCurve(payable(curve));
        _buyNative(c, 10e18);
        uint256 fee = c.quoteFeeBalance();
        vm.prank(governance);
        c.sweepFees(0);
        assertEq(escrow.balanceOf(newRecipient), fee - (fee * 3_000) / 10_000);
        assertEq(escrow.balanceOf(creator), 0);
        assertEq(escrow.balanceOf(address(splitter)), (fee * 3_000) / 10_000);
        // The owner override is timelocked (F-03) and visible as a pending change.
        vm.prank(governance);
        factory.setCreatorFeeRecipient(token, governance);
        vm.expectRevert();
        factory.executeCreatorFeeRecipientChange(token);
    }

    // ── 4: ERC-20 quote launch through the real stack ───────────────────

    function test_erc20_quote_launch_70_20_10() public {
        LaunchOpts memory o = _opts("usdx");
        o.pairToken = address(usdx);
        (, address curve) = _launch(o);
        PonsV2BondingCurve c = PonsV2BondingCurve(payable(curve));
        usdx.mint(buyer, 10e18);
        vm.startPrank(buyer);
        usdx.approve(curve, 10e18);
        c.buy(10e18, 0, buyer);
        vm.stopPrank();
        uint256 fee = c.quoteFeeBalance();
        vm.prank(creator);
        c.sweepFees(0);
        _attestEligible();
        splitter.pullRevenue(address(usdx), 0);
        uint256 protocol = (fee * 3_000) / 10_000;
        assertEq(splitter.reserveLiability(address(usdx)), protocol / 3);
        assertEq(splitter.treasuryLiability(address(usdx)), protocol - protocol / 3);
        assertEq(escrow.balanceOfToken(creator, address(usdx)), fee - protocol);
        vm.prank(treasury);
        splitter.claimTreasury(address(usdx), 0);
        assertEq(usdx.balanceOf(treasury), protocol - protocol / 3);
    }

    // ── launch fee + rescue transfers are non-revenue ───────────────────

    function test_launch_fee_and_rescue_are_non_revenue() public {
        vm.prank(governance);
        factory.setLaunchFee(0.05 ether);
        LaunchOpts memory o = _opts("fee");
        o.value = 0.05 ether;
        (address token, address curve) = _launch(o);
        assertEq(splitter.nonRevenueHeld(address(0)), 0.05 ether, "launch fee held as non-revenue");
        assertEq(splitter.ledger(address(0)).revenueReceived, 0);

        _buyNative(PonsV2BondingCurve(payable(curve)), 10e18);
        uint256 fee = PonsV2BondingCurve(payable(curve)).quoteFeeBalance();
        vm.prank(governance);
        factory.rescueCurveFees(token); // bypasses the escrow (F-04)
        assertEq(
            splitter.nonRevenueHeld(address(0)),
            0.05 ether + (fee * 3_000) / 10_000,
            "rescued protocol leg is unattributed, never auto-allocated"
        );
        assertEq(splitter.ledger(address(0)).revenueReceived, 0);
        (,, uint256 surplus, uint256 deficit) = splitter.reconcile(address(0));
        assertEq(surplus, 0);
        assertEq(deficit, 0);
    }

    // ── mini-manager swap driver ─────────────────────────────────────────

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(poolManager), "only manager");
        SwapParams memory p = SwapParams({
            zeroForOne: swapZeroForOne, amountSpecified: -int256(swapAmountIn), sqrtPriceLimitX96: 0
        });
        BalanceDelta delta = poolManager.swap(swapKey, p, "");
        int128 a0 = delta.amount0();
        int128 a1 = delta.amount1();
        if (a0 < 0) {
            poolManager.sync(Currency.wrap(address(0)));
            poolManager.settle{value: uint256(uint128(-a0))}();
        } else if (a0 > 0) {
            poolManager.take(swapKey.currency0, swapBeneficiary, uint256(uint128(a0)));
        }
        if (a1 < 0) {
            address c1 = Currency.unwrap(swapKey.currency1);
            poolManager.sync(swapKey.currency1);
            IERC20(c1).transfer(address(poolManager), uint256(uint128(-a1)));
            poolManager.settle();
        } else if (a1 > 0) {
            poolManager.take(swapKey.currency1, swapBeneficiary, uint256(uint128(a1)));
        }
        return "";
    }

    receive() external payable {}
}
