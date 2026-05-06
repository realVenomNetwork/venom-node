// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/**
 * @title VenomRegistry
 * @notice Tracks testnet oracle registration, active status, Libp2p addresses, and slashing reserves.
 * @dev Registered stake can be withdrawn after a cooldown period via requestUnstake/finalizeUnstake.
 * Only stake slashed through PilotEscrow deviation reports can be withdrawn by the owner via slashedStakeReserve.
 */
contract VenomRegistry is Ownable2Step, ReentrancyGuard {
    using EnumerableSet for EnumerableSet.AddressSet;

    struct Oracle {
        address operator;
        uint256 stake;
        uint256 scoreCount;
        uint256 lastActive;
        bool active;
        string multiaddr;
    }

    mapping(address => Oracle) public oracles;
    mapping(address => bool) public hasRegistered;
    mapping(address => bool) public everSlashed;
    EnumerableSet.AddressSet private activeOraclesSet;
    address public pilotEscrow;
    uint256 public slashedStakeReserve;
    uint256 private constant MAX_ORACLES = 1000;
    uint256 private constant UNSTAKE_COOLDOWN = 7 days;
    uint256 public constant WITHDRAWAL_TIMELOCK = 48 hours;

    struct WithdrawalRequest {
        uint256 amount;
        uint256 executableAt;
    }

    mapping(address => uint256) public unstakeRequestedAt;
    mapping(address => WithdrawalRequest) public pendingSlashedStakeWithdrawals;
    address public pendingPilotEscrow;
    uint256 public pendingPilotEscrowScheduledAt;

    uint256 public constant MIN_STAKE = 1 ether;
    uint256 public constant SLASH_PERCENT = 5; // Reduced for rc.1
    uint256 public constant MAX_DEVIATION = 25;

    /// @notice Emitted when an operator registers with stake and a Libp2p multiaddr.
    event OracleRegistered(address indexed operator, uint256 stake, string multiaddr);
    /// @notice Emitted when PilotEscrow reports a deviation large enough to slash an oracle.
    event OracleSlashed(address indexed operator, uint256 amount, string reason);
    /// @notice Emitted when a deviation report does not change oracle state.
    event SlashSkipped(address indexed operator, string reason);
    /// @notice Emitted when the one-time PilotEscrow authority is configured.
    event PilotEscrowSet(address indexed pilotEscrow);
    /// @notice Emitted when the owner withdraws ETH from the slashed stake reserve.
    event SlashedStakeWithdrawn(address indexed recipient, uint256 amount);
    /// @notice Emitted when the owner schedules a slashed stake reserve withdrawal.
    event SlashedStakeWithdrawalScheduled(address indexed recipient, uint256 amount, uint256 executableAt);
    /// @notice Emitted when the owner cancels a scheduled slashed stake reserve withdrawal.
    event SlashedStakeWithdrawalCancelled(address indexed recipient);
    /// @notice Emitted when an oracle requests to unstake.
    event UnstakeRequested(address indexed operator, uint256 scheduledAt);
    /// @notice Emitted when an oracle finalizes unstake and receives stake back.
    event UnstakeFinalized(address indexed operator, uint256 amount);
    /// @notice Emitted when a PilotEscrow upgrade is scheduled.
    event PilotEscrowUpgradeScheduled(address indexed newEscrow, uint256 scheduledAt);
    /// @notice Emitted when a PilotEscrow upgrade is executed.
    event PilotEscrowUpgraded(address indexed newEscrow);

    constructor() Ownable(msg.sender) {}

    modifier onlyPilotEscrow() {
        require(msg.sender == pilotEscrow, "Only PilotEscrow");
        _;
    }

    /// @notice Set the only contract allowed to report slashable deviations.
    /// On first call, sets immediately. On subsequent calls, schedules a 48h timelock upgrade.
    function setPilotEscrow(address _pilotEscrow) external onlyOwner {
        require(_pilotEscrow != address(0), "Zero address");
        if (pilotEscrow == address(0)) {
            pilotEscrow = _pilotEscrow;
            emit PilotEscrowSet(_pilotEscrow);
        } else {
            pendingPilotEscrow = _pilotEscrow;
            pendingPilotEscrowScheduledAt = block.timestamp + 48 hours;
            emit PilotEscrowUpgradeScheduled(_pilotEscrow, pendingPilotEscrowScheduledAt);
        }
    }

    /// @notice Execute PilotEscrow upgrade after timelock.
    function executePilotEscrowUpgrade() external onlyOwner {
        require(pendingPilotEscrow != address(0), "No pending upgrade");
        require(block.timestamp >= pendingPilotEscrowScheduledAt, "Timelock active");
        pilotEscrow = pendingPilotEscrow;
        delete pendingPilotEscrow;
        delete pendingPilotEscrowScheduledAt;
        emit PilotEscrowUpgraded(pilotEscrow);
        emit PilotEscrowSet(pilotEscrow);
    }

    /// @notice Request unstake with cooldown period.
    function requestUnstake() external {
        Oracle storage o = oracles[msg.sender];
        require(o.operator == msg.sender, "Not registered");
        require(o.active, "Already inactive");
        require(unstakeRequestedAt[msg.sender] == 0, "Unstake already requested");

        o.active = false;
        activeOraclesSet.remove(msg.sender);
        unstakeRequestedAt[msg.sender] = block.timestamp;
        emit UnstakeRequested(msg.sender, block.timestamp);
    }

    /// @notice Finalize unstake after cooldown.
    /// Slashed oracles cannot re-register (hasRegistered is preserved).
    function finalizeUnstake() external nonReentrant {
        require(unstakeRequestedAt[msg.sender] > 0, "No unstake requested");
        require(block.timestamp >= unstakeRequestedAt[msg.sender] + UNSTAKE_COOLDOWN, "Cooldown active");

        uint256 amount = oracles[msg.sender].stake;
        delete oracles[msg.sender];
        // Preserve hasRegistered for slashed oracles to prevent re-registration
        if (!everSlashed[msg.sender]) {
            delete hasRegistered[msg.sender];
        }
        delete unstakeRequestedAt[msg.sender];

        (bool ok,) = payable(msg.sender).call{value: amount}("");
        require(ok, "Transfer failed");
        emit UnstakeFinalized(msg.sender, amount);
    }

    /// @notice Register the sender as an oracle with at least MIN_STAKE.
    function registerOracle(string calldata _multiaddr) external payable {
        require(msg.value >= MIN_STAKE, "Insufficient stake");
        require(!oracles[msg.sender].active, "Already registered");
        require(!hasRegistered[msg.sender], "Oracle already exists");
        require(activeOraclesSet.length() < MAX_ORACLES, "Oracle limit reached");
        require(bytes(_multiaddr).length > 0, "Multiaddr required");

        oracles[msg.sender] = Oracle({
            operator: msg.sender,
            stake: msg.value,
            scoreCount: 0,
            lastActive: block.timestamp,
            active: true,
            multiaddr: _multiaddr
        });
        hasRegistered[msg.sender] = true;
        activeOraclesSet.add(msg.sender);
        emit OracleRegistered(msg.sender, msg.value, _multiaddr);
    }

    /// @notice Slash an oracle if its submitted score deviates too far from the median.
    /// Slashing applies to any oracle with stake > 0, including those in unstake cooldown.
    function reportDeviation(address operator, uint256 submittedScore, uint256 medianScore)
        external
        onlyPilotEscrow
    {
        Oracle storage o = oracles[operator];
        if (o.stake == 0) {
            emit SlashSkipped(operator, "No stake to slash");
            return;
        }

        uint256 deviation = submittedScore > medianScore
            ? submittedScore - medianScore
            : medianScore - submittedScore;

        if (deviation > MAX_DEVIATION) {
            uint256 slashAmount = (o.stake * SLASH_PERCENT) / 100;
            o.stake -= slashAmount;
            slashedStakeReserve += slashAmount;
            everSlashed[operator] = true;
            if (o.active) {
                o.active = false;
                activeOraclesSet.remove(operator);
            }
            emit OracleSlashed(operator, slashAmount, "Score deviation too high");
        } else {
            emit SlashSkipped(operator, "Deviation within tolerance");
        }
    }

    /// @notice Schedule withdrawal of ETH already accounted into slashedStakeReserve.
    function scheduleSlashedStakeWithdrawal(address payable recipient, uint256 amount) external onlyOwner {
        require(recipient != address(0), "Zero address");
        require(amount > 0, "Amount must be positive");
        require(amount <= slashedStakeReserve, "Exceeds reserve");
        require(pendingSlashedStakeWithdrawals[recipient].amount == 0, "Withdrawal already scheduled");
        uint256 executableAt = block.timestamp + WITHDRAWAL_TIMELOCK;
        pendingSlashedStakeWithdrawals[recipient] = WithdrawalRequest({
            amount: amount,
            executableAt: executableAt
        });
        emit SlashedStakeWithdrawalScheduled(recipient, amount, executableAt);
    }

    /// @notice Cancel a scheduled slashed stake reserve withdrawal.
    function cancelSlashedStakeWithdrawal(address recipient) external onlyOwner {
        require(pendingSlashedStakeWithdrawals[recipient].amount > 0, "No scheduled withdrawal");
        delete pendingSlashedStakeWithdrawals[recipient];
        emit SlashedStakeWithdrawalCancelled(recipient);
    }

    /// @notice Execute a scheduled slashed stake reserve withdrawal after the timelock.
    function withdrawSlashedStake(address payable recipient, uint256 amount) external onlyOwner nonReentrant {
        WithdrawalRequest memory request = pendingSlashedStakeWithdrawals[recipient];
        require(request.amount > 0, "No scheduled withdrawal");
        require(request.amount == amount, "Amount mismatch");
        require(block.timestamp >= request.executableAt, "Withdrawal timelock active");
        require(amount <= slashedStakeReserve, "Exceeds reserve");
        delete pendingSlashedStakeWithdrawals[recipient];
        slashedStakeReserve -= amount;
        (bool ok, ) = recipient.call{value: amount}("");
        require(ok, "Transfer failed");
        emit SlashedStakeWithdrawn(recipient, amount);
    }

    function getActiveOracles()
        external
        view
        returns (address[] memory operators, string[] memory multiaddrs)
    {
        uint256 count = activeOraclesSet.length();
        operators = new address[](count);
        multiaddrs = new string[](count);
        for (uint256 i = 0; i < count; i++) {
            address op = activeOraclesSet.at(i);
            operators[i] = op;
            multiaddrs[i] = oracles[op].multiaddr;
        }
    }

    function isActiveOracle(address operator) external view returns (bool) {
        return oracles[operator].active;
    }

    /// @notice Returns the count of currently active oracles.
    function activeOracleCount() external view returns (uint256) {
        return activeOraclesSet.length();
    }
}
