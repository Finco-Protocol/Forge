// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/**
 * @notice Minimal stand-in for Uniswap Permit2, scoped to the surface the
 * W02 lifecycle exercises: the GraduationExecutor's
 * approve(token, spender, amount, expiration) and the PositionManager's
 * allowanceTransfer-style transferFrom(owner, to, token, amount).
 */
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockPermit2 {
    struct Allowance {
        uint160 amount;
        uint64 expiration;
    }

    mapping(address owner => mapping(address token => mapping(address spender => Allowance))) public
        allowances;

    error InsufficientAllowance();
    error ExpiredAllowance();
    error NotOwner();

    // Matches IAllowanceTransfer's selector: approve(address,address,uint160,uint48).
    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        allowances[msg.sender][token][spender] = Allowance({amount: amount, expiration: expiration});
    }

    function transferFrom(address from, address to, uint160 amount, address token) external {
        Allowance storage a = allowances[from][token][msg.sender];
        if (uint64(block.timestamp) > a.expiration) revert ExpiredAllowance();
        if (a.amount < amount) revert InsufficientAllowance();
        a.amount -= amount;
        ERC20(token).transferFrom(from, to, amount);
    }
}
