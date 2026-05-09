// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./VenomRegistry.sol";

/**
 * @title PilotEscrow
 * @notice Stores testnet campaign bounties and closes campaigns after oracle score quorum.
 * @dev Current v1.1 release candidate verifies EIP-712 score and abstain signatures,
 * applies quorum checks, and returns the funded bounty to the campaign recipient
 * recorded at funding time. Operator bounty payout is not implemented yet.
 */
contract PilotEscrow is Ownable2Step, Pausable, ReentrancyGuard {
    VenomRegistry public immutable registry;

    uint256 private constant MAX_SCORES = 20;
    // === v1.1.0-rc.1 parameters ===
    uint256 public immutable REQUIRED_ORACLES;
    uint256 public immutable SCORE_QUORUM_PCT;          // BFT majority
    uint256 public immutable PARTICIPATION_FLOOR_PCT;   // supermajority of network must have seen the campaign
    uint256 public constant PASS_THRESHOLD = 60;
    uint256 public constant MAX_SCORE = 100;
    uint256 public immutable CAMPAIGN_TIMEOUT_BLOCKS; // ~4h on Base at ~2s blocks
    uint256 public constant CANCEL_FEE_BPS = 100;           // 1% retained on cancel
    uint256 public constant WITHDRAWAL_TIMELOCK = 48 hours;

    // === EIP-712 ===
    string public constant NAME = "VENOM PilotEscrow";
    string public constant VERSION = "1";
    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant SCORE_TYPEHASH =
        keccak256("Score(bytes32 campaignUid,uint256 score)");
    bytes32 public constant ABSTAIN_TYPEHASH =
        keccak256("Abstain(bytes32 campaignUid,uint8 reason)");

    // === Insurance pool: cancel fees + slash residuals accumulate here ===
    uint256 public insurancePool;

    struct WithdrawalRequest {
        uint256 amount;
        uint256 executableAt;
    }

    struct Campaign {
        address recipient;
        uint256 bounty;
        bool closed;
        uint256 fundedBlock;
        string contentUri;
        bytes32 contentHash;
    }
    mapping(bytes32 => Campaign) public campaigns;
    mapping(address => WithdrawalRequest) public pendingInsuranceWithdrawals;

    /// @notice Emitted when a funder creates a campaign bounty.
    event CampaignFunded(bytes32 indexed campaignUid, address indexed funder, uint256 amount, string contentUri, bytes32 contentHash);
    /// @notice Emitted after quorum, median threshold, and transfer all succeed.
    event CampaignClosed(bytes32 indexed campaignUid, address indexed recipient, uint256 bounty, uint256 medianScore);
    /// @notice Emitted when the funder cancels a timed-out campaign.
    event CampaignCancelled(bytes32 indexed campaignUid, address indexed funder, uint256 refund, uint256 fee);
    /// @notice Emitted when cancellation fees are retained by the insurance pool.
    event InsurancePoolDeposit(uint256 amount, string reason);
    /// @notice Emitted when the owner schedules an insurance pool withdrawal.
    event InsuranceWithdrawalScheduled(address indexed recipient, uint256 amount, uint256 executableAt);
    /// @notice Emitted when the owner withdraws from the insurance pool.
    event InsuranceWithdrawalExecuted(address indexed recipient, uint256 amount);
    /// @notice Emitted when the owner cancels a scheduled insurance pool withdrawal.
    event InsuranceWithdrawalCancelled(address indexed recipient);
    /// @notice Emitted when a campaign close reports an oracle score deviation to the registry.
    event DeviationReported(bytes32 indexed campaignUid, address indexed oracle, uint256 submittedScore, uint256 medianScore, uint256 deviation);

    constructor(
        address _registry,
        uint256 _requiredOracles,
        uint256 _scoreQuorumPct,
        uint256 _participationFloorPct,
        uint256 _campaignTimeoutBlocks
    ) Ownable(msg.sender) {
        require(_registry != address(0), "Zero registry");
        require(_requiredOracles >= 1 && _requiredOracles <= MAX_SCORES, "Invalid REQUIRED_ORACLES");
        require(_scoreQuorumPct >= 1 && _scoreQuorumPct <= 100, "Invalid SCORE_QUORUM_PCT");
        require(
            _participationFloorPct >= _scoreQuorumPct && _participationFloorPct <= 100,
            "Invalid PARTICIPATION_FLOOR_PCT"
        );
        require(
            _campaignTimeoutBlocks >= 100 && _campaignTimeoutBlocks <= 50000,
            "Invalid CAMPAIGN_TIMEOUT_BLOCKS"
        );
        registry = VenomRegistry(_registry);
        REQUIRED_ORACLES = _requiredOracles;
        SCORE_QUORUM_PCT = _scoreQuorumPct;
        PARTICIPATION_FLOOR_PCT = _participationFloorPct;
        CAMPAIGN_TIMEOUT_BLOCKS = _campaignTimeoutBlocks;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(
            DOMAIN_TYPEHASH,
            keccak256(bytes(NAME)),
            keccak256(bytes(VERSION)),
            block.chainid,
            address(this)
        ));
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Fund a new campaign and record the funder as the current recipient.
    function fundCampaign(bytes32 campaignUid, string calldata _contentUri, bytes32 _contentHash) external payable whenNotPaused nonReentrant {
        require(campaignUid != bytes32(0), "Invalid campaign");
        require(msg.value > 0, "Bounty must be > 0");
        require(campaigns[campaignUid].recipient == address(0), "Campaign already exists");
        campaigns[campaignUid] = Campaign({
            recipient: msg.sender,
            bounty: msg.value,
            closed: false,
            fundedBlock: block.number,
            contentUri: _contentUri,
            contentHash: _contentHash
        });
        emit CampaignFunded(campaignUid, msg.sender, msg.value, _contentUri, _contentHash);
    }

    /// @notice v1.1 close: validates score and abstain sigs separately, applies three-quorum rule.
    /// @dev Caller-supplied recipient/bounty have been removed from the ABI in v1.1.
    function closeCampaign(
        bytes32 campaignUid,
        uint256[] calldata scores,
        bytes[]   calldata scoreSignatures,
        uint8[]   calldata abstainReasons,
        bytes[]   calldata abstainSignatures
    ) external whenNotPaused nonReentrant {
        Campaign storage campaign = campaigns[campaignUid];

        require(scores.length <= MAX_SCORES, "Too many scores");
        require(abstainReasons.length <= MAX_SCORES, "Too many abstains");
        require(scores.length > 0, "No scores provided");

        require(!campaign.closed, "Campaign already closed");
        require(campaign.recipient != address(0), "Campaign not funded");
        require(scores.length == scoreSignatures.length, "Score length mismatch");
        require(abstainReasons.length == abstainSignatures.length, "Abstain length mismatch");

        uint256 activeCount = registry.activeOracleCount();
        require(activeCount > 0, "No active oracles");
        require(scores.length <= activeCount, "Too many scores");
        require(abstainReasons.length <= activeCount, "Too many abstains");

        // 1. Validate score sigs (de-duped by signer).
        (uint256[] memory validScores, address[] memory validSigners, uint256 validScoreCount)
            = _validateScoreSigs(campaignUid, scores, scoreSignatures);

        // 2. Validate abstain sigs (de-duped against score signers AND against each other).
        uint256 validAbstainCount = _validateAbstainSigs(
            campaignUid, abstainReasons, abstainSignatures, validSigners, validScoreCount
        );

        // 3. Three quorum gates.
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
                emit DeviationReported(campaignUid, validSigners[i], validScores[i], medianScore, deviation);
                registry.reportDeviation(validSigners[i], validScores[i], medianScore);
            }
        }

        // 7. Pay funder-designated recipient.
        (bool ok, ) = payable(campaign.recipient).call{value: campaign.bounty}("");
        require(ok, "Transfer failed");

        emit CampaignClosed(campaignUid, campaign.recipient, campaign.bounty, medianScore);
    }

    /// @notice After CAMPAIGN_TIMEOUT_BLOCKS, the original funder can reclaim bounty minus 1% insurance fee.
    function cancelCampaign(bytes32 campaignUid) external whenNotPaused nonReentrant {
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
            if (scores[i] > MAX_SCORE) continue;
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
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
        (address recovered, ECDSA.RecoverError error, ) = ECDSA.tryRecover(digest, signature);
        if (error != ECDSA.RecoverError.NoError) return address(0);
        return recovered;
    }

    // === Median ===

    function _medianOfCopy(uint256[] memory src, uint256 count) internal pure returns (uint256) {
        require(count > 0, "Empty array");
        require(count <= MAX_SCORES, "Too many scores for median");
        uint256[] memory sorted = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            sorted[i] = src[i];
        }
        for (uint256 i = 1; i < count; i++) {
            uint256 key = sorted[i];
            uint256 j = i;
            while (j > 0 && sorted[j - 1] > key) {
                sorted[j] = sorted[j - 1];
                j--;
            }
            sorted[j] = key;
        }
        return sorted[count / 2];
    }

    /// @notice Schedule accumulated insurance pool withdrawal.
    function scheduleInsuranceWithdrawal(address payable recipient, uint256 amount) external onlyOwner {
        require(recipient != address(0), "Zero address");
        require(amount > 0, "Amount must be positive");
        require(amount <= insurancePool, "Exceeds insurance pool");
        require(pendingInsuranceWithdrawals[recipient].amount == 0, "Withdrawal already scheduled");
        uint256 executableAt = block.timestamp + WITHDRAWAL_TIMELOCK;
        pendingInsuranceWithdrawals[recipient] = WithdrawalRequest({
            amount: amount,
            executableAt: executableAt
        });
        emit InsuranceWithdrawalScheduled(recipient, amount, executableAt);
    }

    /// @notice Cancel a scheduled insurance pool withdrawal.
    function cancelInsuranceWithdrawal(address recipient) external onlyOwner {
        require(pendingInsuranceWithdrawals[recipient].amount > 0, "No scheduled withdrawal");
        delete pendingInsuranceWithdrawals[recipient];
        emit InsuranceWithdrawalCancelled(recipient);
    }

    /// @notice Execute a scheduled insurance pool withdrawal after the timelock.
    function withdrawInsurancePool(address payable recipient, uint256 amount) external onlyOwner nonReentrant {
        WithdrawalRequest memory request = pendingInsuranceWithdrawals[recipient];
        require(request.amount > 0, "No scheduled withdrawal");
        require(request.amount == amount, "Amount mismatch");
        require(block.timestamp >= request.executableAt, "Withdrawal timelock active");
        require(amount <= insurancePool, "Exceeds insurance pool");
        delete pendingInsuranceWithdrawals[recipient];
        insurancePool -= amount;
        (bool ok,) = recipient.call{value: amount}("");
        require(ok, "Transfer failed");
        emit InsuranceWithdrawalExecuted(recipient, amount);
    }
}
