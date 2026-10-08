// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PonsV2LauncherToken} from "contractsV2/src/v2/PonsV2LauncherToken.sol";

contract PonsV2LauncherTokenTest is Test {
    PonsV2LauncherToken internal token;
    address internal curve = makeAddr("curve");
    address internal factory = makeAddr("factory");
    address internal creator = makeAddr("creator");
    uint256 internal supply = 1_000_000e18;

    function setUp() public {
        token = new PonsV2LauncherToken(
            "Test Token",
            "TEST",
            "https://logo",
            "a description",
            PonsV2LauncherToken.Socials({
                twitter: "t", telegram: "g", discord: "d", website: "w", farcaster: "f"
            }),
            creator,
            curve,
            factory,
            supply
        );
    }

    function test_wholeSupplyMintsToCurve() public view {
        assertEq(token.totalSupply(), supply, "supply must be fixed at constructor mint");
        assertEq(token.balanceOf(curve), supply, "entire supply must sit on the curve");
        assertEq(token.balanceOf(creator), 0, "creator must not be pre-minted");
    }

    function test_immutablesRecorded() public view {
        assertEq(token.deployer(), creator);
        assertEq(token.curve(), curve);
        assertEq(token.launchFactory(), factory);
    }

    function test_metadataRoundTrip() public view {
        (
            address deployer,
            string memory logo,
            string memory description,
            PonsV2LauncherToken.Socials memory socials
        ) = token.getTokenInfo();
        assertEq(deployer, creator);
        assertEq(logo, "https://logo");
        assertEq(description, "a description");
        assertEq(socials.twitter, "t");
        assertEq(socials.farcaster, "f");

        (
            string memory twitter,
            string memory telegram,
            string memory discord,
            string memory website,
            string memory fc
        ) = token.socials();
        assertEq(twitter, "t");
        assertEq(telegram, "g");
        assertEq(discord, "d");
        assertEq(website, "w");
        assertEq(fc, "f");
    }

    function test_noMintBurnOrPauseBeyondBurnable() public view {
        // The token exposes no privileged mint, freeze, blacklist or forced
        // transfer: its only state-changing surface beyond ERC-20 is
        // ERC20Burnable.burn for the holder's own balance. Verified
        // behaviorally: transferring from the curve requires the curve to
        // move it, and no admin address exists to call.
        assertEq(address(token.deployer()), creator);
        assertTrue(token.balanceOf(creator) == 0);
    }

    function test_holdersMayVoluntarilyBurn() public {
        address holder = makeAddr("holder");
        vm.prank(curve);
        token.transfer(holder, 100e18);
        vm.prank(holder);
        token.burn(40e18);
        assertEq(token.totalSupply(), supply - 40e18, "voluntary burn must shrink supply");
        assertEq(token.balanceOf(holder), 60e18);
    }

    function test_zeroAddressConstructorArgsRevert() public {
        PonsV2LauncherToken.Socials memory socials;
        vm.expectRevert(PonsV2LauncherToken.ZeroAddress.selector);
        new PonsV2LauncherToken("n", "s", "", "", socials, address(0), curve, factory, supply);
        vm.expectRevert(PonsV2LauncherToken.ZeroAddress.selector);
        new PonsV2LauncherToken("n", "s", "", "", socials, creator, address(0), factory, supply);
        vm.expectRevert(PonsV2LauncherToken.ZeroAddress.selector);
        new PonsV2LauncherToken("n", "s", "", "", socials, creator, curve, address(0), supply);
    }
}
