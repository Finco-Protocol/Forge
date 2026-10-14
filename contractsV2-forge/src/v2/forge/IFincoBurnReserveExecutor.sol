// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/**
 * @title IFincoBurnReserveExecutor
 * @notice ARCHITECTURAL INTERFACE ONLY (W04). Nothing in the Forge stack
 * implements, deploys or calls this interface, and ForgeProtocolRevenueSplitter
 * exposes no path to its FINCO reserve: `FINCO_BURN_ENABLED` is a
 * compile-time `false` there.
 *
 * It records the shape a future, separately reviewed governance contract
 * would need before any reserve could ever be converted and burned:
 *
 *  - a canonical FINCO token address (none exists; none may be assumed),
 *  - governance authorization (timelock + multisig, independently reviewed),
 *  - a price-protected, audited conversion route,
 *  - a verifiable burn (supply reduction, not a transfer to a dead address
 *    that the token could still recover).
 *
 * Activating it requires a NEW splitter version (policy version > 1), an
 * explicit governance decision recorded on chain, and independent financial
 * and security review. See docs/W04-ECONOMICS-ARCHITECTURE.md §6.
 */
interface IFincoBurnReserveExecutor {
    /// @notice The canonical FINCO token this executor would burn.
    function fincoToken() external view returns (address);

    /// @notice Converts `amount` of reserve `asset` to FINCO and burns it,
    /// reverting unless at least `minFincoBurned` is destroyed.
    function executeReserveBurn(address asset, uint256 amount, uint256 minFincoBurned)
        external
        returns (uint256 fincoBurned);
}
