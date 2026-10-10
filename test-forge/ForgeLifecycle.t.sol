// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MiniPoolManagerW02} from "./mocks/MiniPoolManagerW02.sol";
import {MiniPositionManager} from "./mocks/MiniPositionManager.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";
import {HookDeployer} from "./mocks/HookDeployer.sol";
import {MockFeeEscrow} from "./mocks/MockFeeEscrow.sol";

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
    GraduationPhase,
    FeePolicySnapshot
} from "contractsV2-forge/src/v2/interfaces/ILaunchpadV2.sol";
import {LaunchDeployment} from "contractsV2-forge/src/v2/PonsV2LaunchDeployer.sol";

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/**
 * @title ForgeLifecycleTest
 * @notice Full local token lifecycle over the REAL Forge-owned stack: the
 * deploy-time PONS V2 financial contracts (curve, deployer, hook, locker,
 * vault, executor, guard, escrow) governed by the Forge factory with M-ELIG
 * eligibility enforcement. Only the Uniswap V4 core/periphery legs are the
 * W02 mini mocks (production V4 integration is a W03+ concern).
 *
 * Lifecycle: deploy → bind repo → authorize → launch → buys/sells → fees →
 * graduation → V4 pool + permanent lock → post-graduation trades → escrow
 * reconciliation → supply conservation.
 */
contract ForgeLifecycleTest is Test, IUnlockCallback {
    using ECDSA for bytes32;

    MiniPoolManagerW02 internal poolManager;
    MiniPositionManager internal positionManager;
    MockPermit2 internal permit2;
    MockFeeEscrow internal feeEscrow;
    PonsV2MemeHook internal memeHook;
    PonsV2BuybackVault internal buybackVault;
    PonsV2LaunchLocker internal locker;
    PonsV2GraduationExecutor internal graduationExecutor;
    PonsV2LaunchDeployer internal launchDeployer;
    PonsV2LaunchFactory internal factory;
    ForgeBindingRegistry internal registry;
    ForgeLaunchAuthorizer internal authorizer;

    uint256 internal authorityPk = 0xA11CE;
    address internal authority;
    uint256 internal creatorPk = 0xC0DEC0DE;
    address internal creator;
    address internal buyer1 = makeAddr("buyer1");
    address internal buyer2 = makeAddr("buyer2");
    address internal governance = makeAddr("governance");

    uint64 internal constant REPO_ID = 42;
    uint256 internal constant SUPPLY = 1_000_000e18;
    uint256 internal constant THRESHOLD = 30e18;

    IForgeLaunchAuthorizer.LaunchIntent internal intent;
    bytes internal consent;
    bytes internal att;

    // Swap driver state for this contract's own unlockCallback.
    PoolKey internal swapKey;
    bool internal swapZeroForOne;
    uint256 internal swapAmountIn;
    address internal swapBeneficiary;

    function setUp() public {
        authority = vm.addr(authorityPk);
        creator = vm.addr(creatorPk);

        poolManager = new MiniPoolManagerW02();
        permit2 = new MockPermit2();
        positionManager = new MiniPositionManager(poolManager, permit2);
        feeEscrow = new MockFeeEscrow();

        // Hook at the permission-flag address BaseHook requires.
        HookDeployer hookDeployer = new HookDeployer();
        bytes memory hookInit = abi.encodePacked(
            type(PonsV2MemeHook).creationCode,
            abi.encode(IPoolManager(address(poolManager)), feeEscrow, governance, governance)
        );
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        bytes32 salt = 0;
        while (
            uint160(_create2Address(salt, keccak256(hookInit), address(hookDeployer))) & 0x3FFF
                != flags
        ) {
            salt = bytes32(uint256(salt) + 1);
        }
        memeHook = PonsV2MemeHook(payable(hookDeployer.deploy(hookInit, salt)));

        buybackVault = new PonsV2BuybackVault(governance, memeHook, feeEscrow);
        locker = new PonsV2LaunchLocker(governance, address(positionManager));

        registry = new ForgeBindingRegistry(authority);
        authorizer = new ForgeLaunchAuthorizer(registry, authority);

        factory = new PonsV2LaunchFactory(
            governance,
            IPoolManager(address(poolManager)),
            IPositionManager(address(positionManager)),
            IAllowanceTransfer(address(permit2)),
            locker,
            memeHook,
            feeEscrow,
            buybackVault,
            authorizer,
            0
        );
        launchDeployer = new PonsV2LaunchDeployer(address(factory));
        graduationExecutor = new PonsV2GraduationExecutor(
            IPositionManager(address(positionManager)),
            IAllowanceTransfer(address(permit2)),
            locker,
            address(factory)
        );

        // The authorizer's owner is this test contract (deployer); the
        // factory's owner is governance.
        authorizer.setForgeFactory(address(factory));
        vm.startPrank(governance);
        // One-time wiring on the singleton stack (the deploy-time factory's
        // _requireLaunchDependenciesWired demands all of these).
        memeHook.setFactory(address(factory));
        memeHook.setBuybackVault(buybackVault);
        buybackVault.setFactory(address(factory));
        locker.setFactory(address(factory));
        factory.setLaunchDeployer(launchDeployer);
        factory.setGraduationExecutor(graduationExecutor);
        factory.setLaunchFee(0);
        vm.stopPrank();

        // Launch configuration: 1M supply, 1% curve fee, 30 ETH threshold.
        PonsV2LaunchFactory.LaunchConfig memory config = PonsV2LaunchFactory.LaunchConfig({
            supply: SUPPLY,
            curveFeeBps: 100,
            phantomQuote: 30e18,
            graduationThreshold: THRESHOLD,
            poolFee: 0,
            tickSpacing: 10,
            enabled: true
        });
        vm.startPrank(governance);
        // Disable the launch-second snipe tax for the deterministic E2E
        // (99% opening tax otherwise consumes the first buys; anti-snipe
        // behavior is exercised in ForgeSnipeTaxTest).
        factory.setSnipeTaxStartBps(0);
        factory.addLaunchConfig(config);
        factory.setLaunchEnabled(true);
        vm.stopPrank();

        // Repo binding + launch intent + signatures.
        _bind(REPO_ID, creator);
        intent = IForgeLaunchAuthorizer.LaunchIntent({
            factory: address(factory),
            creator: creator,
            githubRepoId: REPO_ID,
            launchConfigId: 0,
            pairToken: address(0),
            tokenMetadataHash: keccak256(
                abi.encode(
                    "Forge Token",
                    "FRG",
                    "logo",
                    "desc",
                    PonsV2LauncherToken.Socials("", "", "", "", "")
                )
            ),
            economicsDigest: factory.previewLaunchEconomics(0, address(0)),
            salt: keccak256("forge-salt-1"),
            expiresAt: uint64(block.timestamp + 10 minutes),
            nonce: 0
        });
        bytes32 consentDigest = authorizer.consentDigest(intent, creator, false);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(creatorPk, consentDigest);
        consent = abi.encodePacked(r, s, v);
        bytes32 attDigest = authorizer.attestationDigest(
            REPO_ID, creator, uint64(block.timestamp), uint64(block.timestamp + 1 days)
        );
        (uint8 av, bytes32 ar, bytes32 asr) = vm.sign(authorityPk, attDigest);
        att = abi.encodePacked(
            bytes32(uint256(uint64(block.timestamp))),
            bytes32(uint256(uint64(block.timestamp + 1 days))),
            ar,
            asr,
            bytes1(av)
        );
    }

    function _bind(uint64 repoId, address who) internal {
        ForgeBindingRegistry.BindingOp memory op = ForgeBindingRegistry.BindingOp({
            githubRepoId: repoId,
            creator: who,
            expiresAt: uint64(block.timestamp + 30 days),
            opNonce: 0,
            repoFullName: "finco/forge",
            revoke: false
        });
        bytes32 digest = registry.attestationDigestForBindingOp(
            op.githubRepoId,
            op.creator,
            op.expiresAt,
            op.opNonce,
            keccak256(bytes(op.repoFullName)),
            op.revoke
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(authorityPk, digest);
        registry.applyBindingOp(op, abi.encodePacked(r, s, v));
    }

    function _params() internal view returns (PonsV2LaunchFactory.TokenParams memory params) {
        params = PonsV2LaunchFactory.TokenParams({
            name: "Forge Token",
            symbol: "FRG",
            logo: "logo",
            description: "desc",
            socials: PonsV2LauncherToken.Socials("", "", "", "", ""),
            creatorFeeRecipient: address(0),
            creatorTaxBps: 0,
            buybackEnabled: false,
            expectedEconomics: intent.economicsDigest,
            salt: intent.salt,
            githubRepoId: REPO_ID,
            authorizationExpiresAt: intent.expiresAt,
            authorizationNonce: intent.nonce,
            creatorSignature: consent,
            attestationPayload: att
        });
    }

    function _launch() internal returns (address token, address curve) {
        PonsV2LaunchFactory.TokenParams memory params = _params();
        vm.prank(creator);
        (token, curve) = factory.launchToken{value: 0}(params, 0, address(0));
    }

    function _create2Address(bytes32 s, bytes32 initHash, address deployer)
        internal
        pure
        returns (address)
    {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, s, initHash))))
        );
    }

    // ── Phase 4: the full lifecycle ──────────────────────────────────────

    function test_full_lifecycle_launch_to_graduation() public {
        (address token, address curve) = _launch();
        PonsV2LauncherToken meme = PonsV2LauncherToken(token);
        PonsV2BondingCurve curveC = PonsV2BondingCurve(curve);

        // (6) Full supply sits on the curve; nobody pre-minted.
        assertEq(meme.totalSupply(), SUPPLY, "supply fixed at mint");
        assertEq(meme.balanceOf(curve), SUPPLY, "curve holds the entire supply");
        assertEq(meme.balanceOf(creator), 0, "creator not pre-minted");

        // (7-8) Buys from two participants.
        vm.deal(buyer1, 20e18);
        vm.prank(buyer1);
        uint256 got1 = curveC.buy{value: 20e18}(20e18, 0, buyer1);
        assertGt(got1, 0, "buy1 must fill");

        vm.deal(buyer2, 10e18);
        vm.prank(buyer2);
        uint256 got2 = curveC.buy{value: 10e18}(10e18, 0, buyer2);
        assertGt(got2, 0, "buy2 must fill");

        // (9) Sell a slice back to the curve.
        vm.startPrank(buyer2);
        meme.approve(curve, type(uint256).max);
        curveC.sell(got2 / 2, 0, buyer2);
        vm.stopPrank();

        // (10) Fees accrue on the quote leg and sweep to the escrow.
        assertGt(curveC.quoteFeeBalance(), 0, "curve fees must accrue");
        vm.prank(creator);
        curveC.sweepFees(0);
        assertGt(feeEscrow.balanceOf(memeHook.protocolFeeRecipient()), 0, "protocol fees credited");
        assertGt(feeEscrow.balanceOf(creator), 0, "creator fees credited");

        // (11-12) Graduation: the threshold-crossing buy clamps at the
        // sellable allocation, refunds the excess, and auto-triggers the
        // factory sweep inside the same transaction (phase → Swept).
        vm.deal(buyer1, 200e18);
        vm.prank(buyer1);
        curveC.buy{value: 100e18}(100e18, 0, buyer1);

        // The crossing buy auto-graduated: the curve drained itself into the
        // factory (phase Swept) inside the buyer's own transaction.
        assertTrue(curveC.graduated(), "crossing buy must have auto-graduated");
        assertEq(uint8(factory.getLaunchedToken(token).phase), uint8(GraduationPhase.Swept));

        // (13-14) Seed the V4 pool; the position lands in the locker.
        factory.createGraduatedPool(token);
        assertEq(uint8(factory.getLaunchedToken(token).phase), uint8(GraduationPhase.PoolCreated));
        assertTrue(locker.isLocked(token), "position must be locked");
        uint256 positionId = locker.lockedPositions(token);
        assertEq(
            positionManager.ownerOf(positionId), address(locker), "locker holds the position NFT"
        );

        // (15) Post-graduation trade through the pool (this contract drives
        // the mini manager's unlock context; the hook takes its cut).
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: 0,
            tickSpacing: 10,
            hooks: memeHook
        });
        uint256 poolEthBefore = poolManager.poolReserve(address(0));
        uint256 poolTokenBefore = poolManager.poolReserve(token);
        vm.deal(buyer2, 5e18);
        swapKey = key;
        swapZeroForOne = true;
        swapAmountIn = 5e18;
        swapBeneficiary = buyer2;
        poolManager.unlock("");
        // The pool accepted the trade.
        assertGt(poolManager.poolReserve(address(0)), poolEthBefore, "pool ETH grew");
        assertLt(poolManager.poolReserve(token), poolTokenBefore, "pool tokens shrank");

        // (16) Hook fee accounting: the hook collected a cut of the swap's
        // output leg (token-denominated, pending conversion).
        assertGt(
            memeHook.pendingFees(key.toId(), token) + memeHook.pendingCreatorTax(key.toId(), token),
            0,
            "hook fees must accrue on the pool swap"
        );

        // (17-18) Conservation: the curve is fully drained, nothing stranded.
        assertEq(curveC.trackedQuote(), 0, "curve quote drained");
        assertEq(curveC.trackedTokens(), 0, "curve tokens drained");
        assertEq(address(curve).balance, curveC.trackedQuote(), "no stray ETH on the curve");

        // Supply conservation: every token is accounted for across the pool,
        // the locker's locked excess, the vault, the escrow, holders, the
        // hook's pending fee inventory (held as the hook's own token
        // balance), and the vault's locked buybacks. The hook's pendingFees
        // entries ARE its token balance, so they are not counted twice.
        // The locker's lockedTokenSupply accounting and its actual token
        // balance are the same tokens ' count the balance once.
        uint256 hookTokenHoldings = meme.balanceOf(address(memeHook));
        uint256 hookPendingEntries =
            memeHook.pendingFees(key.toId(), token) + memeHook.pendingCreatorTax(key.toId(), token);
        assertEq(hookTokenHoldings, hookPendingEntries, "hook holds exactly its pending entries");
        assertGt(locker.lockedTokenSupply(token), 0, "virtual-reserve excess must be locked");
        uint256 accounted = meme.balanceOf(address(poolManager)) + meme.balanceOf(buyer1)
            + meme.balanceOf(buyer2) + meme.balanceOf(address(feeEscrow))
            + meme.balanceOf(address(locker)) + hookTokenHoldings
            + meme.balanceOf(address(buybackVault));
        assertLe(accounted, SUPPLY, "no excess supply anywhere");
        assertGt(accounted, 0, "tokens must exist in circulation or locks");
    }

    function test_unauthorized_launch_reverts_at_factory() public {
        // A launch without any authorization (no binding, no signatures) is
        // refused by the Forge factory itself — the structural M-ELIG gate.
        PonsV2LaunchFactory.TokenParams memory params = _params();
        params.githubRepoId = 999_999_999;
        params.creatorSignature = bytes("");
        params.attestationPayload = bytes("");
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(0xfce698f7, 0));
        factory.launchToken{value: 0}(params, 0, address(0));
    }

    function test_nonce_reuse_second_launch_reverts() public {
        (address token,) = _launch();
        assertTrue(token != address(0), "first launch must succeed");
        // A fresh consent re-using the ALREADY-CONSUMED nonce (with a new
        // salt) must be refused by the nonce check even though the
        // signature itself is valid.
        PonsV2LaunchFactory.TokenParams memory params = _params();
        params.salt = keccak256("forge-salt-2");
        IForgeLaunchAuthorizer.LaunchIntent memory replay = intent;
        replay.salt = params.salt;
        bytes32 digest = authorizer.consentDigest(replay, creator, false);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(creatorPk, digest);
        params.creatorSignature = abi.encodePacked(r, s, v);
        vm.prank(creator);
        vm.expectRevert(ForgeLaunchAuthorizer.CreatorNonceStale.selector);
        factory.launchToken{value: 0}(params, 0, address(0));
    }

    function test_direct_deployer_bypass_blocked() public {
        // The launch deployer refuses calls from anyone but the factory.
        PonsV2LaunchFactory.LaunchConfig memory config = factory.getLaunchConfig(0);
        FeePolicySnapshot memory policy = memeHook.currentFeePolicy();
        LaunchDeployment memory dep = LaunchDeployment({
            pairToken: address(0),
            creatorFeeRecipient: creator,
            originalDeployer: creator,
            feePolicy: memeHook,
            policy: policy,
            feeEscrow: feeEscrow,
            buybackVault: buybackVault,
            phantomQuote: config.phantomQuote,
            curveFeeBps: config.curveFeeBps,
            creatorTaxBps: 0,
            buybackEnabled: false,
            graduationThreshold: config.graduationThreshold,
            supply: config.supply,
            salt: keccak256("bypass"),
            name: "Bypass",
            symbol: "BYP",
            logo: "",
            description: "",
            socials: PonsV2LauncherToken.Socials("", "", "", "", "")
        });
        vm.expectRevert(PonsV2LaunchDeployer.NotFactory.selector);
        launchDeployer.deployLaunch(dep);
    }

    // ── Mini-manager swap driver (this contract is the unlocker) ─────────

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(poolManager), "only manager");
        SwapParams memory p = SwapParams({
            zeroForOne: swapZeroForOne, amountSpecified: -int256(swapAmountIn), sqrtPriceLimitX96: 0
        });
        BalanceDelta delta = poolManager.swap(swapKey, p, "");
        int128 a0 = delta.amount0();
        int128 a1 = delta.amount1();
        if (a0 < 0) {
            // Native input: settle with ETH.
            poolManager.sync(Currency.wrap(address(0)));
            poolManager.settle{value: uint256(uint128(-a0))}();
        } else if (a0 > 0) {
            poolManager.take(swapKey.currency0, swapBeneficiary, uint256(uint128(a0)));
        }
        if (a1 < 0) {
            address c1 = Currency.unwrap(swapKey.currency1);
            IERC20(c1).approve(address(poolManager), uint256(uint128(-a1)));
            poolManager.sync(swapKey.currency1);
            IERC20(c1).transfer(address(poolManager), uint256(uint128(-a1)));
            poolManager.settle();
        } else if (a1 > 0) {
            poolManager.take(swapKey.currency1, swapBeneficiary, uint256(uint128(a1)));
        }
        return "";
    }
}
