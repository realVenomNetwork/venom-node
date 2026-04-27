// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./VenomRegistry.sol";

/**
 * @title PilotEscrow
 * @notice Stores testnet campaign bounties and closes campaigns after oracle score quorum.
 * @dev Current v1.1 release candidate verifies EIP-712 score and abstain signatures,
 * applies quorum checks, and returns the funded bounty to the campaign recipient
 * recorded at funding time. Operator bounty payout is not implemented yet.
 */
contract PilotEscrow is Ownable {
    VenomRegistry public immutable registry;

    // === v1.1.0-rc.1 parameters ===
    uint256 public constant REQUIRED_ORACLES = 5;
    uint256 public constant SCORE_QUORUM_PCT = 50;          // BFT majority
    uint256 public constant PARTICIPATION_FLOOR_PCT = 67;   // supermajority of network must have seen the campaign
    uint256 public constant PASS_THRESHOLD = 60;
    uint256 public constant CAMPAIGN_TIMEOUT_BLOCKS = 7200; // ~4h on Base at ~2s blocks
    uint256 public constant CANCEL_FEE_BPS = 100;           // 1% retained on cancel

    // === EIP-712 ===
    string public constant NAME = "VENOM PilotEscrow";
    string public constant VERSION = "1";
    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant SCORE_TYPEHASH =
        keccak256("Score(bytes32 campaignUid,uint256 score)");
    bytes32 public constant ABSTAIN_TYPEHASH =
        keccak256("Abstain(bytes32 campaignUid,uint8 reason)");
    bytes32 public immutable DOMAIN_SEPARATOR;

    // === Insurance pool: cancel fees + slash residuals accumulate here ===
    uint256 public insurancePool;

    struct Campaign {
        address recipient;
        uint256 bounty;
        bool closed;
        uint256 fundedBlock;
    }
    mapping(bytes32 => Campaign) public campaigns;

    /// @notice Emitted when a funder creates a campaign bounty.
    event CampaignFunded(bytes32 indexed campaignUid, address indexed funder, uint256 amount);
    /// @notice Emitted after quorum, median threshold, and transfer all succeed.
    event CampaignClosed(bytes32 indexed campaignUid, address indexed recipient, uint256 bounty, uint256 medianScore);
    /// @notice Emitted when the funder cancels a timed-out campaign.
    event CampaignCancelled(bytes32 indexed campaignUid, address indexed funder, uint256 refund, uint256 fee);
    /// @notice Emitted when cancellation fees are retained by the insurance pool.
    event InsurancePoolDeposit(uint256 amount, string reason);

    constructor(address _registry) Ownable(msg.sender) {
        registry = VenomRegistry(_registry);
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            DOMAIN_TYPEHASH,
            keccak256(bytes(NAME)),
            keccak256(bytes(VERSION)),
            block.chainid,
            address(this)
        ));
    }

    /// @notice Fund a new campaign and record the funder as the current recipient.
    function fundCampaign(bytes32 campaignUid) external payable {
        require(msg.value > 0, "Bounty must be > 0");
        require(campaigns[campaignUid].recipient == address(0), "Campaign already exists");
        campaigns[campaignUid] = Campaign({
            recipient: msg.sender,
            bounty: msg.value,
            closed: false,
            fundedBlock: block.number
        });
        emit CampaignFunded(campaignUid, msg.sender, msg.value);
    }

    /// @notice v1.1 close: validates score and abstain sigs separately, applies three-quorum rule.
    /// @dev Caller-supplied recipient/bounty have been removed from the ABI in v1.1.
    function closeCampaign(
        bytes32 campaignUid,
        uint256[] calldata scores,
        bytes[]   calldata scoreSignatures,
        uint8[]   calldata abstainReasons,
        bytes[]   calldata abstainSignatures
    ) external {
        Campaign storage campaign = campaigns[campaignUid];
        require(!campaign.closed, "Campaign already closed");
        require(campaign.recipient != address(0), "Campaign not funded");
        require(scores.length == scoreSignatures.length, "Score length mismatch");
        require(abstainReasons.length == abstainSignatures.length, "Abstain length mismatch");

        // 1. Validate score sigs (de-duped by signer).
        (uint256[] memory validScores, address[] memory validSigners, uint256 validScoreCount)
            = _validateScoreSigs(campaignUid, scores, scoreSignatures);

        // 2. Validate abstain sigs (de-duped against score signers AND against each other).
        uint256 validAbstainCount = _validateAbstainSigs(
            campaignUid, abstainReasons, abstainSignatures, validSigners, validScoreCount
        );

        // 3. Three quorum gates.
        uint256 activeCount = registry.activeOracleCount();
        require(activeCount > 0, "No active oracles");
        require(validScoreCount >= REQUIRED_ORACLES, "Below absolute score floor");
        require(validScoreCount * 100 >= activeCount * SCORE_QUORUM_PCT,
                "Below score quorum");
        require((validScoreCount + validAbstainCount) * 100 >= activeCount * PARTICIPATION_FLOOR_PCT,
                "Below participation floor");

        // 4. Median + threshold.
        uint256 medianScore = _medianOfCopy(validScores, validScoreCount);
        require(medianScore >= PASS_THRESHOLD, "Median below threshold");

        // 5. Effects before interactions.
        campaign.closed = true;

        // 6. Slashing — only on score deviations. Abstentions are never slashing-eligible.
        uint256 maxDeviation = registry.MAX_DEVIATION();
        for (uint256 i = 0; i < validScoreCount; i++) {
            uint256 deviation = validScores[i] > medianScore
                ? validScores[i] - medianScore
                : medianScore - validScores[i];
            if (deviation > maxDeviation) {
                registry.reportDeviation(validSigners[i], validScores[i], medianScore);
            }
        }

        // 7. Pay funder-designated recipient.
        (bool ok, ) = payable(campaign.recipient).call{value: campaign.bounty}("");
        require(ok, "Transfer failed");

        emit CampaignClosed(campaignUid, campaign.recipient, campaign.bounty, medianScore);
    }

    /// @notice After CAMPAIGN_TIMEOUT_BLOCKS, the original funder can reclaim bounty minus 1% insurance fee.
    function cancelCampaign(bytes32 campaignUid) external {
        Campaign storage campaign = campaigns[campaignUid];
        require(!campaign.closed, "Already closed");
        require(campaign.recipient == msg.sender, "Not funder");
        require(block.number >= campaign.fundedBlock + CAMPAIGN_TIMEOUT_BLOCKS, "Timeout not reached");

        uint256 fee = (campaign.bounty * CANCEL_FEE_BPS) / 10000;
        uint256 refund = campaign.bounty - fee;
        campaign.closed = true;
        insurancePool += fee;

        (bool ok, ) = payable(msg.sender).call{value: refund}("");
        require(ok, "Refund failed");

        emit CampaignCancelled(campaignUid, msg.sender, refund, fee);
        if (fee > 0) emit InsurancePoolDeposit(fee, "cancellation");
    }

    // === Internal: signature validation ===

    function _validateScoreSigs(
        bytes32 campaignUid,
        uint256[] calldata scores,
        bytes[] calldata signatures
    ) internal view returns (uint256[] memory validScores, address[] memory validSigners, uint256 count) {
        validScores = new uint256[](scores.length);
        validSigners = new address[](scores.length);
        for (uint256 i = 0; i < scores.length; i++) {
            address signer = _recoverScoreSigner(campaignUid, scores[i], signatures[i]);
            if (signer == address(0)) continue;
            if (!registry.isActiveOracle(signer)) continue;
            if (_contains(validSigners, count, signer)) continue;  // dedup by signer
            validScores[count] = scores[i];
            validSigners[count] = signer;
            count++;
        }
    }

    function _validateAbstainSigs(
        bytes32 campaignUid,
        uint8[] calldata reasons,
        bytes[] calldata signatures,
        address[] memory scoreSigners,
        uint256 scoreSignerCount
    ) internal view returns (uint256 count) {
        address[] memory seen = new address[](reasons.length);
        for (uint256 i = 0; i < reasons.length; i++) {
            address signer = _recoverAbstainSigner(campaignUid, reasons[i], signatures[i]);
            if (signer == address(0)) continue;
            if (!registry.isActiveOracle(signer)) continue;
            if (_contains(scoreSigners, scoreSignerCount, signer)) continue;  // can't both score and abstain
            if (_contains(seen, count, signer)) continue;
            seen[count] = signer;
            count++;
        }
    }

    function _contains(address[] memory arr, uint256 len, address target) internal pure returns (bool) {
        for (uint256 i = 0; i < len; i++) if (arr[i] == target) return true;
        return false;
    }

    // === EIP-712 recovery ===

    function _recoverScoreSigner(bytes32 campaignUid, uint256 score, bytes memory signature)
        internal view returns (address)
    {
        bytes32 structHash = keccak256(abi.encode(SCORE_TYPEHASH, campaignUid, score));
        return _recoverFromStructHash(structHash, signature);
    }

    function _recoverAbstainSigner(bytes32 campaignUid, uint8 reason, bytes memory signature)
        internal view returns (address)
    {
        bytes32 structHash = keccak256(abi.encode(ABSTAIN_TYPEHASH, campaignUid, reason));
        return _recoverFromStructHash(structHash, signature);
    }

    function _recoverFromStructHash(bytes32 structHash, bytes memory signature) internal view returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        if (v < 27) v += 27;
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        return ecrecover(digest, v, r, s);
    }

    // === Median ===

    function _medianOfCopy(uint256[] memory src, uint256 count) internal pure returns (uint256) {
        // Bubble sort is acceptable here because REQUIRED_ORACLES keeps the scoring set small.
        uint256[] memory a = new uint256[](count);
        for (uint256 i = 0; i < count; i++) a[i] = src[i];
        for (uint256 i = 0; i < count - 1; i++) {
            for (uint256 j = 0; j < count - i - 1; j++) {
                if (a[j] > a[j + 1]) (a[j], a[j + 1]) = (a[j + 1], a[j]);
            }
        }
        return a[count / 2];
    }
}
