// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Warp {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
}

contract PonsWarpOriginVault {
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant RELEASE_TYPEHASH =
        keccak256("Release(bytes32 burnId,bytes32 solanaMint,address recipient,uint256 amount,uint256 deadline)");
    bytes32 private constant NAME_HASH = keccak256("Pons Warp Origin Vault");
    bytes32 private constant VERSION_HASH = keccak256("1");
    uint256 private constant SECP256K1_HALF_N =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    IERC20Warp public immutable originToken;
    bytes32 public immutable solanaMint;
    uint256 public immutable quorum;
    address public immutable depositController;
    bytes32 public immutable DOMAIN_SEPARATOR;

    mapping(address => bool) public isValidator;
    mapping(bytes32 => bool) public usedBurn;
    uint256 public nextDepositId;
    bool public depositsPaused;
    uint256 private lockState;

    error InvalidInput();
    error InvalidState();
    error Unauthorized();
    error InvalidSignature();
    error InsufficientQuorum();
    error TransferFailed();
    error UnsupportedToken();
    error Reentrancy();

    event Deposited(
        uint256 indexed depositId,
        address indexed sender,
        bytes32 indexed solanaRecipient,
        uint256 amount
    );
    event Released(bytes32 indexed burnId, address indexed recipient, uint256 amount);
    event DepositsPaused(bool paused);

    modifier nonReentrant() {
        if (lockState != 0) revert Reentrancy();
        lockState = 1;
        _;
        lockState = 0;
    }

    constructor(
        address token,
        bytes32 wrappedMint,
        address controller,
        address[] memory validators,
        uint256 requiredSignatures
    ) {
        if (token == address(0) || token.code.length == 0 || wrappedMint == bytes32(0)
            || controller == address(0) || requiredSignatures == 0
            || requiredSignatures > validators.length) revert InvalidInput();

        originToken = IERC20Warp(token);
        solanaMint = wrappedMint;
        depositController = controller;
        quorum = requiredSignatures;

        for (uint256 i; i < validators.length; ++i) {
            address validator = validators[i];
            if (validator == address(0) || isValidator[validator]) revert InvalidInput();
            isValidator[validator] = true;
        }

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this))
        );
    }

    function deposit(uint256 amount, bytes32 solanaRecipient)
        external nonReentrant returns (uint256 depositId)
    {
        if (depositsPaused || amount == 0 || solanaRecipient == bytes32(0)) revert InvalidState();

        uint256 beforeBalance = originToken.balanceOf(address(this));
        _callToken(abi.encodeCall(IERC20Warp.transferFrom, (msg.sender, address(this), amount)));
        uint256 afterBalance = originToken.balanceOf(address(this));
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != amount) {
            revert UnsupportedToken();
        }

        depositId = nextDepositId++;
        emit Deposited(depositId, msg.sender, solanaRecipient, amount);
    }

    function release(
        bytes32 burnId,
        address recipient,
        uint256 amount,
        uint256 deadline,
        bytes[] calldata signatures
    ) external nonReentrant {
        if (burnId == bytes32(0) || recipient == address(0) || amount == 0
            || block.timestamp > deadline) revert InvalidInput();
        if (usedBurn[burnId]) revert InvalidState();
        if (signatures.length < quorum) revert InsufficientQuorum();

        bytes32 structHash = keccak256(
            abi.encode(RELEASE_TYPEHASH, burnId, solanaMint, recipient, amount, deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

        address previous;
        for (uint256 i; i < signatures.length; ++i) {
            address signer = _recover(digest, signatures[i]);
            if (!isValidator[signer] || signer <= previous) revert InvalidSignature();
            previous = signer;
        }

        usedBurn[burnId] = true;
        uint256 vaultBefore = originToken.balanceOf(address(this));
        uint256 recipientBefore = originToken.balanceOf(recipient);
        if (vaultBefore < amount) revert InvalidState();
        _callToken(abi.encodeCall(IERC20Warp.transfer, (recipient, amount)));
        uint256 vaultAfter = originToken.balanceOf(address(this));
        uint256 recipientAfter = originToken.balanceOf(recipient);
        if (vaultAfter > vaultBefore || vaultBefore - vaultAfter != amount
            || recipientAfter < recipientBefore || recipientAfter - recipientBefore != amount) {
            revert UnsupportedToken();
        }
        emit Released(burnId, recipient, amount);
    }

    function setDepositsPaused(bool paused) external {
        if (msg.sender != depositController) revert Unauthorized();
        depositsPaused = paused;
        emit DepositsPaused(paused);
    }

    function _callToken(bytes memory callData) private {
        (bool success, bytes memory result) = address(originToken).call(callData);
        if (!success || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) {
            revert TransferFailed();
        }
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > SECP256K1_HALF_N || uint256(s) == 0 || (v != 27 && v != 28)) {
            revert InvalidSignature();
        }
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }
}
