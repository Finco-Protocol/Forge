// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @notice TEST-ONLY stand-in for the Arbitrum ArbSys precompile (0x64), installed by
/// the Anvil-fork lifecycle test. Anvil cannot execute ArbOS precompiles, so the
/// fork run cannot exercise the real ArbSys; the REAL-chain property it models
/// (ArbSys.arbBlockNumber() == RPC block number, arbBlockHash(n) == RPC hash) is
/// asserted separately, read-only, by test/v4-fork/arbos-block-semantics.test.ts.
contract ArbSysShim {
    uint256 public head;
    mapping(uint256 => bytes32) public hashes;

    function setHead(uint256 h) external {
        head = h;
    }

    function setHash(uint256 n, bytes32 h) external {
        hashes[n] = h;
    }

    function arbBlockNumber() external view returns (uint256) {
        return head;
    }

    function arbBlockHash(uint256 n) external view returns (bytes32) {
        require(n < head && head - n <= 256, "invalid block number");
        return hashes[n];
    }
}
