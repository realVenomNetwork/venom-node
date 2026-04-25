// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract VenomRegistry {
    struct Oracle {
        address operator;
        uint256 stake;
        uint256 scoreCount;
        uint256 lastActive;
        bool active;
        string multiaddr;           // NEW: Libp2p multiaddr
    }

    mapping(address => Oracle) public oracles;
    address[] public oracleList;

    address public pilotEscrow;

    uint256 public constant MIN_STAKE = 1 ether;
    uint256 public constant SLASH_PERCENT = 25;
    uint256 public constant MAX_DEVIATION = 25;

    event OracleRegistered(address indexed operator, uint256 stake, string multiaddr);
    event OracleSlashed(address indexed operator, uint256 amount, string reason);

    modifier onlyPilotEscrow() {
        require(msg.sender == pilotEscrow, "Only PilotEscrow");
        _;
    }

    function setPilotEscrow(address _pilotEscrow) external {
        require(pilotEscrow == address(0), "Already set");
        pilotEscrow = _pilotEscrow;
    }

    /// @notice Register as oracle + publish your Libp2p multiaddr
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

    function reportDeviation(address operator, uint256 submittedScore, uint256 medianScore) external onlyPilotEscrow {
        require(oracles[operator].active, "Not active");

        uint256 deviation = submittedScore > medianScore 
            ? submittedScore - medianScore 
            : medianScore - submittedScore;

        if (deviation > MAX_DEVIATION) {
            uint256 slashAmount = (oracles[operator].stake * SLASH_PERCENT) / 100;
            oracles[operator].stake -= slashAmount;
            oracles[operator].active = false;
            payable(address(this)).transfer(slashAmount);
            emit OracleSlashed(operator, slashAmount, "Score deviation too high");
        }
    }

    /// @notice Returns all currently active oracles with their multiaddrs
    function getActiveOracles() external view returns (address[] memory operators, string[] memory multiaddrs) {
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
}
