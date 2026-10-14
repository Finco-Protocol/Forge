// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IPonsV2FeeEscrow, IPonsV2LaunchFactory} from "../interfaces/ILaunchpadV2.sol";

/// @dev The Forge factory's own quote-asset policy (public storage getters).
interface IForgeQuotePolicy {
    function approvedPairTokens(address pairToken) external view returns (bool);
    function pairTokenEconomics(address pairToken)
        external
        view
        returns (uint256 phantomQuote, uint256 graduationThreshold, uint8 decimals);
}

/**
 * @title ForgeProtocolRevenueSplitter
 * @notice W04 sandbox: the Forge-owned recipient of the PROTOCOL leg of the
 * Forge launchpad's base trading fees. It sits behind the canonical
 * PonsV2FeeEscrow as the escrow key the Forge hook's `protocolFeeRecipient`
 * names, and divides only VERIFIED protocol revenue:
 *
 *   protocol leg (30% of an eligible base fee under the default snapshot)
 *     → 2/3 Forge treasury   (20 percentage points of the base fee)
 *     → 1/3 FINCO reserve    (10 percentage points of the base fee)
 *
 * The creator's 70% never passes through this contract; the escrow pays
 * `msg.sender` only, so this contract can never reach another recipient's
 * funds.
 *
 * ── Revenue provenance (W04 Correction A) ───────────────────────────────
 * The canonical escrow's `credit`/`creditToken` are permissionless: anyone
 * can credit this contract's escrow key, and the escrow keeps no record of
 * WHO credited WHAT on chain. A balance-based pull would therefore allocate
 * third-party credits as protocol revenue. Instead, every asset carries a
 * cumulative ELIGIBLE-REVENUE CEILING, and `pullRevenue` may only claim from
 * the escrow while
 *
 *     escrowClaimed(asset) + amount <= eligibleCeiling(asset)
 *
 * Third-party credits therefore stay in the escrow and can never enter the
 * 70/20/10 allocation. The ceiling is raised only by an EIP-712
 * `EligibleRevenue` authorization signed by the `revenueAttestor`, bound to
 * this chain and this splitter (domain), the canonical escrow, the wired
 * Forge factory, the asset, a CUMULATIVE amount, a strictly increasing
 * per-asset nonce, a deadline, and an evidence block whose hash is checked
 * on chain (`blockhash`), so evidence from a reorganised-out block is refused.
 *
 * TRUST BOUNDARY (explicit, not trustless): the attestor attests the
 * cumulative protocol-leg escrow credits made by Forge curves and the Forge
 * hook, recomputed from finalised canonical events. A faulty attestor can at
 * worst authorise pulling third-party credits already sitting under this
 * key AT SIGNING TIME (W05: the ceiling is capped on chain at escrow claimed
 * + escrow held, and nonces are strictly sequential); it can never mint,
 * never reach creator funds, never withdraw, and is bounded by the escrow
 * balance. The attestor is separate from the owner and
 * the treasury recipient, its rotation is timelocked, and the owner can
 * revoke it instantly (fail closed). Production signing stays disabled until
 * W05 key-custody approval.
 *
 * Accounting boundaries (per asset, `address(0)` = native ETH):
 *   REVENUE      — measured receipt of a ceiling-bounded escrow claim.
 *   NON-REVENUE  — launch fee, rescues, direct transfers: held, never allocated.
 *   balance >= treasuryLiability + reserveLiability + nonRevenueHeld
 *
 * Rounding: reserve = floor(lifetime revenue / 3) per asset; treasury takes
 * the remainder (no per-pull drift; reserve never exceeds an exact third).
 *
 * FINCO reserve: a liability only — no withdrawal, swap or burn entry point;
 * `FINCO_BURN_ENABLED` is a compile-time `false`. Sandbox only:
 * PRODUCTION_BLOCKED.
 */
contract ForgeProtocolRevenueSplitter is EIP712, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    enum NonRevenueClass {
        LaunchFee,
        UnattributedNative,
        UnattributedToken
    }

    struct AssetLedger {
        uint256 revenueReceived; // measured receipts of verified pulls
        uint256 treasuryAllocated;
        uint256 reserveAllocated;
        uint256 treasuryPaid;
        uint256 nonRevenueReceived;
        uint256 nonRevenueReleased;
        uint256 eligibleCeiling; // cumulative verified eligible escrow credits
        uint256 escrowClaimed; // cumulative escrow debits made by verified pulls
        uint64 authNonce; // last accepted authorization nonce
    }

    /// @notice A cumulative eligible-revenue authorization (EIP-712).
    struct EligibleRevenue {
        address escrow;
        address factory;
        address asset;
        uint256 cumulativeEligible;
        uint64 nonce;
        uint64 deadline;
        uint64 evidenceBlock;
        bytes32 evidenceBlockHash;
    }

    struct PendingRecipient {
        address newRecipient;
        uint64 effectiveAt;
        uint64 expiresAt;
    }

    error ZeroAddress();
    error InvalidRecipient();
    error FactoryAlreadySet();
    error FactoryNotWired();
    error AssetNotApproved(address asset);
    error AssetIsLaunchToken(address asset);
    error AssetNotForgeQuote(address asset);
    error QuoteDecimalsMismatch(address asset);
    error NotAContract(address asset);
    error PullsPaused();
    error NothingReceived();
    error ExceedsVerifiedRevenue(uint256 requested, uint256 verifiedHeadroom);
    error NotTreasuryRecipient();
    error InsufficientLiability(uint256 requested, uint256 available);
    error NoPendingChange();
    error TimelockNotElapsed(uint256 effectiveAt);
    error TimelockExpired(uint256 expiresAt);
    error NothingToRecord();
    error OwnershipCannotBeRenounced();
    error TransferFailed();
    error AttestorNotSet();
    error InvalidAttestation();
    error AttestationExpired();
    error StaleNonce();
    error CeilingDecrease();
    error WrongEscrow();
    error WrongFactory();
    error StaleEvidence();
    error RolesNotSeparated();
    error CeilingExceedsEscrow(uint256 cumulativeEligible, uint256 escrowClaimedPlusHeld);

    event ForgeFactorySet(address indexed factory);
    event AssetApprovalUpdated(address indexed asset, bool approved);
    event PullsPausedUpdated(bool paused);
    event EligibleRevenueAuthorized(
        address indexed asset,
        uint256 cumulativeEligible,
        uint64 nonce,
        uint64 evidenceBlock,
        bytes32 evidenceBlockHash,
        address indexed attestor
    );
    event RevenueAllocated(
        uint256 indexed allocationId,
        address indexed asset,
        uint256 escrowClaimed,
        uint256 received,
        uint256 toTreasury,
        uint256 toReserve,
        uint16 policyVersion
    );
    event NonRevenueReceived(
        address indexed asset, address indexed from, uint256 amount, NonRevenueClass cls
    );
    event NonRevenueReleased(address indexed asset, address indexed recipient, uint256 amount);
    event TreasuryClaimed(address indexed asset, address indexed recipient, uint256 amount);
    event TreasuryRecipientChangeProposed(
        address indexed current, address indexed proposed, uint256 effectiveAt, uint256 expiresAt
    );
    event TreasuryRecipientChangeCancelled(address indexed proposed);
    event TreasuryRecipientUpdated(address indexed previous, address indexed current);
    event RevenueAttestorChangeProposed(
        address indexed current, address indexed proposed, uint256 effectiveAt, uint256 expiresAt
    );
    event RevenueAttestorChangeCancelled(address indexed proposed);
    event RevenueAttestorUpdated(address indexed previous, address indexed current);

    /// @notice Native ETH ledger key.
    address public constant NATIVE = address(0);
    /// @notice Version of the allocation policy encoded in this contract.
    uint16 public constant POLICY_VERSION = 1;
    /// @notice Treasury : reserve = 2 : 1 of the protocol leg.
    uint256 public constant TREASURY_PARTS = 2;
    uint256 public constant RESERVE_PARTS = 1;
    uint256 public constant TOTAL_PARTS = 3;
    /// @notice The FINCO reserve can never be swapped or burned by this contract.
    bool public constant FINCO_BURN_ENABLED = false;
    /// @notice Notice period before a role change can execute.
    uint256 public constant RECIPIENT_TIMELOCK = 3 days;
    /// @notice A matured role change must execute inside this window.
    uint256 public constant RECIPIENT_EXECUTION_WINDOW = 3 days;
    /// @notice Evidence must be one of the last 256 blocks (on-chain blockhash).
    uint256 public constant MAX_EVIDENCE_AGE_BLOCKS = 256;

    bytes32 public constant ELIGIBLE_REVENUE_TYPEHASH = keccak256(
        "EligibleRevenue(address escrow,address factory,address asset,uint256 cumulativeEligible,uint64 nonce,uint64 deadline,uint64 evidenceBlock,bytes32 evidenceBlockHash)"
    );

    /// @notice The canonical escrow this splitter claims its own key from.
    IPonsV2FeeEscrow public immutable feeEscrow;

    /// @notice The Forge factory (one-time wiring): launch-fee classification
    /// and the source of the quote-asset policy.
    address public forgeFactory;

    address public treasuryRecipient;
    PendingRecipient public pendingTreasuryRecipient;

    /// @notice Signs cumulative eligible-revenue ceilings (address(0) = none).
    address public revenueAttestor;
    PendingRecipient public pendingRevenueAttestor;

    bool public pullsPaused;
    uint256 public allocationCount;

    mapping(address asset => bool approved) public approvedAsset;
    mapping(address asset => AssetLedger ledger) private _ledgers;

    // Set only while `pullRevenue` awaits the escrow's native payment.
    bool private _pullingNative;

    constructor(
        IPonsV2FeeEscrow feeEscrow_,
        address owner_,
        address treasuryRecipient_,
        address revenueAttestor_
    ) EIP712("FINCO Forge Revenue Splitter", "1") Ownable(owner_) {
        if (address(feeEscrow_) == address(0) || treasuryRecipient_ == address(0)) {
            revert ZeroAddress();
        }
        if (treasuryRecipient_ == address(this)) revert InvalidRecipient();
        feeEscrow = feeEscrow_;
        treasuryRecipient = treasuryRecipient_;
        approvedAsset[NATIVE] = true;
        emit AssetApprovalUpdated(NATIVE, true);
        emit TreasuryRecipientUpdated(address(0), treasuryRecipient_);
        if (revenueAttestor_ != address(0)) {
            _requireSeparated(revenueAttestor_, treasuryRecipient_);
            revenueAttestor = revenueAttestor_;
            emit RevenueAttestorUpdated(address(0), revenueAttestor_);
        }
    }

    // ── Inflows ──────────────────────────────────────────────────────────

    /**
     * @notice Every native inflow except the escrow payment a pull awaits is
     * NON-REVENUE (launch fee, curve rescue, third-party transfer). Accepted
     * (refusing would brick launches) but never allocated.
     */
    receive() external payable {
        if (_pullingNative && msg.sender == address(feeEscrow)) return;
        NonRevenueClass cls = msg.sender == forgeFactory && forgeFactory != address(0)
            ? NonRevenueClass.LaunchFee
            : NonRevenueClass.UnattributedNative;
        _ledgers[NATIVE].nonRevenueReceived += msg.value;
        emit NonRevenueReceived(NATIVE, msg.sender, msg.value, cls);
    }

    /**
     * @notice Raises `asset`'s cumulative eligible-revenue ceiling with an
     * attestor-signed authorization. Permissionless relay: the signature is
     * the authority. Fails closed on a wrong escrow/factory/asset binding, an
     * expired deadline, a replayed or out-of-order nonce, a decreasing
     * ceiling, or evidence whose block hash is not canonical on this chain.
     */
    function authorizeEligibleRevenue(EligibleRevenue calldata auth, bytes calldata signature)
        external
    {
        address attestor = revenueAttestor;
        if (attestor == address(0)) revert AttestorNotSet();
        if (auth.escrow != address(feeEscrow)) revert WrongEscrow();
        if (forgeFactory == address(0)) revert FactoryNotWired();
        if (auth.factory != forgeFactory) revert WrongFactory();
        if (!approvedAsset[auth.asset]) revert AssetNotApproved(auth.asset);
        if (auth.deadline < block.timestamp) revert AttestationExpired();
        if (
            auth.evidenceBlock >= block.number
                || block.number - auth.evidenceBlock > MAX_EVIDENCE_AGE_BLOCKS
                || auth.evidenceBlockHash == bytes32(0)
                || blockhash(auth.evidenceBlock) != auth.evidenceBlockHash
        ) {
            revert StaleEvidence();
        }
        AssetLedger storage l = _ledgers[auth.asset];
        // W05: strictly sequential nonces, so a compromised attestor cannot
        // exhaust the nonce space and lock out every future attestor.
        if (auth.nonce != l.authNonce + 1) revert StaleNonce();
        if (auth.cumulativeEligible < l.eligibleCeiling) revert CeilingDecrease();
        // W05: a ceiling can never exceed what the escrow has actually paid
        // this key plus what it still holds for it, so an overstating
        // attestor cannot pre-authorise FUTURE third-party credits.
        uint256 held = auth.asset == NATIVE
            ? feeEscrow.balanceOf(address(this))
            : feeEscrow.balanceOfToken(address(this), auth.asset);
        if (auth.cumulativeEligible > l.escrowClaimed + held) {
            revert CeilingExceedsEscrow(auth.cumulativeEligible, l.escrowClaimed + held);
        }
        if (eligibleRevenueDigest(auth).recover(signature) != attestor) {
            revert InvalidAttestation();
        }
        l.authNonce = auth.nonce;
        l.eligibleCeiling = auth.cumulativeEligible;
        emit EligibleRevenueAuthorized(
            auth.asset,
            auth.cumulativeEligible,
            auth.nonce,
            auth.evidenceBlock,
            auth.evidenceBlockHash,
            attestor
        );
    }

    /**
     * @notice Claims `amount` (0 = all VERIFIED headroom) of this contract's
     * own escrow balance in `asset`, never more than the verified ceiling
     * allows, measures what actually arrived and allocates it 2:1. Credits
     * above the ceiling (third-party, unverified) stay in the escrow.
     */
    function pullRevenue(address asset, uint256 amount)
        external
        nonReentrant
        returns (uint256 received)
    {
        if (pullsPaused) revert PullsPaused();
        if (!approvedAsset[asset]) revert AssetNotApproved(asset);
        AssetLedger storage l = _ledgers[asset];
        uint256 headroom = l.eligibleCeiling - l.escrowClaimed;
        if (amount == 0) {
            uint256 escrowed = asset == NATIVE
                ? feeEscrow.balanceOf(address(this))
                : feeEscrow.balanceOfToken(address(this), asset);
            amount = escrowed < headroom ? escrowed : headroom;
        }
        if (amount == 0) revert NothingReceived();
        if (amount > headroom) revert ExceedsVerifiedRevenue(amount, headroom);

        l.escrowClaimed += amount;
        uint256 before = _balanceOf(asset);
        if (asset == NATIVE) {
            _pullingNative = true;
            feeEscrow.claim(amount);
            _pullingNative = false;
        } else {
            feeEscrow.claimToken(asset, amount);
        }
        received = _balanceOf(asset) - before;
        if (received == 0) revert NothingReceived();
        _allocate(asset, amount, received);
    }

    /**
     * @notice Records any balance above everything already accounted for
     * (direct ERC-20 transfers, owner rescues, forced ETH) as non-revenue.
     */
    function recordUnattributed(address asset) external nonReentrant returns (uint256 surplus) {
        uint256 balance = _balanceOf(asset);
        uint256 accounted = accountedHoldings(asset);
        if (balance <= accounted) revert NothingToRecord();
        surplus = balance - accounted;
        _ledgers[asset].nonRevenueReceived += surplus;
        emit NonRevenueReceived(
            asset,
            address(0),
            surplus,
            asset == NATIVE ? NonRevenueClass.UnattributedNative : NonRevenueClass.UnattributedToken
        );
    }

    // ── Outflows ─────────────────────────────────────────────────────────

    /**
     * @notice The treasury recipient claims `amount` (0 = all) of its
     * allocated, unpaid entitlement. Independent of the asset's current
     * approval, so historic liabilities stay claimable.
     */
    function claimTreasury(address asset, uint256 amount) external nonReentrant returns (uint256) {
        if (msg.sender != treasuryRecipient) revert NotTreasuryRecipient();
        AssetLedger storage l = _ledgers[asset];
        uint256 available = l.treasuryAllocated - l.treasuryPaid;
        if (amount == 0) amount = available;
        if (amount == 0 || amount > available) revert InsufficientLiability(amount, available);
        l.treasuryPaid += amount;
        emit TreasuryClaimed(asset, msg.sender, amount);
        _send(asset, msg.sender, amount);
        return amount;
    }

    /**
     * @notice Releases held NON-REVENUE funds to the treasury recipient only.
     */
    function releaseNonRevenue(address asset, uint256 amount) external nonReentrant onlyOwner {
        AssetLedger storage l = _ledgers[asset];
        uint256 held = l.nonRevenueReceived - l.nonRevenueReleased;
        if (amount == 0 || amount > held) revert InsufficientLiability(amount, held);
        l.nonRevenueReleased += amount;
        address recipient = treasuryRecipient;
        emit NonRevenueReleased(asset, recipient, amount);
        _send(asset, recipient, amount);
    }

    // ── Governance ───────────────────────────────────────────────────────

    /// @notice One-time wiring of the Forge factory.
    function setForgeFactory(address factory_) external onlyOwner {
        if (forgeFactory != address(0)) revert FactoryAlreadySet();
        if (factory_ == address(0)) revert ZeroAddress();
        forgeFactory = factory_;
        emit ForgeFactorySet(factory_);
    }

    /**
     * @notice Approves or revokes an ERC-20 revenue asset. Approval is
     * SOURCE-DERIVED: the Forge factory must be wired, must currently approve
     * the asset as a quote asset with configured economics, and the asset's
     * own decimals must match the factory's recorded scale. Forge launch
     * tokens are refused. Revoking only stops future authorizations/pulls;
     * allocated liabilities stay claimable, and a LATER factory de-listing
     * does not revoke it (existing launches keep trading against it).
     */
    function setAssetApproved(address asset, bool approved) external onlyOwner {
        if (asset == NATIVE) revert InvalidRecipient();
        if (approved) {
            address factory = forgeFactory;
            if (factory == address(0)) revert FactoryNotWired();
            if (asset.code.length == 0) revert NotAContract(asset);
            if (IPonsV2LaunchFactory(factory).getLaunchedToken(asset).exists) {
                revert AssetIsLaunchToken(asset);
            }
            if (!IForgeQuotePolicy(factory).approvedPairTokens(asset)) {
                revert AssetNotForgeQuote(asset);
            }
            (uint256 phantomQuote, uint256 graduationThreshold, uint8 decimals) =
                IForgeQuotePolicy(factory).pairTokenEconomics(asset);
            if (phantomQuote == 0 || graduationThreshold == 0) revert AssetNotForgeQuote(asset);
            if (IERC20Metadata(asset).decimals() != decimals) revert QuoteDecimalsMismatch(asset);
        }
        approvedAsset[asset] = approved;
        emit AssetApprovalUpdated(asset, approved);
    }

    /// @notice Halts new pulls (never claims). Funds stay in the escrow.
    function setPullsPaused(bool paused) external onlyOwner {
        pullsPaused = paused;
        emit PullsPausedUpdated(paused);
    }

    function proposeTreasuryRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        if (newRecipient == address(this) || newRecipient == address(feeEscrow)) {
            revert InvalidRecipient();
        }
        if (newRecipient == revenueAttestor) revert RolesNotSeparated();
        pendingTreasuryRecipient = _pending(newRecipient);
        emit TreasuryRecipientChangeProposed(
            treasuryRecipient,
            newRecipient,
            pendingTreasuryRecipient.effectiveAt,
            pendingTreasuryRecipient.expiresAt
        );
    }

    /// @notice Permissionless execution of a matured treasury recipient change.
    function executeTreasuryRecipientChange() external {
        address next = _matured(pendingTreasuryRecipient);
        if (next == revenueAttestor) revert RolesNotSeparated();
        delete pendingTreasuryRecipient;
        emit TreasuryRecipientUpdated(treasuryRecipient, next);
        treasuryRecipient = next;
    }

    function cancelTreasuryRecipientChange() external onlyOwner {
        address proposed = pendingTreasuryRecipient.newRecipient;
        if (proposed == address(0)) revert NoPendingChange();
        delete pendingTreasuryRecipient;
        emit TreasuryRecipientChangeCancelled(proposed);
    }

    /// @notice Timelocked attestor rotation (a new attestor raises ceilings).
    function proposeRevenueAttestor(address newAttestor) external onlyOwner {
        if (newAttestor == address(0)) revert ZeroAddress();
        _requireSeparated(newAttestor, treasuryRecipient);
        pendingRevenueAttestor = _pending(newAttestor);
        emit RevenueAttestorChangeProposed(
            revenueAttestor,
            newAttestor,
            pendingRevenueAttestor.effectiveAt,
            pendingRevenueAttestor.expiresAt
        );
    }

    function executeRevenueAttestorChange() external {
        address next = _matured(pendingRevenueAttestor);
        _requireSeparated(next, treasuryRecipient);
        delete pendingRevenueAttestor;
        emit RevenueAttestorUpdated(revenueAttestor, next);
        revenueAttestor = next;
    }

    function cancelRevenueAttestorChange() external onlyOwner {
        address proposed = pendingRevenueAttestor.newRecipient;
        if (proposed == address(0)) revert NoPendingChange();
        delete pendingRevenueAttestor;
        emit RevenueAttestorChangeCancelled(proposed);
    }

    /// @notice Immediate, fail-closed revocation: no new ceilings until a
    /// timelocked replacement executes. Existing ceilings stay usable.
    function revokeRevenueAttestor() external onlyOwner {
        emit RevenueAttestorUpdated(revenueAttestor, address(0));
        revenueAttestor = address(0);
    }

    function renounceOwnership() public pure override {
        revert OwnershipCannotBeRenounced();
    }

    // ── Views ────────────────────────────────────────────────────────────

    function ledger(address asset) external view returns (AssetLedger memory) {
        return _ledgers[asset];
    }

    function treasuryLiability(address asset) public view returns (uint256) {
        AssetLedger storage l = _ledgers[asset];
        return l.treasuryAllocated - l.treasuryPaid;
    }

    function reserveLiability(address asset) public view returns (uint256) {
        return _ledgers[asset].reserveAllocated;
    }

    function nonRevenueHeld(address asset) public view returns (uint256) {
        AssetLedger storage l = _ledgers[asset];
        return l.nonRevenueReceived - l.nonRevenueReleased;
    }

    function accountedHoldings(address asset) public view returns (uint256) {
        return treasuryLiability(asset) + reserveLiability(asset) + nonRevenueHeld(asset);
    }

    /// @notice Verified escrow amount still pullable for `asset`.
    function verifiedHeadroom(address asset) external view returns (uint256) {
        AssetLedger storage l = _ledgers[asset];
        return l.eligibleCeiling - l.escrowClaimed;
    }

    function reconcile(address asset)
        external
        view
        returns (uint256 balance, uint256 accounted, uint256 surplus, uint256 deficit)
    {
        balance = _balanceOf(asset);
        accounted = accountedHoldings(asset);
        if (balance >= accounted) surplus = balance - accounted;
        else deficit = accounted - balance;
    }

    function eligibleRevenueDigest(EligibleRevenue calldata auth) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ELIGIBLE_REVENUE_TYPEHASH,
                    auth.escrow,
                    auth.factory,
                    auth.asset,
                    auth.cumulativeEligible,
                    auth.nonce,
                    auth.deadline,
                    auth.evidenceBlock,
                    auth.evidenceBlockHash
                )
            )
        );
    }

    function burnReadiness() external pure returns (bool enabled, string memory status) {
        return
            (FINCO_BURN_ENABLED, "DISABLED: FINCO_BURN_ENABLED=false; reserve is a liability only");
    }

    // ── Internals ────────────────────────────────────────────────────────

    function _allocate(address asset, uint256 claimed, uint256 received) private {
        AssetLedger storage l = _ledgers[asset];
        uint256 revenue = l.revenueReceived + received;
        uint256 reserveTotal = (revenue * RESERVE_PARTS) / TOTAL_PARTS;
        uint256 toReserve = reserveTotal - l.reserveAllocated;
        uint256 toTreasury = received - toReserve;
        l.revenueReceived = revenue;
        l.reserveAllocated = reserveTotal;
        l.treasuryAllocated += toTreasury;
        uint256 id = ++allocationCount;
        emit RevenueAllocated(id, asset, claimed, received, toTreasury, toReserve, POLICY_VERSION);
    }

    function _requireSeparated(address attestor, address treasury) private view {
        if (attestor == treasury || attestor == owner() || attestor == address(this)) {
            revert RolesNotSeparated();
        }
    }

    function _pending(address next) private view returns (PendingRecipient memory) {
        uint256 effectiveAt = block.timestamp + RECIPIENT_TIMELOCK;
        return PendingRecipient({
            newRecipient: next,
            effectiveAt: uint64(effectiveAt),
            expiresAt: uint64(effectiveAt + RECIPIENT_EXECUTION_WINDOW)
        });
    }

    function _matured(PendingRecipient memory p) private view returns (address) {
        if (p.newRecipient == address(0)) revert NoPendingChange();
        if (block.timestamp < p.effectiveAt) revert TimelockNotElapsed(p.effectiveAt);
        if (block.timestamp > p.expiresAt) revert TimelockExpired(p.expiresAt);
        return p.newRecipient;
    }

    function _balanceOf(address asset) private view returns (uint256) {
        return asset == NATIVE ? address(this).balance : IERC20(asset).balanceOf(address(this));
    }

    function _send(address asset, address to, uint256 amount) private {
        if (asset == NATIVE) {
            (bool ok,) = payable(to).call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(asset).safeTransfer(to, amount);
        }
    }
}
