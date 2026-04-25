// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

contract VenomRegistry is Ownable {
    struct Oracle {
        address operator;
        uint256 stake;
        uint256 scoreCount;
        uint256 lastActive;
        bool active;
        string multiaddr;
    }

    mapping(address => Oracle) public oracles;
    address[] public oracleList;
    address public pilotEscrow;

    uint256 public constant MIN_STAKE = 1 ether;
    uint256 public constant SLASH_PERCENT = 5; // Reduced for rc.1
    uint256 public constant MAX_DEVIATION = 25;

    event OracleRegistered(address indexed operator, uint256 stake, string multiaddr);
    event OracleSlashed(address indexed operator, uint256 amount, string reason);
    event PilotEscrowSet(address indexed pilotEscrow);

    constructor() Ownable(msg.sender) {}

    modifier onlyPilotEscrow() {
        require(msg.sender == pilotEscrow, "Only PilotEscrow");
        _;
    }

    function setPilotEscrow(address _pilotEscrow) external onlyOwner {
        require(pilotEscrow == address(0), "Already set");
        require(_pilotEscrow != address(0), "Zero address");
        pilotEscrow = _pilotEscrow;
        emit PilotEscrowSet(_pilotEscrow);
    }

    function registerOracle(string calldata _multiaddr) external payable {
        require(msg.value >= MIN_STAKE, "Insufficient stake");
        require(!oracles[msg.sender].active, "Already registered");
        require(bytes(_multiaddr).length > 0, "Multiaddr required");

        oracles[msg.sender] = Oracle({
            operator: msg.sender,
            stake: msg.value,
            scoreCount: 0,
            lastActive: block.timestamp,
            active: true,
            multiaddr: _multiaddr
        });
        oracleList.push(msg.sender);
        emit OracleRegistered(msg.sender, msg.value, _multiaddr);
    }

    function reportDeviation(address operator, uint256 submittedScore, uint256 medianScore)
        external
        onlyPilotEscrow
    {
        if (!oracles[operator].active) return; // Gracefully ignore already slashed

        uint256 deviation = submittedScore > medianScore
            ? submittedScore - medianScore
            : medianScore - submittedScore;

        if (deviation > MAX_DEVIATION) {
            uint256 slashAmount = (oracles[operator].stake * SLASH_PERCENT) / 100;
            oracles[operator].stake -= slashAmount;
            oracles[operator].active = false;
            emit OracleSlashed(operator, slashAmount, "Score deviation too high");
        }
    }

    function getActiveOracles()
        external
        view
        returns (address[] memory operators, string[] memory multiaddrs)
    {
        uint256 count = 0;
        for (uint256 i = 0; i < oracleList.length; i++) {
            if (oracles[oracleList[i]].active) count++;
        }
        operators = new address[](count);
        multiaddrs = new string[](count);
        uint256 index = 0;
        for (uint256 i = 0; i < oracleList.length; i++) {
            address op = oracleList[i];
            if (oracles[op].active) {
                operators[index] = op;
                multiaddrs[index] = oracles[op].multiaddr;
                index++;
            }
        }
    }

    function isActiveOracle(address operator) external view returns (bool) {
        return oracles[operator].active;
    }

    /// @notice Returns the count of currently active oracles. O(n) but cheap for view calls.
    function activeOracleCount() external view returns (uint256 count) {
        for (uint256 i = 0; i < oracleList.length; i++) {
            if (oracles[oracleList[i]].active) count++;
        }
    }
}
