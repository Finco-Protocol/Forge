// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice ERC-20 that burns `feeBps` of every transfer, so the receiver gets
/// less than the nominal amount (W04 fee-on-transfer accounting tests).
contract FeeOnTransferToken is ERC20 {
    uint256 public immutable feeBps;

    constructor(uint256 feeBps_) ERC20("Fee Token", "FOT") {
        feeBps = feeBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = (value * feeBps) / 10_000;
            super._update(from, address(0), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}
