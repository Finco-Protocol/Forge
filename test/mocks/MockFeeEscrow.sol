// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {
    IPonsV2FeeEscrow,
    IPonsV2FeePolicy,
    FeePolicySnapshot,
    IPonsV2LaunchFactory,
    GraduationPhase
} from "contractsV2/src/v2/interfaces/ILaunchpadV2.sol";

/// @notice Claimable-balance escrow mock faithful to the IPonsV2FeeEscrow
/// surface the curves, hook and vault program against: native credits take
/// msg.value at face value, token credits pull via transferFrom (so callers
/// must approve exactly as production does), and claims pay out to the
/// caller. Balances are recorded per (recipient, token) with the zero
/// address denoting native ETH.
contract MockFeeEscrow is IPonsV2FeeEscrow {
    using SafeERC20 for IERC20;

    mapping(address recipient => mapping(address token => uint256 amount)) public ledger;

    function credit(address recipient) external payable override {
        ledger[recipient][address(0)] += msg.value;
    }

    function creditToken(address recipient, address token, uint256 amount) external override {
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        ledger[recipient][token] += received;
    }

    function claim() external override returns (uint256 amount) {
        amount = ledger[msg.sender][address(0)];
        ledger[msg.sender][address(0)] = 0;
        if (amount != 0) {
            (bool sent,) = payable(msg.sender).call{value: amount}("");
            require(sent, "escrow: native claim failed");
        }
    }

    function claim(uint256 amount) external override returns (uint256) {
        uint256 available = ledger[msg.sender][address(0)];
        amount = amount > available ? available : amount;
        ledger[msg.sender][address(0)] = available - amount;
        if (amount != 0) {
            (bool sent,) = payable(msg.sender).call{value: amount}("");
            require(sent, "escrow: native claim failed");
        }
        return amount;
    }

    function claimToken(address token) external override returns (uint256 amount) {
        amount = ledger[msg.sender][token];
        ledger[msg.sender][token] = 0;
        if (amount != 0) IERC20(token).safeTransfer(msg.sender, amount);
    }

    function claimToken(address token, uint256 amount) external override returns (uint256) {
        uint256 available = ledger[msg.sender][token];
        amount = amount > available ? available : amount;
        ledger[msg.sender][token] = available - amount;
        if (amount != 0) IERC20(token).safeTransfer(msg.sender, amount);
        return amount;
    }

    function balanceOf(address recipient) external view override returns (uint256) {
        return ledger[recipient][address(0)];
    }

    function balanceOfToken(address recipient, address token)
        external
        view
        override
        returns (uint256)
    {
        return ledger[recipient][token];
    }

    receive() external payable {}
}

/// @notice Protocol fee policy mock implementing IPonsV2FeePolicy with
/// settable fields, so curve/vault wiring can be exercised without the
/// (uncompilable) production factory stack.
contract MockFeePolicy is IPonsV2FeePolicy {
    IPonsV2FeeEscrow public immutable escrow;
    address public protocolRecipient;
    address public operator;
    uint256 public protocolFeeShareBps;
    uint256 public buybackBurnBps;
    uint256 public maxInternalPriceImpactBps;

    constructor(IPonsV2FeeEscrow escrow_) {
        escrow = escrow_;
        protocolRecipient = msg.sender;
        operator = msg.sender;
        protocolFeeShareBps = 3_000;
        buybackBurnBps = 5_000;
        maxInternalPriceImpactBps = 300;
    }

    function setOperator(address operator_) external {
        operator = operator_;
    }

    function setProtocolRecipient(address recipient_) external {
        protocolRecipient = recipient_;
    }

    function setProtocolFeeShareBps(uint256 bps) external {
        protocolFeeShareBps = bps;
    }

    function setBuybackBurnBps(uint256 bps) external {
        buybackBurnBps = bps;
    }

    function setMaxInternalPriceImpactBps(uint256 bps) external {
        maxInternalPriceImpactBps = bps;
    }

    function feeEscrow() external view returns (IPonsV2FeeEscrow) {
        return escrow;
    }

    function feeSweepOperator() external view returns (address) {
        return operator;
    }

    function protocolFeeRecipient() external view returns (address) {
        return protocolRecipient;
    }

    function currentFeePolicy() external view returns (FeePolicySnapshot memory) {
        return FeePolicySnapshot({
            protocolFeeRecipient: protocolRecipient,
            protocolFeeShareBps: uint16(protocolFeeShareBps),
            buybackBurnBps: uint16(buybackBurnBps),
            hookFeeBps: 0,
            maxInternalPriceImpactBps: uint16(maxInternalPriceImpactBps)
        });
    }
}

/// @notice Stand-in for PonsV2LaunchFactory's launch-record surface, which is
/// the only thing PonsV2BuybackVault reads from the factory (to authorize a
/// launch's own bonding curve as a locker).
contract MockLaunchRecord {
    mapping(address token => address curve) public curveForToken;

    function setCurve(address token, address curve) external {
        curveForToken[token] = curve;
    }

    function getLaunchedToken(address token)
        external
        view
        returns (IPonsV2LaunchFactory.LaunchedToken memory)
    {
        return IPonsV2LaunchFactory.LaunchedToken({
            token: token,
            curve: curveForToken[token],
            deployer: address(0),
            creatorFeeRecipient: address(0),
            pairToken: address(0),
            graduationThreshold: 0,
            poolFee: 0,
            tickSpacing: 0,
            creatorTaxBps: 0,
            buybackEnabled: false,
            phase: GraduationPhase.NotGraduated,
            sweptQuote: 0,
            sweptTokens: 0,
            sweptAt: 0,
            exists: curveForToken[token] != address(0)
        });
    }
}
