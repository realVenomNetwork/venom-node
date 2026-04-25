// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./VenomRegistry.sol";

contract PilotEscrow {
    struct Campaign {
        uint256 balance;
        bool closed;
        bool retired;
        bool compromised;
        uint256 lastNonce;
    }

    mapping(bytes32 => Campaign) public campaigns;
    VenomRegistry public registry;

    uint256 public constant PASS_THRESHOLD = 60;     // 0.60 * 100
    uint256 public constant REQUIRED_ORACLES = 5;

    event CampaignFunded(bytes32 indexed campaignUid, address indexed funder, uint256 amount);
    event CampaignClosed(bytes32 indexed campaignUid, address recipient, uint256 bounty, uint256 medianScore);

    constructor(address _registry) {
        registry = VenomRegistry(_registry);
    }

    function fundCampaign(bytes32 campaignUid) external payable {
        require(msg.value > 0, "Must send ETH");
        campaigns[campaignUid].balance += msg.value;
        emit CampaignFunded(campaignUid, msg.sender, msg.value);
    }

    /// @notice Close campaign with array of (score, signature) pairs from oracles
    function closeCampaign(
        bytes32 campaignUid,
        address recipient,
        uint256 bounty,
        uint256 payloadNonce,
        uint256[] calldata scores,
        bytes[] calldata signatures
    ) external {
        require(scores.length == signatures.length, "Length mismatch");
        require(scores.length >= REQUIRED_ORACLES, "Not enough oracles");

        Campaign storage campaign = campaigns[campaignUid];
        require(!campaign.closed, "Already closed");
        require(campaign.balance >= bounty, "Insufficient balance");

        uint256[] memory validScores = new uint256[](scores.length);
        uint256 validCount = 0;

        for (uint256 i = 0; i < scores.length; i++) {
            address signer = _recoverSigner(campaignUid, scores[i], signatures[i]);
            if (registry.isActiveOracle(signer)) {
                validScores[validCount] = scores[i];
                validCount++;
            }
        }

        require(validCount >= REQUIRED_ORACLES, "Not enough valid oracles");

        uint256 medianScore = _calculateMedian(validScores, validCount);

        require(medianScore >= PASS_THRESHOLD, "Median below threshold");

        // === ACTUAL SLASHING ENFORCEMENT ===
        for (uint256 i = 0; i < validCount; i++) {
            uint256 deviation = validScores[i] > medianScore 
                ? validScores[i] - medianScore 
                : medianScore - validScores[i];
            
            if (deviation > 25) {
                // Recover signer again for slashing
                address signer = _recoverSigner(campaignUid, validScores[i], signatures[i]);
                registry.reportDeviation(signer, validScores[i], medianScore);
            }
        }

        campaign.closed = true;
        campaign.balance -= bounty;
        payable(recipient).transfer(bounty);

        emit CampaignClosed(campaignUid, recipient, bounty, medianScore);
    }

    // ==================== INTERNAL HELPERS ====================

    function _recoverSigner(bytes32 campaignUid, uint256 score, bytes memory signature) internal pure returns (address) {
        bytes32 messageHash = keccak256(abi.encodePacked(campaignUid, score));
        bytes32 ethSignedMessageHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));

        (bytes32 r, bytes32 s, uint8 v) = _splitSignature(signature);
        return ecrecover(ethSignedMessageHash, v, r, s);
    }

    function _splitSignature(bytes memory sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        require(sig.length == 65, "Invalid signature length");
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
    }

    /// @notice Gas-efficient median calculation using bubble sort (safe for small arrays)
    function _calculateMedian(uint256[] memory arr, uint256 length) internal pure returns (uint256) {
        // Bubble sort (acceptable since length ≤ 15 in practice)
        for (uint256 i = 0; i < length; i++) {
            for (uint256 j = 0; j < length - i - 1; j++) {
                if (arr[j] > arr[j + 1]) {
                    (arr[j], arr[j + 1]) = (arr[j + 1], arr[j]);
                }
            }
        }
        return arr[length / 2];
    }
}
