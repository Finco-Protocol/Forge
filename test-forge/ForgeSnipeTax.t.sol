// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

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

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

/**
 * @title ForgeSnipeTaxTest
 * @notice MEV/anti-snipe behavior over the recovered deploy-time curve:
 * the launch-second tax (99% → 0 exponential decay), creator exemption,
 * and post-window untaxed trading.
 */
contract ForgeSnipeTaxTest is Test {
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
    uint256 internal creatorPk = 0xC0DEC0DE;
    address internal authority;
    address internal creator;
    address internal sniper = makeAddr("sniper");
    address internal governance = makeAddr("governance");

    function setUp() public {
        authority = vm.addr(authorityPk);
        creator = vm.addr(creatorPk);

        poolManager = new MiniPoolManagerW02();
        permit2 = new MockPermit2();
        positionManager = new MiniPositionManager(poolManager, permit2);
        feeEscrow = new MockFeeEscrow();

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
            uint160(
                        address(
                            uint160(
                                uint256(
                                    keccak256(
                                        abi.encodePacked(
                                            bytes1(0xff),
                                            address(hookDeployer),
                                            salt,
                                            keccak256(hookInit)
                                        )
                                    )
                                )
                            )
                        )
                    ) & 0x3FFF != flags
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

        authorizer.setForgeFactory(address(factory));
        vm.startPrank(governance);
        memeHook.setFactory(address(factory));
        memeHook.setBuybackVault(buybackVault);
        buybackVault.setFactory(address(factory));
        locker.setFactory(address(factory));
        factory.setLaunchDeployer(launchDeployer);
        factory.setGraduationExecutor(graduationExecutor);
        factory.setLaunchFee(0);
        // Keep the default 99% launch-second snipe tax.
        PonsV2LaunchFactory.LaunchConfig memory config = PonsV2LaunchFactory.LaunchConfig({
            supply: 1_000_000e18,
            curveFeeBps: 100,
            phantomQuote: 30e18,
            graduationThreshold: 30e18,
            poolFee: 0,
            tickSpacing: 10,
            enabled: true
        });
        factory.addLaunchConfig(config);
        factory.setLaunchEnabled(true);
        vm.stopPrank();

        ForgeBindingRegistry.BindingOp memory op = ForgeBindingRegistry.BindingOp({
            githubRepoId: 42,
            creator: creator,
            bindingExpiresAt: uint64(block.timestamp + 30 days),
            opDeadline: uint64(block.timestamp + 5 minutes),
            opNonce: registry.operationSequence(42) + 1,
            parentOpDigest: registry.headOpDigest(42),
            repoFullName: "finco/forge",
            revoke: false
        });
        bytes32 digest = registry.attestationDigestForBindingOp(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(authorityPk, digest);
        registry.applyBindingOp(op, abi.encodePacked(r, s, v));
    }

    function _launch() internal returns (PonsV2LauncherToken meme, PonsV2BondingCurve curve) {
        IForgeLaunchAuthorizer.LaunchIntent memory intent = IForgeLaunchAuthorizer.LaunchIntent({
            factory: address(factory),
            creator: creator,
            githubRepoId: 42,
            launchConfigId: 0,
            pairToken: address(0),
            tokenMetadataHash: keccak256(
                abi.encode(
                    "Snipe Token", "SNP", "", "", PonsV2LauncherToken.Socials("", "", "", "", "")
                )
            ),
            economicsDigest: factory.previewLaunchEconomics(0, address(0)),
            salt: keccak256("snipe-salt"),
            expiresAt: uint64(block.timestamp + 10 minutes),
            nonce: 0,
            creatorTaxBps: 0,
            exemptionListHash: keccak256(abi.encode(new address[](0)))
        });
        bytes32 consentDigest = authorizer.consentDigest(intent, creator, false);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(creatorPk, consentDigest);
        bytes32 attDigest = authorizer.attestationDigest(
            42,
            creator,
            registry.bindingEpoch(42),
            uint64(block.timestamp),
            uint64(block.timestamp + 1 days)
        );
        (uint8 av, bytes32 ar, bytes32 asr) = vm.sign(authorityPk, attDigest);

        PonsV2LaunchFactory.TokenParams memory params = PonsV2LaunchFactory.TokenParams({
            name: "Snipe Token",
            symbol: "SNP",
            logo: "",
            description: "",
            socials: PonsV2LauncherToken.Socials("", "", "", "", ""),
            creatorFeeRecipient: address(0),
            creatorTaxBps: 0,
            buybackEnabled: false,
            expectedEconomics: intent.economicsDigest,
            salt: intent.salt,
            githubRepoId: 42,
            authorizationExpiresAt: intent.expiresAt,
            authorizationNonce: 0,
            creatorSignature: abi.encodePacked(r, s, v),
            attestationPayload: abi.encodePacked(
                uint64(uint64(block.timestamp)),
                uint64(uint64(block.timestamp + 1 days)),
                ar,
                asr,
                bytes1(av)
            )
        });
        vm.prank(creator);
        (address token, address curveAddr) = factory.launchToken{value: 0}(params, 0, address(0));
        meme = PonsV2LauncherToken(token);
        curve = PonsV2BondingCurve(curveAddr);
    }

    function test_snipe_tax_decays_and_creator_is_exempt() public {
        (PonsV2LauncherToken meme, PonsV2BondingCurve curve) = _launch();

        // Creator is exempt: the same-size buy nets the untaxed price.
        vm.deal(creator, 1e18);
        vm.prank(creator);
        uint256 creatorOut = curve.buy{value: 1e18}(1e18, 0, creator);

        // Sniper in the same second pays the 99% launch tax.
        vm.deal(sniper, 1e18);
        vm.prank(sniper);
        uint256 sniperOutLaunch = curve.buy{value: 1e18}(1e18, 0, sniper);
        assertLt(sniperOutLaunch * 20, creatorOut, "launch-second sniper must be heavily taxed");

        // After the decay window the same-size buy is untaxed.
        vm.warp(vm.getBlockTimestamp() + 2 days);
        vm.deal(sniper, 1e18);
        vm.prank(sniper);
        uint256 sniperOutLate = curve.buy{value: 1e18}(1e18, 0, sniper);
        assertApproxEqRel(sniperOutLate, creatorOut, 1e17, "post-window buys must be untaxed");
    }
}
