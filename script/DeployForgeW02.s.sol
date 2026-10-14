// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {MiniPoolManagerW02} from "test-forge/mocks/MiniPoolManagerW02.sol";
import {MiniPositionManager} from "test-forge/mocks/MiniPositionManager.sol";
import {MockPermit2} from "test-forge/mocks/MockPermit2.sol";
import {HookDeployer} from "test-forge/mocks/HookDeployer.sol";
import {MockFeeEscrow} from "test-forge/mocks/MockFeeEscrow.sol";

import {PonsV2MemeHook} from "contractsV2-forge/src/v2/hooks/PonsV2MemeHook.sol";
import {PonsV2BuybackVault} from "contractsV2-forge/src/v2/PonsV2BuybackVault.sol";
import {PonsV2LaunchLocker} from "contractsV2-forge/src/v2/PonsV2LaunchLocker.sol";
import {PonsV2LaunchFactory} from "contractsV2-forge/src/v2/PonsV2LaunchFactory.sol";
import {PonsV2LaunchDeployer} from "contractsV2-forge/src/v2/PonsV2LaunchDeployer.sol";
import {PonsV2GraduationExecutor} from "contractsV2-forge/src/v2/PonsV2GraduationExecutor.sol";
import {ForgeBindingRegistry} from "contractsV2-forge/src/v2/forge/ForgeBindingRegistry.sol";
import {ForgeLaunchAuthorizer} from "contractsV2-forge/src/v2/forge/ForgeLaunchAuthorizer.sol";

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

/**
 * @title DeployForgeW02
 * @notice Local/test-environment deployment of the full Forge-owned W02
 * stack. NEVER pointed at Robinhood mainnet: the Uniswap V4 core-periphery
 * legs are the W02 mini mocks (local lifecycles only). Production
 * deployments are out of scope until W03+ with independent review.
 *
 * Run: forge script script/DeployForgeW02.s.sol --rpc-url <local-anvil>
 */
contract DeployForgeW02 is Script {
    struct W02Deployment {
        MiniPoolManagerW02 poolManager;
        MiniPositionManager positionManager;
        MockPermit2 permit2;
        PonsV2MemeHook memeHook;
        MockFeeEscrow feeEscrow;
        PonsV2BuybackVault buybackVault;
        PonsV2LaunchLocker locker;
        PonsV2GraduationExecutor graduationExecutor;
        PonsV2LaunchDeployer launchDeployer;
        PonsV2LaunchFactory factory;
        ForgeBindingRegistry registry;
        ForgeLaunchAuthorizer authorizer;
        address authorityKey; // eligibility authority signer (test key)
        address governance; // Forge governance / factory owner
    }

    function run() external returns (W02Deployment memory d) {
        d.governance = msg.sender;
        d.authorityKey = vm.rememberKey(vm.envUint("FORGE_AUTHORITY_KEY"));

        vm.startBroadcast();

        // Core legs (mocks for local lifecycles; production addresses are a
        // W03+ concern after independent review).
        d.poolManager = new MiniPoolManagerW02();
        d.permit2 = new MockPermit2();
        d.positionManager = new MiniPositionManager(d.poolManager, d.permit2);

        // Fee escrow + hook (CREATE2 at the flag address BaseHook demands:
        // beforeInitialize | afterSwap | afterSwapReturnDelta = 0x2044).
        d.feeEscrow = new MockFeeEscrow();
        HookDeployer hookDeployer = new HookDeployer();
        bytes memory hookInit = abi.encodePacked(
            type(PonsV2MemeHook).creationCode,
            abi.encode(d.poolManager, d.feeEscrow, d.governance, d.governance)
        );
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        bytes32 salt = _mineHookSalt(address(hookDeployer), keccak256(hookInit), flags);
        d.memeHook = PonsV2MemeHook(payable(hookDeployer.deploy(hookInit, salt)));

        d.buybackVault = new PonsV2BuybackVault(d.governance, d.memeHook, d.feeEscrow);
        d.locker = new PonsV2LaunchLocker(d.governance, address(d.positionManager));

        // Eligibility stack first (the authorizer no longer needs the
        // factory at construction; it is wired to it one-time below).
        d.registry = new ForgeBindingRegistry(d.authorityKey);
        d.authorizer = new ForgeLaunchAuthorizer(d.registry, d.authorityKey);

        // Forge factory: the deploy-time stack with M-ELIG enforcement.
        // Duck-typed mocks: explicit two-step casts (W02 lifecycle mocks do
        // not inherit the full Uniswap interfaces).
        d.factory = new PonsV2LaunchFactory(
            d.governance,
            IPoolManager(address(d.poolManager)),
            IPositionManager(address(d.positionManager)),
            IAllowanceTransfer(address(d.permit2)),
            d.locker,
            d.memeHook,
            d.feeEscrow,
            d.buybackVault,
            d.authorizer,
            0
        );

        // One-time wiring, in the dependency order the factory's
        // _requireLaunchDependenciesWired check demands.
        d.launchDeployer = new PonsV2LaunchDeployer(address(d.factory));
        d.graduationExecutor = new PonsV2GraduationExecutor(
            IPositionManager(address(d.positionManager)),
            IAllowanceTransfer(address(d.permit2)),
            d.locker,
            address(d.factory)
        );
        vm.prank(d.factory.owner());
        d.factory.setLaunchDeployer(d.launchDeployer);
        vm.prank(d.factory.owner());
        d.factory.setGraduationExecutor(d.graduationExecutor);
        vm.prank(d.factory.owner());
        d.factory.setLaunchFee(0);
        vm.prank(d.factory.owner());
        d.authorizer.setForgeFactory(address(d.factory));

        vm.stopBroadcast();
    }

    function _mineHookSalt(address deployer, bytes32 initHash, uint160 flags)
        internal
        pure
        returns (bytes32 salt)
    {
        while (uint160(_create2Address(salt, initHash, deployer)) & 0x3FFF != flags) {
            salt = bytes32(uint256(salt) + 1);
        }
    }

    function _create2Address(bytes32 salt, bytes32 initHash, address deployer)
        internal
        pure
        returns (address)
    {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initHash))))
        );
    }
}
