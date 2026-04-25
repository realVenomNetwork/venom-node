// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./VenomRegistry.sol";

contract PilotEscrow is Ownable {
    VenomRegistry public immutable registry;

    uint256 public constant REQUIRED_ORACLES = 5;
    uint256 public constant PASS_THRESHOLD = 60;
    uint256 public constant MAX_DEVIATION = 25; // 25 points = 25%

    struct Campaign {
        address recipient;
        uint256 bounty;
        uint256 payloadNonce;
        bool closed;
        uint256 fundedBlock;
    }

    mapping(bytes32 => Campaign) public campaigns;

    event CampaignFunded(bytes32 indexed campaignUid, address indexed funder, uint256 amount);
    event CampaignClosed(bytes32 indexed campaignUid, address indexed recipient, uint256 bounty, uint256 medianScore);

    constructor(address _registry) Ownable(msg.sender) {
        registry = VenomRegistry(_registry);
    }

    function fundCampaign(bytes32 campaignUid) external payable {
        require(msg.value > 0, "Bounty must be > 0");
        require(campaigns[campaignUid].recipient == address(0), "Campaign already exists");

        campaigns[campaignUid] = Campaign({
            recipient: msg.sender,
            bounty: msg.value,
            payloadNonce: 0,
            closed: false,
            fundedBlock: block.number
        });

        emit CampaignFunded(campaignUid, msg.sender, msg.value);
    }

    function closeCampaign(
        bytes32 campaignUid,
        address recipient,
        uint256 bounty,
        uint256 payloadNonce,
        uint256[] calldata scores,
        bytes[] calldata signatures
    ) external {
        Campaign storage campaign = campaigns[campaignUid];
        require(!campaign.closed, "Campaign already closed");
        require(scores.length == signatures.length, "Length mismatch");
        require(scores.length >= REQUIRED_ORACLES, "Not enough submissions");

        // === STEP 1: Validate & recover signers while indices are correct ===
        uint256 validCount = 0;
        uint256[] memory validScores = new uint256[](scores.length);
        address[] memory validSigners = new address[](scores.length);   // ← NEW: parallel signer array

        for (uint256 i = 0; i < scores.length; i++) {
            address signer = _recoverSigner(campaignUid, scores[i], signatures[i]);
            if (registry.isActiveOracle(signer)) {
                validScores[validCount] = scores[i];
                validSigners[validCount] = signer;                       // ← Store recovered signer immediately
                validCount++;
            }
        }

        require(validCount >= REQUIRED_ORACLES, "Not enough valid oracles");

        // === STEP 2: Calculate median (sorts validScores in-place — now safe) ===
        uint256 medianScore = _calculateMedian(validScores, validCount);

        // === STEP 3: Slashing loop (uses pre-recovered signers — no index corruption) ===
        for (uint256 i = 0; i < validCount; i++) {
            uint256 deviation = validScores[i] > medianScore 
                ? validScores[i] - medianScore 
                : medianScore - validScores[i];

            if (deviation > MAX_DEVIATION) {
                registry.reportDeviation(validSigners[i], validScores[i], medianScore);
            }
        }

        // === STEP 4: Close campaign & pay leader ===
        campaign.closed = true;
        payable(recipient).transfer(bounty);

        emit CampaignClosed(campaignUid, recipient, bounty, medianScore);
    }

    // === Internal: Recover signer from EIP-191 signed message ===
    function _recoverSigner(
        bytes32 campaignUid,
        uint256 score,
        bytes memory signature
    ) internal pure returns (address) {
        bytes32 messageHash = keccak256(abi.encodePacked(campaignUid, score));
        bytes32 ethSignedMessageHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );

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

    // === Internal: In-place bubble sort (safe because we no longer rely on index alignment after this) ===
    function _calculateMedian(uint256[] memory scores, uint256 count) internal pure returns (uint256) {
        // Bubble sort (gas-efficient for N ≤ 15)
        for (uint256 i = 0; i < count - 1; i++) {
            for (uint256 j = 0; j < count - i - 1; j++) {
                if (scores[j] > scores[j + 1]) {
                    (scores[j], scores[j + 1]) = (scores[j + 1], scores[j]);
                }
            }
        }
        return scores[count / 2];
    }
}