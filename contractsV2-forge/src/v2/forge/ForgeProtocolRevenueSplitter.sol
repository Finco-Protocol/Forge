// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPonsV2FeeEscrow, IPonsV2LaunchFactory} from "../interfaces/ILaunchpadV2.sol";

/**
 * @title ForgeProtocolRevenueSplitter
 * @notice W04 sandbox: the Forge-owned recipient of the PROTOCOL leg of the
 * Forge launchpad's base trading fees. It sits behind the canonical
 * PonsV2FeeEscrow as the escrow key the Forge hook's `protocolFeeRecipient`
 * names, and divides only the protocol revenue it actually receives:
 *
 *   protocol leg (30% of an eligible base fee under the default snapshot)
 *     → 2/3 Forge treasury   (20 percentage points of the base fee)
 *     → 1/3 FINCO reserve    (10 percentage points of the base fee)
 *
 * The creator's 70% never passes through this contract: the curve and hook
 * credit it to the creator's own escrow key, and the creator claims it from
 * the escrow directly. This contract can only claim the escrow balance held
 * under its OWN address — the escrow pays `msg.sender` — so it can never
 * reach another recipient's funds.
 *
 * Accounting boundaries (per asset, `address(0)` = native ETH):
 *
 *   REVENUE      — measured on `pullRevenue` as the splitter's actual balance
 *                  delta across the escrow claim, then allocated.
 *   NON-REVENUE  — every other inflow: the factory's launch fee (paid
 *                  directly, never through the escrow), owner rescues,
 *                  third-party transfers. Held separately, never allocated,
 *                  only releasable to the treasury recipient as an
 *                  explicitly labelled non-revenue transfer.
 *
 *   actual balance >= treasuryLiability + reserveLiability + nonRevenueHeld
 *
 * with any surplus recorded by `recordUnattributed` (never allocated).
 *
 * Rounding: the reserve's cumulative entitlement is floor(revenue / 3) on the
 * asset's lifetime revenue, the treasury takes the remainder. Cumulative
 * flooring keeps the split within one base unit of the exact 2:1 ratio over
 * any number of pulls (no per-pull drift), and the reserve never receives
 * more than its exact third.
 *
 * FINCO reserve: a liability only. There is no reserve withdrawal, swap or
 * burn entry point; `FINCO_BURN_ENABLED` is a compile-time `false`. Future
 * execution requires a separately reviewed governance contract (see
 * IFincoBurnReserveExecutor) and a new splitter version.
 *
 * Limits documented in docs/W04-ECONOMICS-ARCHITECTURE.md: the escrow's
 * `credit`/`creditToken` are permissionless, so a third party can credit
 * this contract's escrow key; such credits are indistinguishable ON CHAIN
 * from fee credits and are separated OFF CHAIN by the ledger (escrow
 * `Credited*` events carry the depositor). Sandbox only: PRODUCTION_BLOCKED.
 */
contract ForgeProtocolRevenueSplitter is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum NonRevenueClass {
        LaunchFee,
        UnattributedNative,
        UnattributedToken
    }

    struct AssetLedger {
        uint256 revenueReceived;
        uint256 treasuryAllocated;
        uint256 reserveAllocated;
        uint256 treasuryPaid;
        uint256 nonRevenueReceived;
        uint256 nonRevenueReleased;
    }

    struct PendingRecipient {
        address newRecipient;
        uint64 effectiveAt;
        uint64 expiresAt;
    }

    error ZeroAddress();
    error InvalidRecipient();
    error FactoryAlreadySet();
    error AssetNotApproved(address asset);
    error AssetIsLaunchToken(address asset);
    error NotAContract(address asset);
    error PullsPaused();
    error NothingReceived();
    error NotTreasuryRecipient();
    error InsufficientLiability(uint256 requested, uint256 available);
    error NoPendingChange();
    error TimelockNotElapsed(uint256 effectiveAt);
    error TimelockExpired(uint256 expiresAt);
    error NothingToRecord();
    error OwnershipCannotBeRenounced();
    error TransferFailed();

    event ForgeFactorySet(address indexed factory);
    event AssetApprovalUpdated(address indexed asset, bool approved);
    event PullsPausedUpdated(bool paused);
    event RevenueAllocated(
        uint256 indexed allocationId,
        address indexed asset,
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
    /// @notice Notice period before a treasury recipient change can execute.
    uint256 public constant RECIPIENT_TIMELOCK = 3 days;
    /// @notice A matured recipient change must execute inside this window.
    uint256 public constant RECIPIENT_EXECUTION_WINDOW = 3 days;

    /// @notice The canonical escrow this splitter claims its own key from.
    IPonsV2FeeEscrow public immutable feeEscrow;

    /// @notice The Forge factory (one-time wiring). Its direct ETH payments
    /// are classified as launch fees; its launch tokens can never be
    /// approved as revenue assets.
    address public forgeFactory;

    address public treasuryRecipient;
    PendingRecipient public pendingTreasuryRecipient;

    bool public pullsPaused;
    uint256 public allocationCount;

    mapping(address asset => bool approved) public approvedAsset;
    mapping(address asset => AssetLedger ledger) private _ledgers;

    // Set only while `pullRevenue` awaits the escrow's native payment, so
    // that payment is measured by the pull and not booked as non-revenue.
    bool private _pullingNative;

    constructor(IPonsV2FeeEscrow feeEscrow_, address owner_, address treasuryRecipient_)
        Ownable(owner_)
    {
        if (address(feeEscrow_) == address(0) || treasuryRecipient_ == address(0)) {
            revert ZeroAddress();
        }
        if (treasuryRecipient_ == address(this)) revert InvalidRecipient();
        feeEscrow = feeEscrow_;
        treasuryRecipient = treasuryRecipient_;
        approvedAsset[NATIVE] = true;
        emit AssetApprovalUpdated(NATIVE, true);
        emit TreasuryRecipientUpdated(address(0), treasuryRecipient_);
    }

    // ── Inflows ──────────────────────────────────────────────────────────

    /**
     * @notice Every native inflow except the escrow payment a pull is
     * waiting for is NON-REVENUE: the factory's launch fee, an owner rescue
     * from a curve, or any third-party transfer. Accepted (refusing would
     * brick launches, whose fee is pushed here) but never allocated.
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
     * @notice Claims `amount` (0 = everything) of this contract's own escrow
     * balance in `asset`, measures what actually arrived, and allocates it
     * 2:1 between the treasury and the FINCO reserve. Permissionless: it
     * only moves funds the escrow already owes this contract.
     */
    function pullRevenue(address asset, uint256 amount)
        external
        nonReentrant
        returns (uint256 received)
    {
        if (pullsPaused) revert PullsPaused();
        if (!approvedAsset[asset]) revert AssetNotApproved(asset);

        uint256 before = _balanceOf(asset);
        if (asset == NATIVE) {
            if (amount == 0) amount = feeEscrow.balanceOf(address(this));
            if (amount == 0) revert NothingReceived();
            _pullingNative = true;
            feeEscrow.claim(amount);
            _pullingNative = false;
        } else {
            if (amount == 0) amount = feeEscrow.balanceOfToken(address(this), asset);
            if (amount == 0) revert NothingReceived();
            feeEscrow.claimToken(asset, amount);
        }
        received = _balanceOf(asset) - before;
        if (received == 0) revert NothingReceived();
        _allocate(asset, received);
    }

    /**
     * @notice Records any balance above everything already accounted for
     * (direct ERC-20 transfers, owner rescues, forced ETH) as non-revenue.
     * Permissionless; such funds are never allocated.
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
     * allocated, unpaid entitlement in `asset`. Partial claims are allowed,
     * so a per-transfer limit on an asset never strands the liability.
     */
    function claimTreasury(address asset, uint256 amount)
        external
        nonReentrant
        returns (uint256)
    {
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
     * @notice Releases held NON-REVENUE funds to the treasury recipient only,
     * labelled as non-revenue. Governance cannot choose another destination
     * and cannot touch allocated treasury or reserve liabilities.
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

    // ── Governance (policy is immutable; only these knobs exist) ─────────

    /// @notice One-time wiring of the Forge factory.
    function setForgeFactory(address factory_) external onlyOwner {
        if (forgeFactory != address(0)) revert FactoryAlreadySet();
        if (factory_ == address(0)) revert ZeroAddress();
        forgeFactory = factory_;
        emit ForgeFactorySet(factory_);
    }

    /**
     * @notice Approves or revokes an ERC-20 quote asset for revenue pulls.
     * Revoking only stops future pulls; liabilities already allocated stay
     * claimable. A Forge launch token can never be approved: its protocol
     * credits are buyback-vest releases, a separate revenue class.
     */
    function setAssetApproved(address asset, bool approved) external onlyOwner {
        if (asset == NATIVE) revert InvalidRecipient();
        if (approved) {
            if (asset.code.length == 0) revert NotAContract(asset);
            if (
                forgeFactory != address(0)
                    && IPonsV2LaunchFactory(forgeFactory).getLaunchedToken(asset).exists
            ) {
                revert AssetIsLaunchToken(asset);
            }
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
        uint256 effectiveAt = block.timestamp + RECIPIENT_TIMELOCK;
        uint256 expiresAt = effectiveAt + RECIPIENT_EXECUTION_WINDOW;
        pendingTreasuryRecipient = PendingRecipient({
            newRecipient: newRecipient,
            effectiveAt: uint64(effectiveAt),
            expiresAt: uint64(expiresAt)
        });
        emit TreasuryRecipientChangeProposed(
            treasuryRecipient, newRecipient, effectiveAt, expiresAt
        );
    }

    /// @notice Permissionless execution of a matured recipient change.
    function executeTreasuryRecipientChange() external {
        PendingRecipient memory p = pendingTreasuryRecipient;
        if (p.newRecipient == address(0)) revert NoPendingChange();
        if (block.timestamp < p.effectiveAt) revert TimelockNotElapsed(p.effectiveAt);
        if (block.timestamp > p.expiresAt) revert TimelockExpired(p.expiresAt);
        delete pendingTreasuryRecipient;
        emit TreasuryRecipientUpdated(treasuryRecipient, p.newRecipient);
        treasuryRecipient = p.newRecipient;
    }

    function cancelTreasuryRecipientChange() external onlyOwner {
        address proposed = pendingTreasuryRecipient.newRecipient;
        if (proposed == address(0)) revert NoPendingChange();
        delete pendingTreasuryRecipient;
        emit TreasuryRecipientChangeCancelled(proposed);
    }

    /// @notice Ownerless governance could never rotate the treasury recipient.
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

    /// @notice The FINCO reserve: allocated and never paid out by this contract.
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

    /// @notice Actual balance versus accounted holdings for one asset.
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

    /// @notice Reserve execution status: always disabled in this version.
    function burnReadiness() external pure returns (bool enabled, string memory status) {
        return (FINCO_BURN_ENABLED, "DISABLED: FINCO_BURN_ENABLED=false; reserve is a liability only");
    }

    // ── Internals ────────────────────────────────────────────────────────

    function _allocate(address asset, uint256 received) private {
        AssetLedger storage l = _ledgers[asset];
        uint256 revenue = l.revenueReceived + received;
        uint256 reserveTotal = (revenue * RESERVE_PARTS) / TOTAL_PARTS;
        uint256 toReserve = reserveTotal - l.reserveAllocated;
        uint256 toTreasury = received - toReserve;
        l.revenueReceived = revenue;
        l.reserveAllocated = reserveTotal;
        l.treasuryAllocated += toTreasury;
        uint256 id = ++allocationCount;
        emit RevenueAllocated(id, asset, received, toTreasury, toReserve, POLICY_VERSION);
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
