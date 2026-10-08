// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Minimal mintable/burnable ERC-20 for tests, with an optional
/// permanent transfer tax so fee-on-transfer quote-asset behavior can be
/// exercised end to end. Forge's own mock helpers are intentionally not used
/// so the vendored OZ tree is the only dependency in the build graph.
contract MockERC20 is ERC20 {
    address public immutable taxRecipient;
    uint256 public immutable taxBps;

    constructor(string memory name_, string memory symbol_, uint8, address taxRecipient_, uint256 taxBps_)
        ERC20(name_, symbol_)
    {
        taxRecipient = taxRecipient_;
        taxBps = taxBps_;
    }

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 amount) internal override {
        // Main transfer lands first, then the tax is skimmed from what the
        // recipient actually holds — matching fee-on-transfer semantics.
        super._update(from, to, amount);
        if (taxBps != 0 && from != address(0) && to != address(0) && from != taxRecipient && to != taxRecipient) {
            uint256 tax = (amount * taxBps) / 10_000;
            if (tax != 0) {
                super._update(to, taxRecipient, tax);
            }
        }
    }
}
