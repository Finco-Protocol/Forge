// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ForgeLifecycleTest} from "./ForgeLifecycle.t.sol";
import {ForgeLaunchAuthorizer} from "contractsV2-forge/src/v2/forge/ForgeLaunchAuthorizer.sol";
import {IForgeLaunchAuthorizer} from "contractsV2-forge/src/v2/forge/IForgeLaunchAuthorizer.sol";
import {PonsV2LaunchFactory} from "contractsV2-forge/src/v2/PonsV2LaunchFactory.sol";

/**
 * @title ForgeLaunchCallTest
 * @notice W03 Correction A (W02-SIZE-01): the factory forwards its entry
 * calldata to `ForgeLaunchAuthorizer.requireAuthorizedLaunchCall`, which
 * rebuilds the LaunchIntent. These tests pin: the EIP-170 size bound, the
 * factory-only entry, every factory entry point (3-arg, exemption-list,
 * forwarder), deployer substitution, unknown selectors, exemption
 * canonicalisation and equivalence with the struct path's signed digest.
 * Inherits the full W02 lifecycle fixture (its tests re-run here too).
 */
contract ForgeLaunchCallTest is ForgeLifecycleTest {
    uint256 internal constant EIP170_LIMIT = 24_576;
    address internal constant EX_A = address(0xAA);
    address internal constant EX_B = address(0xBB);

    function _signIntent(IForgeLaunchAuthorizer.LaunchIntent memory i)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = authorizer.consentDigest(i, creator, false);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(creatorPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _sortedHash(address x, address y) internal pure returns (bytes32) {
        address[] memory sorted = new address[](2);
        (sorted[0], sorted[1]) = x < y ? (x, y) : (y, x);
        return keccak256(abi.encode(sorted));
    }

    function test_factory_runtime_within_eip170() public view {
        assertLe(address(factory).code.length, EIP170_LIMIT, "factory exceeds EIP-170");
    }

    function test_call_entry_is_factory_only() public {
        bytes memory data = abi.encodeWithSelector(bytes4(0xdeadbeef));
        vm.expectRevert(ForgeLaunchAuthorizer.WrongFactory.selector);
        authorizer.requireAuthorizedLaunchCall(data, creator, intent.economicsDigest);
    }

    function test_unknown_or_short_entry_rejected() public {
        bytes memory unknown = abi.encodeWithSelector(bytes4(0xdeadbeef), uint256(1));
        bytes memory short = hex"0102";
        bytes32 econ = intent.economicsDigest;
        vm.prank(address(factory));
        vm.expectRevert(ForgeLaunchAuthorizer.UnknownLaunchEntry.selector);
        authorizer.requireAuthorizedLaunchCall(unknown, creator, econ);
        vm.prank(address(factory));
        vm.expectRevert(ForgeLaunchAuthorizer.UnknownLaunchEntry.selector);
        authorizer.requireAuthorizedLaunchCall(short, creator, econ);
    }

    function test_forwarded_deployer_cannot_be_substituted() public {
        PonsV2LaunchFactory.TokenParams memory params = _params();
        bytes memory data = abi.encodeCall(
            PonsV2LaunchFactory.launchTokenFor, (params, 0, address(0), creator, new address[](0))
        );
        bytes32 econ = intent.economicsDigest;
        vm.prank(address(factory));
        vm.expectRevert(ForgeLaunchAuthorizer.WrongCreator.selector);
        authorizer.requireAuthorizedLaunchCall(data, buyer1, econ);
    }

    function test_forwarder_entry_point_is_authorized_by_calldata() public {
        address forwarder = makeAddr("forwarder");
        vm.prank(governance);
        factory.setLaunchForwarder(forwarder);
        PonsV2LaunchFactory.TokenParams memory params = _params();
        address[] memory none = new address[](0);
        vm.prank(forwarder);
        (address token,) = factory.launchTokenFor(params, 0, address(0), creator, none);
        assertTrue(token != address(0), "forwarded launch must succeed");
        assertTrue(authorizer.nonceUsed(creator, 0), "nonce consumed");
    }

    function test_forwarder_cannot_launch_for_another_deployer() public {
        address forwarder = makeAddr("forwarder");
        vm.prank(governance);
        factory.setLaunchForwarder(forwarder);
        PonsV2LaunchFactory.TokenParams memory params = _params();
        address[] memory none = new address[](0);
        // The creator signed for `creator`; attributing it to buyer1 fails.
        vm.prank(forwarder);
        vm.expectRevert(ForgeLaunchAuthorizer.WrongCreator.selector);
        factory.launchTokenFor(params, 0, address(0), buyer1, none);
    }

    function test_exemption_list_reorder_accepted_tamper_rejected() public {
        IForgeLaunchAuthorizer.LaunchIntent memory i = intent;
        i.exemptionListHash = _sortedHash(EX_A, EX_B);
        PonsV2LaunchFactory.TokenParams memory params = _params();
        params.creatorSignature = _signIntent(i);
        address[] memory onlyA = new address[](1);
        onlyA[0] = EX_A;
        vm.prank(creator);
        vm.expectRevert(ForgeLaunchAuthorizer.WrongCreator.selector);
        factory.launchToken(params, 0, address(0), onlyA);
        address[] memory reordered = new address[](2);
        reordered[0] = EX_B;
        reordered[1] = EX_A;
        vm.prank(creator);
        (address token,) = factory.launchToken(params, 0, address(0), reordered);
        assertTrue(token != address(0), "reordered exemption list must be accepted");
    }

    function test_canonical_exemption_hash_rules() public {
        address[] memory ab = new address[](2);
        ab[0] = EX_A;
        ab[1] = EX_B;
        assertEq(authorizer.canonicalExemptionHash(ab), _sortedHash(EX_A, EX_B));
        address[] memory aa = new address[](2);
        aa[0] = EX_A;
        aa[1] = EX_A;
        assertTrue(authorizer.canonicalExemptionHash(aa) != _sortedHash(EX_A, EX_B));
        address[] memory zero = new address[](1);
        vm.expectRevert(ForgeLaunchAuthorizer.InvalidExemptionAddress.selector);
        authorizer.canonicalExemptionHash(zero);
        address[] memory tooLong = new address[](33);
        vm.expectRevert(ForgeLaunchAuthorizer.ExemptionListTooLong.selector);
        authorizer.canonicalExemptionHash(tooLong);
    }

    function test_calldata_path_binds_same_digest_as_struct_path() public {
        // The consent was signed over authorizer.consentDigest(intent, ...),
        // i.e. the struct-path digest; the calldata path must accept it and
        // emit the identical effective metadata hash.
        bytes32 expectedMeta =
            authorizer.metadataDigest(intent.tokenMetadataHash, creator, false, 0);
        PonsV2LaunchFactory.TokenParams memory params = _params();
        vm.expectEmit(true, true, false, true, address(authorizer));
        emit ForgeLaunchAuthorizer.LaunchAuthorized(
            creator, REPO_ID, expectedMeta, intent.economicsDigest
        );
        vm.prank(creator);
        factory.launchToken(params, 0, address(0));
    }

    function test_three_entry_points_reject_unsigned_metadata_change() public {
        PonsV2LaunchFactory.TokenParams memory params = _params();
        params.symbol = "EVIL";
        address[] memory none = new address[](0);
        vm.prank(creator);
        vm.expectRevert(ForgeLaunchAuthorizer.WrongCreator.selector);
        factory.launchToken(params, 0, address(0));
        vm.prank(creator);
        vm.expectRevert(ForgeLaunchAuthorizer.WrongCreator.selector);
        factory.launchToken(params, 0, address(0), none);
    }
}
