// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {PonsV2FeeEscrow} from "contractsV2-forge/src/v2/PonsV2FeeEscrow.sol";
import {
    ForgeProtocolRevenueSplitter
} from "contractsV2-forge/src/v2/forge/ForgeProtocolRevenueSplitter.sol";
import {IPonsV2FeeEscrow} from "contractsV2-forge/src/v2/interfaces/ILaunchpadV2.sol";
import {ForgeTestToken} from "./mocks/ForgeTestToken.sol";
import {FeeOnTransferToken} from "./mocks/FeeOnTransferToken.sol";
import {MockQuotePolicyFactory} from "./mocks/MockQuotePolicyFactory.sol";

/// @notice Stand-in for a Forge curve/hook: credits fees to escrow keys.
contract FeeSource {
    function creditNative(IPonsV2FeeEscrow escrow, address recipient) external payable {
        escrow.credit{value: msg.value}(recipient);
    }

    function creditToken(IPonsV2FeeEscrow escrow, address recipient, address token, uint256 amt)
        external
    {
        ForgeTestToken(token).approve(address(escrow), amt);
        escrow.creditToken(recipient, token, amt);
    }
}

/// @notice Test double for the Arbitrum ArbSys precompile (0x64) with an L2
/// numbering deliberately unrelated to `block.number`, as measured on Robinhood
/// Chain 4663 (EVM block.number = parent-chain number, RPC block = L2 number).
contract MockArbSys {
    uint256 public constant L2_OFFSET = 1_000_000;

    function arbBlockNumber() external view returns (uint256) {
        return block.number + L2_OFFSET;
    }

    function arbBlockHash(uint256 n) external view returns (bytes32) {
        uint256 head = block.number + L2_OFFSET;
        require(n < head && head - n <= 256, "invalid block number");
        return keccak256(abi.encode("l2", n));
    }
}

/// @notice Shared attestation helpers (EIP-712 `EligibleRevenue`).
abstract contract AttestationHelpers is Test {
    /// Mines one block and pins a deterministic hash for the evidence block
    /// (the block just mined past), which the splitter checks via blockhash.
    function _evidence() internal returns (uint64 evidenceBlock, bytes32 evidenceHash) {
        uint256 next = vm.getBlockNumber() + 1;
        evidenceBlock = uint64(next - 1);
        evidenceHash = keccak256(abi.encode("block", evidenceBlock));
        vm.roll(next);
        vm.setBlockhash(evidenceBlock, evidenceHash);
    }

    function _authFor(
        ForgeProtocolRevenueSplitter s,
        address factory,
        address asset,
        uint256 cumulative,
        uint64 nonce
    ) internal returns (ForgeProtocolRevenueSplitter.EligibleRevenue memory a) {
        (uint64 evidenceBlock, bytes32 evidenceHash) = _evidence();
        a = ForgeProtocolRevenueSplitter.EligibleRevenue({
            escrow: address(s.feeEscrow()),
            factory: factory,
            asset: asset,
            cumulativeEligible: cumulative,
            nonce: nonce,
            deadline: uint64(vm.getBlockTimestamp() + 1 hours),
            evidenceBlock: evidenceBlock,
            evidenceBlockHash: evidenceHash
        });
    }

    function _sign(
        ForgeProtocolRevenueSplitter s,
        uint256 key,
        ForgeProtocolRevenueSplitter.EligibleRevenue memory a
    ) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 sig) = vm.sign(key, s.eligibleRevenueDigest(a));
        return abi.encodePacked(r, sig, v);
    }
}

/**
 * @title ForgeRevenueSplitterTest
 * @notice W04 unit + fuzz suite for ForgeProtocolRevenueSplitter against the
 * REAL canonical PonsV2FeeEscrow (not the W02 mock). Correction A: every pull
 * is bounded by an attested cumulative eligible-revenue ceiling.
 */
contract ForgeRevenueSplitterTest is AttestationHelpers {
    PonsV2FeeEscrow internal escrow;
    ForgeProtocolRevenueSplitter internal splitter;
    ForgeTestToken internal usdx;
    FeeSource internal source;
    MockQuotePolicyFactory internal factory;

    address internal governance = makeAddr("governance");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal attacker = makeAddr("attacker");
    address internal attestor;
    uint256 internal attestorKey;

    address internal constant NATIVE = address(0);

    mapping(address asset => uint256) internal eligible;
    uint256 internal homeChainId;

    function setUp() public {
        vm.roll(1_000);
        homeChainId = block.chainid;
        (attestor, attestorKey) = makeAddrAndKey("attestor");
        escrow = new PonsV2FeeEscrow();
        splitter = new ForgeProtocolRevenueSplitter(escrow, governance, treasury, attestor);
        usdx = new ForgeTestToken("USD X", "USDX");
        source = new FeeSource();
        factory = new MockQuotePolicyFactory();
        factory.setQuote(address(usdx), 1e18, 18, true);
        vm.startPrank(governance);
        splitter.setForgeFactory(address(factory));
        splitter.setAssetApproved(address(usdx), true);
        vm.stopPrank();
    }

    // ── helpers ──────────────────────────────────────────────────────────

    function _auth(address asset, uint256 cumulative)
        internal
        returns (ForgeProtocolRevenueSplitter.EligibleRevenue memory)
    {
        // W05: nonces are strictly sequential on chain; always use the next one.
        return _authFor(
            splitter, address(factory), asset, cumulative, splitter.ledger(asset).authNonce + 1
        );
    }

    /// Attests `added` more VERIFIED protocol-leg credits for `asset`.
    function _attest(address asset, uint256 added) internal {
        eligible[asset] += added;
        ForgeProtocolRevenueSplitter.EligibleRevenue memory a = _auth(asset, eligible[asset]);
        splitter.authorizeEligibleRevenue(a, _sign(splitter, attestorKey, a));
    }

    /// Mirrors a curve/hook sweep: 30% protocol to the splitter, 70% creator,
    /// then the attestor attests the protocol leg (a Forge-source credit).
    function _sweepNative(uint256 baseFee) internal returns (uint256 protocol, uint256 creatorAmt) {
        protocol = (baseFee * 3_000) / 10_000;
        creatorAmt = baseFee - protocol;
        vm.deal(address(this), baseFee);
        source.creditNative{value: protocol}(escrow, address(splitter));
        source.creditNative{value: creatorAmt}(escrow, creator);
        _attest(NATIVE, protocol);
    }

    function _sweepToken(uint256 baseFee) internal returns (uint256 protocol, uint256 creatorAmt) {
        protocol = (baseFee * 3_000) / 10_000;
        creatorAmt = baseFee - protocol;
        usdx.mint(address(source), baseFee);
        source.creditToken(escrow, address(splitter), address(usdx), protocol);
        source.creditToken(escrow, creator, address(usdx), creatorAmt);
        _attest(address(usdx), protocol);
    }

    /// A third party credits the splitter's escrow key directly.
    function _thirdPartyNative(uint256 amount) internal {
        vm.deal(attacker, amount);
        vm.prank(attacker);
        escrow.credit{value: amount}(address(splitter));
    }

    function _assertConserved(address asset) internal view {
        (uint256 bal, uint256 accounted,, uint256 deficit) = splitter.reconcile(asset);
        assertEq(deficit, 0, "no deficit");
        assertGe(bal, accounted, "balance covers liabilities");
        ForgeProtocolRevenueSplitter.AssetLedger memory l = splitter.ledger(asset);
        assertEq(
            l.treasuryAllocated + l.reserveAllocated, l.revenueReceived, "every unit allocated once"
        );
        assertEq(l.reserveAllocated, l.revenueReceived / 3, "reserve is floor(revenue/3)");
        assertLe(l.treasuryPaid, l.treasuryAllocated, "never overpaid");
        assertLe(l.escrowClaimed, l.eligibleCeiling, "never above the verified ceiling");
        assertLe(l.revenueReceived, l.escrowClaimed, "receipt never exceeds escrow debit");
    }

    // ── Reproduction (pre-correction finding) ───────────────────────────

    /// The pre-correction splitter allocated legit + third-party escrow
    /// credits together (1.03 ETH allocated for a 0.03 ETH fee). Now only
    /// the verified 0.03 ETH enters 70/20/10; the 1 ETH stays in escrow.
    function test_reproduction_third_party_credit_is_not_allocated() public {
        (uint256 protocol,) = _sweepNative(0.1 ether);
        _thirdPartyNative(1 ether);
        uint256 got = splitter.pullRevenue(NATIVE, 0);
        assertEq(got, protocol, "only the verified fee");
        assertEq(splitter.ledger(NATIVE).revenueReceived, 0.03 ether);
        assertEq(escrow.balanceOf(address(splitter)), 1 ether, "third-party credit stays");
        _assertConserved(NATIVE);
    }

    // ── A / 1 / 3: legitimate fee only, 70/20/10, native payout ─────────

    function test_A_native_70_20_10_on_eligible_base_fee() public {
        (uint256 protocol, uint256 creatorAmt) = _sweepNative(10 ether);
        assertEq(creatorAmt, 7 ether);
        uint256 got = splitter.pullRevenue(NATIVE, 0);
        assertEq(got, protocol);
        assertEq(splitter.treasuryLiability(NATIVE), 2 ether, "20 points of the base fee");
        assertEq(splitter.reserveLiability(NATIVE), 1 ether, "10 points of the base fee");
        assertEq(escrow.balanceOf(creator), 7 ether, "creator 70% untouched in escrow");

        uint256 before = treasury.balance;
        vm.prank(treasury);
        splitter.claimTreasury(NATIVE, 0);
        assertEq(treasury.balance - before, 2 ether);
        _assertConserved(NATIVE);
    }

    // ── B: third-party credit only → zero eligible allocation ───────────

    function test_B_third_party_only_allocates_nothing() public {
        _thirdPartyNative(5 ether);
        vm.expectRevert(ForgeProtocolRevenueSplitter.NothingReceived.selector);
        splitter.pullRevenue(NATIVE, 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                ForgeProtocolRevenueSplitter.ExceedsVerifiedRevenue.selector, 1, 0
            )
        );
        splitter.pullRevenue(NATIVE, 1);
        assertEq(splitter.ledger(NATIVE).revenueReceived, 0);
        assertEq(escrow.balanceOf(address(splitter)), 5 ether);
    }

    // ── C: fee + third-party credit → allocate ≤ verified fee ───────────

    function test_C_legit_plus_third_party_bounded_by_verified() public {
        (uint256 protocol,) = _sweepNative(10 ether);
        _thirdPartyNative(4 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                ForgeProtocolRevenueSplitter.ExceedsVerifiedRevenue.selector, protocol + 1, protocol
            )
        );
        splitter.pullRevenue(NATIVE, protocol + 1);
        assertEq(splitter.pullRevenue(NATIVE, 0), protocol);
        assertEq(splitter.treasuryLiability(NATIVE), 2 ether);
        assertEq(splitter.reserveLiability(NATIVE), 1 ether);
        assertEq(escrow.balanceOf(address(splitter)), 4 ether);
        vm.expectRevert(ForgeProtocolRevenueSplitter.NothingReceived.selector);
        splitter.pullRevenue(NATIVE, 0);
        _assertConserved(NATIVE);
    }

    // ── D / E: third-party credit before and after a sweep ──────────────

    function test_D_E_third_party_before_and_after_sweep() public {
        _thirdPartyNative(2 ether); // D: before the sweep
        _sweepNative(1 ether); // 0.3 verified
        assertEq(splitter.pullRevenue(NATIVE, 0), 0.3 ether);
        _thirdPartyNative(3 ether); // E: after the sweep (and after a pull)
        vm.expectRevert(ForgeProtocolRevenueSplitter.NothingReceived.selector);
        splitter.pullRevenue(NATIVE, 0);
        _sweepNative(2 ether); // 0.6 verified
        assertEq(splitter.pullRevenue(NATIVE, 0), 0.6 ether);
        assertEq(splitter.ledger(NATIVE).revenueReceived, 0.9 ether);
        assertEq(escrow.balanceOf(address(splitter)), 5 ether, "all third-party credit held");
        _assertConserved(NATIVE);
    }

    // ── F / 6 / 7: partial pulls, dust and cumulative rounding ──────────

    function test_F_zero_pull_reverts_and_dust_rounds_to_treasury() public {
        vm.expectRevert(ForgeProtocolRevenueSplitter.NothingReceived.selector);
        splitter.pullRevenue(NATIVE, 0);

        for (uint256 i; i < 3; ++i) {
            vm.deal(address(this), 1);
            source.creditNative{value: 1}(escrow, address(splitter));
            _attest(NATIVE, 1);
            splitter.pullRevenue(NATIVE, 0);
            if (i == 0) {
                assertEq(splitter.treasuryLiability(NATIVE), 1, "1 wei: reserve floor(1/3)=0");
                assertEq(splitter.reserveLiability(NATIVE), 0);
            }
        }
        assertEq(splitter.reserveLiability(NATIVE), 1, "no per-pull drift");
        assertEq(splitter.treasuryLiability(NATIVE), 2);
        _assertConserved(NATIVE);
    }

    function testFuzz_F_partial_pulls_conserve(uint96 fee, uint96 thirdParty, uint8 parts) public {
        uint256 protocol = bound(fee, 1, 1_000_000 ether);
        uint256 n = bound(parts, 1, 6);
        vm.deal(address(this), protocol);
        source.creditNative{value: protocol}(escrow, address(splitter));
        _attest(NATIVE, protocol);
        if (thirdParty != 0) _thirdPartyNative(thirdParty);
        uint256 total;
        for (uint256 i; i < n; ++i) {
            uint256 left = splitter.verifiedHeadroom(NATIVE);
            if (left == 0) break;
            uint256 amt = i == n - 1 ? left : bound(uint256(keccak256(abi.encode(i))), 1, left);
            total += splitter.pullRevenue(NATIVE, amt);
        }
        assertLe(total, protocol, "never more than verified");
        assertEq(escrow.balanceOf(address(splitter)), protocol - total + thirdParty);
        _assertConserved(NATIVE);
    }

    function testFuzz_cumulative_split_exact(uint96[8] memory amounts) public {
        uint256 total;
        for (uint256 i; i < amounts.length; ++i) {
            uint256 a = amounts[i];
            if (a == 0) continue;
            vm.deal(address(this), a);
            source.creditNative{value: a}(escrow, address(splitter));
            _attest(NATIVE, a);
            splitter.pullRevenue(NATIVE, 0);
            total += a;
        }
        ForgeProtocolRevenueSplitter.AssetLedger memory l = splitter.ledger(NATIVE);
        assertEq(l.revenueReceived, total);
        assertEq(l.reserveAllocated, total / 3);
        assertEq(l.treasuryAllocated, total - total / 3);
        _assertConserved(NATIVE);
    }

    function testFuzz_extreme_amounts(uint256 amount) public {
        amount = bound(amount, 1, type(uint128).max);
        usdx.mint(address(source), amount);
        source.creditToken(escrow, address(splitter), address(usdx), amount);
        _attest(address(usdx), amount);
        splitter.pullRevenue(address(usdx), 0);
        assertEq(splitter.reserveLiability(address(usdx)), amount / 3);
        assertEq(splitter.treasuryLiability(address(usdx)), amount - amount / 3);
        _assertConserved(address(usdx));
    }

    // ── G: multiple sweeps, no double count ─────────────────────────────

    function test_G_multiple_sweeps_never_double_count() public {
        _sweepNative(1 ether); // ceiling 0.3
        ForgeProtocolRevenueSplitter.EligibleRevenue memory first = _auth(NATIVE, 0.3 ether);
        bytes memory firstSig = _sign(splitter, attestorKey, first);
        splitter.authorizeEligibleRevenue(first, firstSig); // same cumulative: no new headroom
        assertEq(splitter.verifiedHeadroom(NATIVE), 0.3 ether, "cumulative, not additive");
        _sweepNative(1 ether); // ceiling 0.6
        assertEq(splitter.pullRevenue(NATIVE, 0), 0.6 ether);
        // Re-submitting an older authorization can never re-open headroom.
        vm.expectRevert(ForgeProtocolRevenueSplitter.StaleNonce.selector);
        splitter.authorizeEligibleRevenue(first, firstSig);
        vm.expectRevert(ForgeProtocolRevenueSplitter.NothingReceived.selector);
        splitter.pullRevenue(NATIVE, 0);
        assertEq(splitter.ledger(NATIVE).escrowClaimed, 0.6 ether);
        _assertConserved(NATIVE);
    }

    // ── H: reorganised / stale evidence refused ─────────────────────────

    function test_H_reorged_or_stale_evidence_refused() public {
        _thirdPartyNative(1 ether);
        // Evidence hash from a block that was reorganised out.
        ForgeProtocolRevenueSplitter.EligibleRevenue memory a = _auth(NATIVE, 1 ether);
        a.evidenceBlockHash = keccak256("orphaned block");
        bytes memory sig = _sign(splitter, attestorKey, a);
        vm.expectRevert(ForgeProtocolRevenueSplitter.StaleEvidence.selector);
        splitter.authorizeEligibleRevenue(a, sig);

        // Evidence older than the 256-block blockhash window.
        a = _auth(NATIVE, 1 ether);
        sig = _sign(splitter, attestorKey, a);
        vm.roll(vm.getBlockNumber() + 300);
        vm.expectRevert(ForgeProtocolRevenueSplitter.StaleEvidence.selector);
        splitter.authorizeEligibleRevenue(a, sig);

        // Evidence from the current (unfinalised) block.
        a = _auth(NATIVE, 1 ether);
        a.evidenceBlock = uint64(vm.getBlockNumber());
        sig = _sign(splitter, attestorKey, a);
        vm.expectRevert(ForgeProtocolRevenueSplitter.StaleEvidence.selector);
        splitter.authorizeEligibleRevenue(a, sig);

        // Zero hash is never accepted.
        a = _auth(NATIVE, 1 ether);
        a.evidenceBlockHash = bytes32(0);
        sig = _sign(splitter, attestorKey, a);
        vm.expectRevert(ForgeProtocolRevenueSplitter.StaleEvidence.selector);
        splitter.authorizeEligibleRevenue(a, sig);
        assertEq(splitter.verifiedHeadroom(NATIVE), 0);
    }

    // ── H2: Arbitrum-family chains read L2 block numbers/hashes via ArbSys ─

    function _etchArbSys() internal {
        vm.etch(address(0x64), address(new MockArbSys()).code);
    }

    function test_H2_arbsys_chain_accepts_l2_numbered_evidence() public {
        _thirdPartyNative(1 ether);
        _etchArbSys();
        ForgeProtocolRevenueSplitter.EligibleRevenue memory a = _auth(NATIVE, 1 ether);
        a.evidenceBlock = uint64(vm.getBlockNumber() + 1_000_000 - 1);
        a.evidenceBlockHash = keccak256(abi.encode("l2", uint256(a.evidenceBlock)));
        splitter.authorizeEligibleRevenue(a, _sign(splitter, attestorKey, a));
        assertEq(splitter.verifiedHeadroom(NATIVE), 1 ether);
    }

    function test_H2_arbsys_chain_refuses_l1_numbered_evidence_and_bad_windows() public {
        _thirdPartyNative(1 ether);
        // Evidence prepared with Ethereum semantics (the pre-fix behaviour) is refused on an ArbSys chain.
        ForgeProtocolRevenueSplitter.EligibleRevenue memory l1 = _auth(NATIVE, 1 ether);
        _etchArbSys();
        bytes memory sig = _sign(splitter, attestorKey, l1);
        vm.expectRevert(ForgeProtocolRevenueSplitter.StaleEvidence.selector);
        splitter.authorizeEligibleRevenue(l1, sig);

        ForgeProtocolRevenueSplitter.EligibleRevenue memory a = _auth(NATIVE, 1 ether);
        uint64 head = uint64(vm.getBlockNumber() + 1_000_000);
        // current / future block
        a.evidenceBlock = head;
        a.evidenceBlockHash = keccak256(abi.encode("l2", uint256(head)));
        sig = _sign(splitter, attestorKey, a);
        vm.expectRevert(ForgeProtocolRevenueSplitter.StaleEvidence.selector);
        splitter.authorizeEligibleRevenue(a, sig);
        // older than the 256-block window
        a.evidenceBlock = head - 300;
        a.evidenceBlockHash = keccak256(abi.encode("l2", uint256(head - 300)));
        sig = _sign(splitter, attestorKey, a);
        vm.expectRevert(ForgeProtocolRevenueSplitter.StaleEvidence.selector);
        splitter.authorizeEligibleRevenue(a, sig);
        // wrong hash for an in-window block
        a.evidenceBlock = head - 1;
        a.evidenceBlockHash = keccak256("not the l2 hash");
        sig = _sign(splitter, attestorKey, a);
        vm.expectRevert(ForgeProtocolRevenueSplitter.StaleEvidence.selector);
        splitter.authorizeEligibleRevenue(a, sig);
        assertEq(splitter.verifiedHeadroom(NATIVE), 0);
    }

    // ── I: expired, replayed and decreasing authorizations refused ──────

    function test_I_expired_replayed_decreasing_refused() public {
        _sweepNative(1 ether);
        ForgeProtocolRevenueSplitter.EligibleRevenue memory a = _auth(NATIVE, 0.5 ether);
        a.deadline = uint64(vm.getBlockTimestamp() - 1);
        bytes memory sig = _sign(splitter, attestorKey, a);
        vm.expectRevert(ForgeProtocolRevenueSplitter.AttestationExpired.selector);
        splitter.authorizeEligibleRevenue(a, sig);

        a = _auth(NATIVE, 0.2 ether); // lower than the 0.3 ceiling
        sig = _sign(splitter, attestorKey, a);
        vm.expectRevert(ForgeProtocolRevenueSplitter.CeilingDecrease.selector);
        splitter.authorizeEligibleRevenue(a, sig);

        a = _auth(NATIVE, 0.3 ether);
        a.nonce = 1; // already used by the first attestation
        sig = _sign(splitter, attestorKey, a);
        vm.expectRevert(ForgeProtocolRevenueSplitter.StaleNonce.selector);
        splitter.authorizeEligibleRevenue(a, sig);

        // A valid signature over different fields is not reusable.
        a = _auth(NATIVE, 0.3 ether);
        sig = _sign(splitter, attestorKey, a);
        a.deadline += 1; // any field change invalidates the signature
        vm.expectRevert(ForgeProtocolRevenueSplitter.InvalidAttestation.selector);
        splitter.authorizeEligibleRevenue(a, sig);
    }

    // ── J: assets, factories, escrows, chains and splitters isolated ────

    function test_J_bindings_isolated() public {
        _sweepToken(1_000e6);
        assertEq(splitter.verifiedHeadroom(NATIVE), 0, "token attestation never raises ETH");
        _thirdPartyNative(1 ether);
        vm.expectRevert(ForgeProtocolRevenueSplitter.NothingReceived.selector);
        splitter.pullRevenue(NATIVE, 0);

        ForgeProtocolRevenueSplitter.EligibleRevenue memory a = _auth(NATIVE, 1 ether);
        a.factory = attacker;
        bytes memory sig = _sign(splitter, attestorKey, a);
        vm.expectRevert(ForgeProtocolRevenueSplitter.WrongFactory.selector);
        splitter.authorizeEligibleRevenue(a, sig);

        a = _auth(NATIVE, 1 ether);
        a.escrow = address(new PonsV2FeeEscrow());
        sig = _sign(splitter, attestorKey, a);
        vm.expectRevert(ForgeProtocolRevenueSplitter.WrongEscrow.selector);
        splitter.authorizeEligibleRevenue(a, sig);

        ForgeTestToken other = new ForgeTestToken("Other", "OTH");
        a = _auth(address(other), 1 ether);
        sig = _sign(splitter, attestorKey, a);
        vm.expectRevert(
            abi.encodeWithSelector(
                ForgeProtocolRevenueSplitter.AssetNotApproved.selector, address(other)
            )
        );
        splitter.authorizeEligibleRevenue(a, sig);

        // Signed for another chain id: the EIP-712 domain differs.
        a = _auth(NATIVE, 1 ether);
        uint256 home = homeChainId;
        vm.chainId(home + 1);
        sig = _sign(splitter, attestorKey, a);
        vm.chainId(home);
        vm.expectRevert(ForgeProtocolRevenueSplitter.InvalidAttestation.selector);
        splitter.authorizeEligibleRevenue(a, sig);

        // Signed for another splitter (verifyingContract differs).
        ForgeProtocolRevenueSplitter twin =
            new ForgeProtocolRevenueSplitter(escrow, governance, treasury, attestor);
        a = _auth(NATIVE, 1 ether);
        sig = _sign(twin, attestorKey, a);
        vm.expectRevert(ForgeProtocolRevenueSplitter.InvalidAttestation.selector);
        splitter.authorizeEligibleRevenue(a, sig);
        assertEq(splitter.verifiedHeadroom(NATIVE), 0);
    }

    function test_mixed_assets_isolated() public {
        _sweepNative(3 ether);
        _sweepToken(9_000e6);
        splitter.pullRevenue(NATIVE, 0);
        splitter.pullRevenue(address(usdx), 0);
        assertEq(splitter.treasuryLiability(NATIVE), 0.6 ether);
        assertEq(splitter.treasuryLiability(address(usdx)), 1_800e6);
        vm.prank(treasury);
        vm.expectRevert(
            abi.encodeWithSelector(
                ForgeProtocolRevenueSplitter.InsufficientLiability.selector, 1 ether, 0.6 ether
            )
        );
        splitter.claimTreasury(NATIVE, 1 ether);
        _assertConserved(NATIVE);
        _assertConserved(address(usdx));
    }

    // ── K: unauthorised signer, revocation, role separation ─────────────

    function test_K_unauthorized_signer_refused() public {
        _thirdPartyNative(1 ether);
        (, uint256 attackerKey) = makeAddrAndKey("attacker-signer");
        ForgeProtocolRevenueSplitter.EligibleRevenue memory a = _auth(NATIVE, 1 ether);
        bytes memory sig = _sign(splitter, attackerKey, a);
        vm.expectRevert(ForgeProtocolRevenueSplitter.InvalidAttestation.selector);
        splitter.authorizeEligibleRevenue(a, sig);

        // Revocation is immediate and fails closed.
        vm.prank(attacker);
        vm.expectRevert();
        splitter.revokeRevenueAttestor();
        vm.prank(governance);
        splitter.revokeRevenueAttestor();
        a = _auth(NATIVE, 1 ether);
        sig = _sign(splitter, attestorKey, a);
        vm.expectRevert(ForgeProtocolRevenueSplitter.AttestorNotSet.selector);
        splitter.authorizeEligibleRevenue(a, sig);
    }

    function test_K_attestor_roles_separated_and_rotation_timelocked() public {
        vm.expectRevert(ForgeProtocolRevenueSplitter.RolesNotSeparated.selector);
        new ForgeProtocolRevenueSplitter(escrow, governance, treasury, treasury);
        vm.expectRevert(ForgeProtocolRevenueSplitter.RolesNotSeparated.selector);
        new ForgeProtocolRevenueSplitter(escrow, governance, treasury, governance);

        vm.startPrank(governance);
        vm.expectRevert(ForgeProtocolRevenueSplitter.RolesNotSeparated.selector);
        splitter.proposeRevenueAttestor(treasury);
        vm.expectRevert(ForgeProtocolRevenueSplitter.RolesNotSeparated.selector);
        splitter.proposeTreasuryRecipient(attestor);
        (address next, uint256 nextKey) = makeAddrAndKey("attestor-2");
        splitter.proposeRevenueAttestor(next);
        vm.stopPrank();
        vm.expectRevert();
        splitter.executeRevenueAttestorChange();
        vm.warp(vm.getBlockTimestamp() + 3 days);
        splitter.executeRevenueAttestorChange();
        assertEq(splitter.revenueAttestor(), next);

        // The old key no longer authorises; the new one does.
        _thirdPartyNative(1 ether);
        ForgeProtocolRevenueSplitter.EligibleRevenue memory a = _auth(NATIVE, 1 ether);
        bytes memory oldSig = _sign(splitter, attestorKey, a);
        vm.expectRevert(ForgeProtocolRevenueSplitter.InvalidAttestation.selector);
        splitter.authorizeEligibleRevenue(a, oldSig);
        splitter.authorizeEligibleRevenue(a, _sign(splitter, nextKey, a));
        assertEq(splitter.verifiedHeadroom(NATIVE), 1 ether);
    }

    // ── L: a failed escrow claim leaves no state behind ─────────────────

    function test_L_failed_escrow_claim_no_mutation() public {
        // W05: an over-attested ceiling (above escrow claimed + held) is
        // refused at authorization time.
        vm.deal(address(this), 1 ether);
        source.creditNative{value: 1 ether}(escrow, address(splitter));
        ForgeProtocolRevenueSplitter.EligibleRevenue memory a = _auth(NATIVE, 3 ether);
        bytes memory sig = _sign(splitter, attestorKey, a);
        vm.expectRevert(
            abi.encodeWithSelector(
                ForgeProtocolRevenueSplitter.CeilingExceedsEscrow.selector, 3 ether, 1 ether
            )
        );
        splitter.authorizeEligibleRevenue(a, sig);

        // A failing escrow claim reverts the whole pull: no state is kept.
        _attest(NATIVE, 1 ether);
        ForgeProtocolRevenueSplitter.AssetLedger memory before = splitter.ledger(NATIVE);
        vm.mockCallRevert(
            address(escrow),
            abi.encodeWithSignature("claim(uint256)", 0.5 ether),
            abi.encodeWithSelector(PonsV2FeeEscrow.TransferFailed.selector)
        );
        vm.expectRevert(PonsV2FeeEscrow.TransferFailed.selector);
        splitter.pullRevenue(NATIVE, 0.5 ether);
        vm.clearMockedCalls();
        ForgeProtocolRevenueSplitter.AssetLedger memory afterL = splitter.ledger(NATIVE);
        assertEq(afterL.escrowClaimed, before.escrowClaimed);
        assertEq(afterL.revenueReceived, before.revenueReceived);
        assertEq(splitter.allocationCount(), 0);
        assertEq(splitter.pullRevenue(NATIVE, 0), 1 ether);
        assertEq(splitter.verifiedHeadroom(NATIVE), 0);
        _assertConserved(NATIVE);
    }

    // ── M: creator share and creator tax untouched ──────────────────────

    function test_M_creator_share_and_tax_untouched() public {
        _sweepNative(10 ether);
        // Creator tax travels in the creator's own credit, never to the splitter.
        vm.deal(address(this), 0.5 ether);
        source.creditNative{value: 0.5 ether}(escrow, creator);
        _thirdPartyNative(1 ether);
        splitter.pullRevenue(NATIVE, 0);
        assertEq(escrow.balanceOf(creator), 7.5 ether, "70% base + tax intact");
        vm.expectRevert(ForgeProtocolRevenueSplitter.NothingReceived.selector);
        splitter.pullRevenue(NATIVE, 0);
        uint256 before = creator.balance;
        vm.prank(creator);
        escrow.claim();
        assertEq(creator.balance - before, 7.5 ether);
    }

    // ── 8/9/10: partial, repeated, unauthorized treasury claims ─────────

    function test_partial_repeated_and_unauthorized_claims() public {
        _sweepNative(10 ether);
        splitter.pullRevenue(NATIVE, 0);

        vm.prank(attacker);
        vm.expectRevert(ForgeProtocolRevenueSplitter.NotTreasuryRecipient.selector);
        splitter.claimTreasury(NATIVE, 0);
        vm.prank(governance);
        vm.expectRevert(ForgeProtocolRevenueSplitter.NotTreasuryRecipient.selector);
        splitter.claimTreasury(NATIVE, 0);
        vm.prank(attestor);
        vm.expectRevert(ForgeProtocolRevenueSplitter.NotTreasuryRecipient.selector);
        splitter.claimTreasury(NATIVE, 0);

        vm.startPrank(treasury);
        splitter.claimTreasury(NATIVE, 0.5 ether);
        splitter.claimTreasury(NATIVE, 1.5 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                ForgeProtocolRevenueSplitter.InsufficientLiability.selector, 0, 0
            )
        );
        splitter.claimTreasury(NATIVE, 0);
        vm.stopPrank();
        assertEq(treasury.balance, 2 ether);
        assertEq(splitter.reserveLiability(NATIVE), 1 ether, "reserve never paid");
        _assertConserved(NATIVE);
    }

    // ── 11/13: donations and rescue transfers are non-revenue ───────────

    function test_direct_eth_and_token_transfers_are_non_revenue() public {
        vm.deal(attacker, 5 ether);
        vm.prank(attacker);
        (bool ok,) = address(splitter).call{value: 5 ether}("");
        assertTrue(ok);
        assertEq(splitter.nonRevenueHeld(NATIVE), 5 ether);
        assertEq(splitter.treasuryLiability(NATIVE), 0);
        assertEq(splitter.reserveLiability(NATIVE), 0);

        usdx.mint(address(splitter), 1_000e6);
        (,, uint256 surplus,) = splitter.reconcile(address(usdx));
        assertEq(surplus, 1_000e6);
        splitter.recordUnattributed(address(usdx));
        assertEq(splitter.nonRevenueHeld(address(usdx)), 1_000e6);
        assertEq(splitter.treasuryLiability(address(usdx)), 0);
        vm.expectRevert(ForgeProtocolRevenueSplitter.NothingToRecord.selector);
        splitter.recordUnattributed(address(usdx));

        vm.prank(attacker);
        vm.expectRevert();
        splitter.releaseNonRevenue(NATIVE, 1 ether);
        vm.prank(governance);
        splitter.releaseNonRevenue(NATIVE, 5 ether);
        assertEq(treasury.balance, 5 ether);
        _assertConserved(NATIVE);
        _assertConserved(address(usdx));
    }

    function test_launch_fee_classified_separately() public {
        vm.deal(address(this), 0.1 ether);
        vm.expectEmit(true, true, false, true, address(splitter));
        emit ForgeProtocolRevenueSplitter.NonRevenueReceived(
            NATIVE,
            address(factory),
            0.1 ether,
            ForgeProtocolRevenueSplitter.NonRevenueClass.LaunchFee
        );
        factory.payLaunchFee{value: 0.1 ether}(address(splitter));
        assertEq(splitter.ledger(NATIVE).revenueReceived, 0, "launch fee never enters 70/20/10");
        vm.prank(governance);
        vm.expectRevert(ForgeProtocolRevenueSplitter.FactoryAlreadySet.selector);
        splitter.setForgeFactory(attacker);
    }

    /// The escrow still emits the depositor of every credit; the off-chain
    /// attestor uses it (with the same-tx sweep event) to exclude this.
    function test_escrow_credit_by_third_party_emits_depositor() public {
        vm.deal(attacker, 1 ether);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit PonsV2FeeEscrow.Credited(address(splitter), attacker, 1 ether);
        vm.prank(attacker);
        escrow.credit{value: 1 ether}(address(splitter));
    }

    // ── 12: fee-on-transfer quote assets are measured, not trusted ──────

    function test_fee_on_transfer_measured_on_receipt() public {
        FeeOnTransferToken fot = new FeeOnTransferToken(100); // 1%
        factory.setQuote(address(fot), 1e18, 18, true);
        vm.prank(governance);
        splitter.setAssetApproved(address(fot), true);
        fot.mint(address(this), 1_000e18);
        fot.approve(address(escrow), type(uint256).max);
        escrow.creditToken(address(splitter), address(fot), 1_000e18); // escrow books 990
        _attest(address(fot), 990e18); // the attested CreditedToken amount
        uint256 got = splitter.pullRevenue(address(fot), 0); // receives 980.1
        assertEq(got, 980.1e18, "allocates what actually arrived");
        assertEq(splitter.ledger(address(fot)).escrowClaimed, 990e18, "ceiling in escrow units");
        assertEq(splitter.reserveLiability(address(fot)), uint256(980.1e18) / 3);
        _assertConserved(address(fot));
    }

    // ── P3: quote-asset authority derived from the Forge factory ────────

    function test_P3_native_eth_always_supported() public view {
        assertTrue(splitter.approvedAsset(NATIVE));
    }

    function test_P3_cannot_approve_eoa_or_native_as_token() public {
        vm.startPrank(governance);
        vm.expectRevert(
            abi.encodeWithSelector(ForgeProtocolRevenueSplitter.NotAContract.selector, attacker)
        );
        splitter.setAssetApproved(attacker, true);
        vm.expectRevert(ForgeProtocolRevenueSplitter.InvalidRecipient.selector);
        splitter.setAssetApproved(NATIVE, false);
        vm.stopPrank();
    }

    function test_P3_unsupported_quote_refused() public {
        ForgeTestToken other = new ForgeTestToken("Other", "OTH");
        vm.prank(governance);
        vm.expectRevert(
            abi.encodeWithSelector(
                ForgeProtocolRevenueSplitter.AssetNotForgeQuote.selector, address(other)
            )
        );
        splitter.setAssetApproved(address(other), true);
        // Economics configured but not approved by the factory: still refused.
        factory.setQuote(address(other), 1e18, 18, false);
        vm.prank(governance);
        vm.expectRevert(
            abi.encodeWithSelector(
                ForgeProtocolRevenueSplitter.AssetNotForgeQuote.selector, address(other)
            )
        );
        splitter.setAssetApproved(address(other), true);
        // Approved without economics: refused.
        factory.setQuote(address(other), 0, 18, true);
        vm.prank(governance);
        vm.expectRevert(
            abi.encodeWithSelector(
                ForgeProtocolRevenueSplitter.AssetNotForgeQuote.selector, address(other)
            )
        );
        splitter.setAssetApproved(address(other), true);
        // Decimals that contradict the factory's recorded scale: refused.
        factory.setQuote(address(other), 1e18, 6, true);
        vm.prank(governance);
        vm.expectRevert(
            abi.encodeWithSelector(
                ForgeProtocolRevenueSplitter.QuoteDecimalsMismatch.selector, address(other)
            )
        );
        splitter.setAssetApproved(address(other), true);
    }

    function test_P3_launch_token_refused() public {
        ForgeTestToken meme = new ForgeTestToken("Meme", "MEME");
        factory.setQuote(address(meme), 1e18, 18, true);
        factory.setLaunchToken(address(meme));
        vm.prank(governance);
        vm.expectRevert(
            abi.encodeWithSelector(
                ForgeProtocolRevenueSplitter.AssetIsLaunchToken.selector, address(meme)
            )
        );
        splitter.setAssetApproved(address(meme), true);
    }

    function test_P3_factory_not_wired_fails_closed() public {
        ForgeProtocolRevenueSplitter bare =
            new ForgeProtocolRevenueSplitter(escrow, governance, treasury, attestor);
        vm.prank(governance);
        vm.expectRevert(ForgeProtocolRevenueSplitter.FactoryNotWired.selector);
        bare.setAssetApproved(address(usdx), true);
        _thirdPartyNative(1 ether);
        ForgeProtocolRevenueSplitter.EligibleRevenue memory a =
            _authFor(bare, address(factory), NATIVE, 1 ether, 1);
        bytes memory sig = _sign(bare, attestorKey, a);
        vm.expectRevert(ForgeProtocolRevenueSplitter.FactoryNotWired.selector);
        bare.authorizeEligibleRevenue(a, sig);
    }

    function test_P3_disabled_quote_keeps_historic_liabilities_claimable() public {
        _sweepToken(3_000e6);
        splitter.pullRevenue(address(usdx), 0);
        // The factory de-lists the quote for NEW launches: the splitter's
        // approval (and the verified headroom of existing launches) remains.
        factory.setQuote(address(usdx), 1e18, 18, false);
        _sweepToken(3_000e6);
        splitter.pullRevenue(address(usdx), 0);
        // Governance revokes the asset: pulls stop, claims continue.
        vm.prank(governance);
        splitter.setAssetApproved(address(usdx), false);
        _sweepTokenNoAttest(3_000e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                ForgeProtocolRevenueSplitter.AssetNotApproved.selector, address(usdx)
            )
        );
        splitter.pullRevenue(address(usdx), 0);
        vm.prank(treasury);
        splitter.claimTreasury(address(usdx), 0);
        assertEq(usdx.balanceOf(treasury), 1_200e6);
        assertEq(splitter.reserveLiability(address(usdx)), 600e6, "reserve kept");
        // Re-approval is refused while the factory no longer lists it.
        vm.prank(governance);
        vm.expectRevert(
            abi.encodeWithSelector(
                ForgeProtocolRevenueSplitter.AssetNotForgeQuote.selector, address(usdx)
            )
        );
        splitter.setAssetApproved(address(usdx), true);
        _assertConserved(address(usdx));
    }

    function _sweepTokenNoAttest(uint256 baseFee) internal {
        uint256 protocol = (baseFee * 3_000) / 10_000;
        usdx.mint(address(source), baseFee);
        source.creditToken(escrow, address(splitter), address(usdx), protocol);
        source.creditToken(escrow, creator, address(usdx), baseFee - protocol);
    }

    function test_unapproved_asset_fails_closed() public {
        ForgeTestToken other = new ForgeTestToken("Other", "OTH");
        other.mint(address(source), 100);
        source.creditToken(escrow, address(splitter), address(other), 100);
        vm.expectRevert(
            abi.encodeWithSelector(
                ForgeProtocolRevenueSplitter.AssetNotApproved.selector, address(other)
            )
        );
        splitter.pullRevenue(address(other), 0);
    }

    // ── 15/28: governance, recipient substitution, timelock ─────────────

    function test_treasury_recipient_rotation_timelocked() public {
        address newTreasury = makeAddr("newTreasury");
        vm.prank(attacker);
        vm.expectRevert();
        splitter.proposeTreasuryRecipient(attacker);

        vm.prank(governance);
        splitter.proposeTreasuryRecipient(newTreasury);
        vm.expectRevert();
        splitter.executeTreasuryRecipientChange();

        vm.warp(vm.getBlockTimestamp() + 3 days);
        splitter.executeTreasuryRecipientChange();
        assertEq(splitter.treasuryRecipient(), newTreasury);
    }

    function test_recipient_proposal_expires_and_cancels() public {
        vm.startPrank(governance);
        splitter.proposeTreasuryRecipient(attacker);
        splitter.cancelTreasuryRecipientChange();
        vm.expectRevert(ForgeProtocolRevenueSplitter.NoPendingChange.selector);
        splitter.cancelTreasuryRecipientChange();
        splitter.proposeTreasuryRecipient(attacker);
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 6 days + 1);
        vm.expectRevert();
        splitter.executeTreasuryRecipientChange();
        assertEq(splitter.treasuryRecipient(), treasury);
    }

    function test_invalid_recipient_and_renounce_refused() public {
        vm.startPrank(governance);
        vm.expectRevert(ForgeProtocolRevenueSplitter.InvalidRecipient.selector);
        splitter.proposeTreasuryRecipient(address(splitter));
        vm.expectRevert(ForgeProtocolRevenueSplitter.InvalidRecipient.selector);
        splitter.proposeTreasuryRecipient(address(escrow));
        vm.expectRevert(ForgeProtocolRevenueSplitter.OwnershipCannotBeRenounced.selector);
        splitter.renounceOwnership();
        vm.stopPrank();
    }

    function test_pause_blocks_pulls_never_claims() public {
        _sweepNative(3 ether);
        splitter.pullRevenue(NATIVE, 0.5 ether);
        vm.prank(governance);
        splitter.setPullsPaused(true);
        vm.expectRevert(ForgeProtocolRevenueSplitter.PullsPaused.selector);
        splitter.pullRevenue(NATIVE, 0);
        vm.prank(treasury);
        splitter.claimTreasury(NATIVE, 0);
        assertGt(treasury.balance, 0);
        assertGt(escrow.balanceOf(address(splitter)), 0, "unpulled funds stay in escrow");
    }

    // ── 26: the reserve cannot be swapped, burned or withdrawn ──────────

    function test_reserve_has_no_exit() public {
        _sweepNative(9 ether);
        splitter.pullRevenue(NATIVE, 0);
        assertFalse(splitter.FINCO_BURN_ENABLED());
        (bool enabled,) = splitter.burnReadiness();
        assertFalse(enabled);
        vm.prank(governance);
        vm.expectRevert(
            abi.encodeWithSelector(
                ForgeProtocolRevenueSplitter.InsufficientLiability.selector, 1, 0
            )
        );
        splitter.releaseNonRevenue(NATIVE, 1);
        vm.prank(treasury);
        vm.expectRevert(
            abi.encodeWithSelector(
                ForgeProtocolRevenueSplitter.InsufficientLiability.selector,
                2.7 ether + 1,
                1.8 ether
            )
        );
        splitter.claimTreasury(NATIVE, 2.7 ether + 1);
        assertEq(splitter.reserveLiability(NATIVE), 0.9 ether);
        assertEq(address(splitter).balance, 2.7 ether);
    }

    receive() external payable {}
}

/// @notice Invariant handler: verified fee credits, third-party credits,
/// donations, bounded pulls, claims, releases.
contract SplitterHandler is AttestationHelpers {
    PonsV2FeeEscrow internal escrow;
    ForgeProtocolRevenueSplitter internal splitter;
    ForgeTestToken internal usdx;
    address internal treasury;
    address internal governance;
    address internal factory;
    uint256 internal key;

    uint256 public ghostEthPulled;
    uint256 public ghostTokenPulled;
    uint256 public ghostEthEligible;
    uint256 public ghostTokenEligible;
    uint256 public ghostEthThirdParty;
    uint256 public ghostTokenThirdParty;
    uint64 internal ethNonce;
    uint64 internal tokenNonce;

    constructor(
        PonsV2FeeEscrow e,
        ForgeProtocolRevenueSplitter s,
        ForgeTestToken t,
        address tr,
        address gov,
        address fac,
        uint256 attestorKey
    ) {
        escrow = e;
        splitter = s;
        usdx = t;
        treasury = tr;
        governance = gov;
        factory = fac;
        key = attestorKey;
    }

    function _attestCumulative(address asset, uint256 cumulative, uint64 nonce) internal {
        ForgeProtocolRevenueSplitter.EligibleRevenue memory a =
            _authFor(splitter, factory, asset, cumulative, nonce);
        splitter.authorizeEligibleRevenue(a, _sign(splitter, key, a));
    }

    function creditEth(uint96 amt) external {
        amt = uint96(bound(amt, 1, 1_000 ether));
        vm.deal(address(this), amt);
        escrow.credit{value: amt}(address(splitter));
        ghostEthEligible += amt;
        _attestCumulative(address(0), ghostEthEligible, ++ethNonce);
    }

    function creditToken(uint96 amt) external {
        amt = uint96(bound(amt, 1, type(uint96).max));
        usdx.mint(address(this), amt);
        usdx.approve(address(escrow), amt);
        escrow.creditToken(address(splitter), address(usdx), amt);
        ghostTokenEligible += amt;
        _attestCumulative(address(usdx), ghostTokenEligible, ++tokenNonce);
    }

    function thirdPartyEth(uint96 amt) external {
        amt = uint96(bound(amt, 0, 1_000 ether));
        vm.deal(address(this), amt);
        escrow.credit{value: amt}(address(splitter));
        ghostEthThirdParty += amt;
    }

    function thirdPartyToken(uint96 amt) external {
        usdx.mint(address(this), amt);
        usdx.approve(address(escrow), amt);
        escrow.creditToken(address(splitter), address(usdx), amt);
        ghostTokenThirdParty += amt;
    }

    function donateEth(uint96 amt) external {
        amt = uint96(bound(amt, 0, 1_000 ether));
        vm.deal(address(this), amt);
        (bool ok,) = address(splitter).call{value: amt}("");
        require(ok);
    }

    function donateToken(uint96 amt) external {
        usdx.mint(address(splitter), amt);
    }

    function pull(bool token, uint256 frac) external {
        address asset = token ? address(usdx) : address(0);
        uint256 avail = splitter.verifiedHeadroom(asset);
        if (avail == 0) return;
        uint256 got = splitter.pullRevenue(asset, bound(frac, 1, avail));
        if (token) ghostTokenPulled += got;
        else ghostEthPulled += got;
    }

    /// An attempt to pull beyond the verified ceiling must always revert.
    function overPull(bool token) external {
        address asset = token ? address(usdx) : address(0);
        uint256 avail = splitter.verifiedHeadroom(asset);
        try splitter.pullRevenue(asset, avail + 1) {
            revert("over-pull succeeded");
        } catch {}
    }

    function claim(bool token, uint256 frac) external {
        address asset = token ? address(usdx) : address(0);
        uint256 avail = splitter.treasuryLiability(asset);
        if (avail == 0) return;
        vm.prank(treasury);
        splitter.claimTreasury(asset, bound(frac, 1, avail));
    }

    function record(bool token) external {
        address asset = token ? address(usdx) : address(0);
        (,, uint256 surplus,) = splitter.reconcile(asset);
        if (surplus != 0) splitter.recordUnattributed(asset);
    }

    function release(bool token, uint256 frac) external {
        address asset = token ? address(usdx) : address(0);
        uint256 held = splitter.nonRevenueHeld(asset);
        if (held == 0) return;
        vm.prank(governance);
        splitter.releaseNonRevenue(asset, bound(frac, 1, held));
    }

    receive() external payable {}
}

contract ForgeRevenueSplitterInvariantTest is StdInvariant, Test {
    PonsV2FeeEscrow internal escrow;
    ForgeProtocolRevenueSplitter internal splitter;
    ForgeTestToken internal usdx;
    SplitterHandler internal handler;
    MockQuotePolicyFactory internal factory;
    address internal treasury = makeAddr("treasury");
    address internal governance = makeAddr("governance");

    function setUp() public {
        vm.roll(1_000);
        (address attestor, uint256 attestorKey) = makeAddrAndKey("attestor");
        escrow = new PonsV2FeeEscrow();
        splitter = new ForgeProtocolRevenueSplitter(escrow, governance, treasury, attestor);
        usdx = new ForgeTestToken("USD X", "USDX");
        factory = new MockQuotePolicyFactory();
        factory.setQuote(address(usdx), 1e18, 18, true);
        vm.startPrank(governance);
        splitter.setForgeFactory(address(factory));
        splitter.setAssetApproved(address(usdx), true);
        vm.stopPrank();
        handler = new SplitterHandler(
            escrow, splitter, usdx, treasury, governance, address(factory), attestorKey
        );
        targetContract(address(handler));
    }

    function _check(address asset, uint256 pulled, uint256 verified, uint256 thirdParty)
        internal
        view
    {
        ForgeProtocolRevenueSplitter.AssetLedger memory l = splitter.ledger(asset);
        assertEq(l.revenueReceived, pulled, "revenue == measured pulls only");
        assertLe(l.revenueReceived, verified, "revenue never exceeds verified credits");
        assertLe(l.escrowClaimed, l.eligibleCeiling, "never above the ceiling");
        assertEq(l.treasuryAllocated + l.reserveAllocated, l.revenueReceived, "allocated once");
        assertEq(l.reserveAllocated, l.revenueReceived / 3, "reserve exact third (floor)");
        assertLe(l.treasuryPaid, l.treasuryAllocated, "no overclaim");
        assertLe(l.nonRevenueReleased, l.nonRevenueReceived, "no over-release");
        uint256 escrowed = asset == address(0)
            ? escrow.balanceOf(address(splitter))
            : escrow.balanceOfToken(address(splitter), asset);
        assertGe(escrowed, thirdParty, "third-party credits never leave the escrow");
        assertEq(escrowed, verified + thirdParty - l.escrowClaimed, "escrow conservation");
        (uint256 bal, uint256 accounted,, uint256 deficit) = splitter.reconcile(asset);
        assertEq(deficit, 0, "balances cover liabilities");
        assertGe(bal, accounted);
    }

    function invariant_native_conservation() public view {
        _check(
            address(0),
            handler.ghostEthPulled(),
            handler.ghostEthEligible(),
            handler.ghostEthThirdParty()
        );
    }

    function invariant_token_conservation() public view {
        _check(
            address(usdx),
            handler.ghostTokenPulled(),
            handler.ghostTokenEligible(),
            handler.ghostTokenThirdParty()
        );
    }

    function invariant_burn_disabled() public view {
        assertFalse(splitter.FINCO_BURN_ENABLED());
    }
}
