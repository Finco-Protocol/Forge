// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IPonsV2LaunchFactory} from "contractsV2-forge/src/v2/interfaces/ILaunchpadV2.sol";

/// @notice Minimal stand-in for the Forge factory's quote-asset policy and
/// launch registry (W04 splitter unit tests). Mirrors the real public
/// getters `approvedPairTokens`, `pairTokenEconomics` and `getLaunchedToken`.
contract MockQuotePolicyFactory {
    struct Economics {
        uint256 phantomQuote;
        uint256 graduationThreshold;
        uint8 decimals;
    }

    mapping(address => bool) public approvedPairTokens;
    mapping(address => Economics) public pairTokenEconomics;
    mapping(address => bool) public isLaunchToken;

    function setQuote(address token, uint256 phantomQuote, uint8 decimals, bool approved) external {
        pairTokenEconomics[token] = Economics(phantomQuote, phantomQuote * 4, decimals);
        approvedPairTokens[token] = approved;
    }

    function setLaunchToken(address token) external {
        isLaunchToken[token] = true;
    }

    function getLaunchedToken(address token)
        external
        view
        returns (IPonsV2LaunchFactory.LaunchedToken memory t)
    {
        t.token = token;
        t.exists = isLaunchToken[token];
    }

    /// Sends ETH like `_payLaunchFee` would.
    function payLaunchFee(address to) external payable {
        (bool ok,) = to.call{value: msg.value}("");
        require(ok, "fee");
    }
}
