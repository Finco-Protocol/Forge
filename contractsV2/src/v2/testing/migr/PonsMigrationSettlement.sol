// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Settlement {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract PonsMigrationSettlement {
    IERC20Settlement public immutable asset;
    address public immutable sponsor;
    address public immutable liquidityRecipient;
    bytes32 public immutable campaignId;
    uint64 public immutable fundingDeadline;

    bytes32 public merkleRoot;
    uint256 public totalClaims;
    uint256 public claimed;
    uint256 public liquidityAllocation;
    bool public liquidityReleased;
    bool public finalized;
    mapping(uint256 => bool) public claimedIndex;
    uint256 private entered;

    error Unauthorized();
    error InvalidInput();
    error InvalidState();
    error InvalidProof();
    error AlreadyClaimed();
    error TransferFailed();
    error UnsupportedToken();

    event Funded(uint256 amount);
    event Finalized(bytes32 indexed root, uint256 claims, uint256 liquidity);
    event Claimed(uint256 indexed index, address indexed recipient, uint256 amount);
    event LiquidityReleased(address indexed recipient, uint256 amount);
    event Cancelled(uint256 refunded);
    event ExcessRecovered(uint256 amount);

    modifier onlySponsor() {
        if (msg.sender != sponsor) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (entered != 0) revert InvalidState();
        entered = 1;
        _;
        entered = 0;
    }

    constructor(address token, address lpRecipient, bytes32 migrationId, uint64 deadline) {
        if (token == address(0) || token.code.length == 0 || lpRecipient == address(0)
            || migrationId == bytes32(0) || deadline <= block.timestamp) revert InvalidInput();
        asset = IERC20Settlement(token);
        sponsor = msg.sender;
        liquidityRecipient = lpRecipient;
        campaignId = migrationId;
        fundingDeadline = deadline;
    }

    function fund(uint256 amount) external onlySponsor nonReentrant {
        if (finalized || block.timestamp > fundingDeadline || amount == 0) revert InvalidState();
        uint256 beforeBalance = asset.balanceOf(address(this));
        _transferFrom(sponsor, address(this), amount);
        if (asset.balanceOf(address(this)) - beforeBalance != amount) revert UnsupportedToken();
        emit Funded(amount);
    }

    function finalize(bytes32 root, uint256 claimsAllocation, uint256 lpAllocation)
        external onlySponsor nonReentrant
    {
        if (finalized || block.timestamp > fundingDeadline || root == bytes32(0)
            || claimsAllocation == 0 || lpAllocation == 0) revert InvalidState();
        if (claimsAllocation + lpAllocation > asset.balanceOf(address(this))) revert InvalidInput();
        merkleRoot = root;
        totalClaims = claimsAllocation;
        liquidityAllocation = lpAllocation;
        finalized = true;
        emit Finalized(root, claimsAllocation, lpAllocation);
    }

    function claim(uint256 index, address recipient, uint256 amount, bytes32[] calldata proof)
        external nonReentrant
    {
        if (!finalized || recipient == address(0) || amount == 0) revert InvalidState();
        if (claimedIndex[index]) revert AlreadyClaimed();
        bytes32 leaf = keccak256(abi.encode(block.chainid, address(this), campaignId, index, recipient, amount));
        bytes32 computed = leaf;
        for (uint256 i; i < proof.length; ++i) {
            bytes32 sibling = proof[i];
            computed = computed < sibling
                ? keccak256(abi.encodePacked(computed, sibling))
                : keccak256(abi.encodePacked(sibling, computed));
        }
        if (computed != merkleRoot) revert InvalidProof();
        if (amount > totalClaims - claimed) revert InvalidInput();
        claimedIndex[index] = true;
        claimed += amount;
        _transferExact(recipient, amount);
        emit Claimed(index, recipient, amount);
    }

    function releaseLiquidity() external onlySponsor nonReentrant {
        if (!finalized || liquidityReleased) revert InvalidState();
        liquidityReleased = true;
        _transferExact(liquidityRecipient, liquidityAllocation);
        emit LiquidityReleased(liquidityRecipient, liquidityAllocation);
    }

    function cancel() external onlySponsor nonReentrant {
        if (finalized || block.timestamp <= fundingDeadline) revert InvalidState();
        uint256 amount = asset.balanceOf(address(this));
        if (amount == 0) revert InvalidState();
        _transferExact(sponsor, amount);
        emit Cancelled(amount);
    }

    function recoverExcess() external onlySponsor nonReentrant {
        if (!finalized) revert InvalidState();
        uint256 reserved = totalClaims - claimed + (liquidityReleased ? 0 : liquidityAllocation);
        uint256 balance = asset.balanceOf(address(this));
        if (balance <= reserved) revert InvalidState();
        uint256 excess = balance - reserved;
        _transferExact(sponsor, excess);
        emit ExcessRecovered(excess);
    }

    function _transferExact(address to, uint256 amount) private {
        uint256 beforeBalance = asset.balanceOf(to);
        (bool success, bytes memory data) = address(asset).call(
            abi.encodeCall(IERC20Settlement.transfer, (to, amount))
        );
        if (!success || (data.length != 0 && (data.length != 32 || !abi.decode(data, (bool))))) {
            revert TransferFailed();
        }
        if (asset.balanceOf(to) - beforeBalance != amount) revert UnsupportedToken();
    }

    function _transferFrom(address from, address to, uint256 amount) private {
        (bool success, bytes memory data) = address(asset).call(
            abi.encodeCall(IERC20Settlement.transferFrom, (from, to, amount))
        );
        if (!success || (data.length != 0 && (data.length != 32 || !abi.decode(data, (bool))))) {
            revert TransferFailed();
        }
    }
}
