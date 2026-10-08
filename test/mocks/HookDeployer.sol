// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice CREATE2 deployer used to mine a PonsV2MemeHook address whose low
/// 14 bits match the hook permission flags BaseHook validates in its
/// constructor (beforeInitialize | afterSwap | afterSwapReturnDelta = 1<<13 |
/// 1<<6 | 1<<2 = 0x2044).
contract HookDeployer {
    error DeployFailed();

    function deploy(bytes memory initCode, bytes32 salt) external returns (address deployed) {
        assembly {
            deployed := create2(0, add(initCode, 0x20), mload(initCode), salt)
        }
        if (deployed == address(0)) revert DeployFailed();
    }
}
