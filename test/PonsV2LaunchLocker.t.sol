// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {PonsV2LaunchLocker} from "contractsV2/src/v2/PonsV2LaunchLocker.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {IERC721ReceiverLike} from "contractsV2/src/v2/interfaces/ILaunchpadV2.sol";

/// @notice Minimal ERC-721 harness for the locker: the real PositionManager
/// is not vendored, so the test mints bare NFTs it can point at arbitrary
/// owners, which is all `lockPosition`'s ownerOf check needs.
contract MockPositionNFT {
    mapping(uint256 => address) private _owner;
    uint256 public nextId;

    function mint(address to) external returns (uint256 id) {
        id = ++nextId;
        _owner[id] = to;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return _owner[tokenId];
    }
}

contract PonsV2LaunchLockerTest is Test {
    PonsV2LaunchLocker internal locker;
    MockPositionNFT internal nft;
    address internal positionManager = makeAddr("positionManager");
    address internal factory = makeAddr("factory");
    address internal owner = makeAddr("lockerOwner");

    function setUp() public {
        vm.etch(positionManager, address(new MockPositionNFT()).code);
        nft = MockPositionNFT(positionManager);
        locker = new PonsV2LaunchLocker(owner, positionManager);
        vm.prank(owner);
        locker.setFactory(factory);
    }

    function test_factoryWiringIsOneTime() public {
        vm.prank(owner);
        vm.expectRevert(PonsV2LaunchLocker.AlreadyInitialized.selector);
        locker.setFactory(makeAddr("other"));
    }

    function test_factoryWiringOnlyOwner() public {
        vm.prank(factory);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, factory)
        );
        locker.setFactory(makeAddr("other"));
    }

    function test_lockPositionVerifiesCustody() public {
        uint256 id = nft.mint(address(locker));
        vm.prank(factory);
        locker.lockPosition(makeAddr("token"), id);
        assertTrue(locker.isLocked(makeAddr("token")));
        assertEq(locker.lockedPositions(makeAddr("token")), id);
    }

    function test_lockPositionRejectsWhenNftNotHeld() public {
        uint256 id = nft.mint(makeAddr("attacker"));
        vm.prank(factory);
        vm.expectRevert(PonsV2LaunchLocker.PositionNotHeld.selector);
        locker.lockPosition(makeAddr("token"), id);
    }

    function test_lockPositionOnlyFactory() public {
        uint256 id = nft.mint(address(locker));
        vm.expectRevert(PonsV2LaunchLocker.NotFactory.selector);
        locker.lockPosition(makeAddr("token"), id);
    }

    function test_positionCannotBeLockedTwice() public {
        address token = makeAddr("token");
        uint256 id = nft.mint(address(locker));
        vm.prank(factory);
        locker.lockPosition(token, id);
        uint256 other = nft.mint(address(locker));
        vm.prank(factory);
        vm.expectRevert(PonsV2LaunchLocker.PositionAlreadyLocked.selector);
        locker.lockPosition(token, other);
    }

    function test_lockTokenSupplyTransfersToLocker() public {
        MockERC20 token = new MockERC20("T", "T", 18, address(0), 0);
        vm.startPrank(factory);
        token.mint(factory, 1000e18);
        token.approve(address(locker), type(uint256).max);
        locker.lockTokenSupply(address(token), 1000e18);
        vm.stopPrank();
        assertEq(token.balanceOf(address(locker)), 1000e18);
        assertEq(locker.lockedTokenSupply(address(token)), 1000e18);
    }

    function test_lockTokenSupplyOnlyFactory() public {
        MockERC20 token = new MockERC20("T", "T", 18, address(0), 0);
        vm.expectRevert(PonsV2LaunchLocker.NotFactory.selector);
        locker.lockTokenSupply(address(token), 1);
    }

    function test_onERC721ReceivedOnlyAcceptsPositionManager() public {
        vm.expectRevert(PonsV2LaunchLocker.NotPositionManager.selector);
        locker.onERC721Received(address(0), address(0), 0, "");
        vm.prank(positionManager);
        assertEq(
            locker.onERC721Received(address(0), address(0), 0, ""),
            IERC721ReceiverLike.onERC721Received.selector,
            "canonical PositionManager transfers must be accepted"
        );
    }
}
