// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./MinimalMultiSig.sol";

interface ICouncilRegistry {
    function getBranchTopValidators(bytes32 branchId) external view returns (address[] memory);
    function getBranch(bytes32 branchId) external view returns (string memory name, address[] memory validators);
    function attestationCount(address from, address to) external view returns (uint256);
}

/**
 * @title AgreementFactory
 * @dev Deploys lightweight "Synthetic Collaboration Entities" (MinimalMultiSig contracts)
 * when two worldview branches exhibit sufficient mutual attestation overlap among their top validators.
 *
 * This contract is worldview-agnostic: it relies solely on generalised attestation counts
 * in CouncilRegistry and does not enforce any creed or belief system.
 */
contract AgreementFactory is Ownable {
    // ============ STATE ============
    ICouncilRegistry public councilRegistry;
    address public agreementTemplate;
    uint256 public overlapThreshold = 5000; // 50% default
    uint256 public minAttestationCount = 1;
    uint256 public constant MAX_TOP_VALIDATORS_PER_BRANCH = 20;
    uint256 public agreementCount;
    mapping(uint256 => address) public agreementContracts;
    mapping(bytes32 => mapping(bytes32 => address)) public branchAgreements;
    bool public paused;

    // ============ EVENTS ============
    event AgreementCreated(
        uint256 indexed agreementId,
        bytes32 indexed branchIdA,
        bytes32 indexed branchIdB,
        address agreementContract,
        address[] participants,
        uint256 threshold,
        uint256 overlapBps,
        uint256 creationTimestamp
    );
    event OverlapThresholdUpdated(uint256 newThresholdBps);
    event MinAttestationCountUpdated(uint256 newMin);
    event AgreementTemplateUpdated(address newTemplate);
    event Paused(address account);
    event Unpaused(address account);

    // ============ CONSTRUCTOR ============
    constructor(address _councilRegistry, address _agreementTemplate) Ownable(msg.sender) {
        require(_councilRegistry != address(0), "Invalid CouncilRegistry");
        require(_agreementTemplate != address(0) && _agreementTemplate.code.length > 0, "Invalid template");
        councilRegistry = ICouncilRegistry(_councilRegistry);
        agreementTemplate = _agreementTemplate;
    }

    // ============ MODIFIERS ============
    modifier whenNotPaused() {
        require(!paused, "Paused");
        _;
    }

    // ============ ADMIN FUNCTIONS ============
    function setOverlapThreshold(uint256 _overlapThreshold) external onlyOwner {
        require(_overlapThreshold <= 10000, "Invalid threshold");
        overlapThreshold = _overlapThreshold;
        emit OverlapThresholdUpdated(_overlapThreshold);
    }

    function setMinAttestationCount(uint256 _min) external onlyOwner {
        minAttestationCount = _min;
        emit MinAttestationCountUpdated(_min);
    }

    function setAgreementTemplate(address _template) external onlyOwner {
        require(_template != address(0) && _template.code.length > 0, "Invalid template");
        agreementTemplate = _template;
        emit AgreementTemplateUpdated(_template);
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ============ MAIN FUNCTIONS ============
    function createAgreement(bytes32 branchIdA, bytes32 branchIdB)
        external
        whenNotPaused
        returns (address agreement)
    {
        require(branchIdA != branchIdB, "Same branch");
        _ensureBranchRegistered(branchIdA);
        _ensureBranchRegistered(branchIdB);

        (uint256 overlapBps, address[] memory participants) = computeOverlap(branchIdA, branchIdB);

        require(overlapBps >= overlapThreshold, "Overlap below threshold");
        require(participants.length >= 2, "Need at least 2 mutual validators");

        uint256 threshold = (participants.length / 2) + 1;
        agreement = _deployAgreement(participants, threshold);
        _recordAgreement(agreement, branchIdA, branchIdB, participants, threshold, overlapBps);
    }

    function createAgreementWithParticipants(
        address[] calldata participants,
        uint256 _threshold
    ) external onlyOwner whenNotPaused returns (address agreement) {
        require(participants.length >= 2, "Need at least 2 participants");
        require(_threshold > 0 && _threshold <= participants.length, "Invalid threshold");
        require(_allUnique(participants), "Duplicate participants");

        agreement = _deployAgreement(participants, _threshold);
        bytes32 manualKey = keccak256("manual");
        _recordAgreement(agreement, manualKey, manualKey, participants, _threshold, 0);
    }

    function computeOverlap(bytes32 branchIdA, bytes32 branchIdB)
        public
        view
        returns (uint256 overlapBps, address[] memory participants)
    {
        address[] memory topA = councilRegistry.getBranchTopValidators(branchIdA);
        address[] memory topB = councilRegistry.getBranchTopValidators(branchIdB);
        require(topA.length <= MAX_TOP_VALIDATORS_PER_BRANCH, "Too many validators A");
        require(topB.length <= MAX_TOP_VALIDATORS_PER_BRANCH, "Too many validators B");

        if (topA.length == 0 || topB.length == 0) {
            return (0, new address[](0));
        }

        uint256 mutualPairCount = 0;
        address[] memory candidates = new address[](topA.length + topB.length);
        uint256 candidateCount = 0;

        for (uint256 i = 0; i < topA.length; i++) {
            for (uint256 j = 0; j < topB.length; j++) {
                address va = topA[i];
                address vb = topB[j];

                bool isMutual = councilRegistry.attestationCount(va, vb) >= minAttestationCount ||
                               councilRegistry.attestationCount(vb, va) >= minAttestationCount;

                if (isMutual) {
                    mutualPairCount++;
                    candidateCount = _addUnique(candidates, candidateCount, va);
                    candidateCount = _addUnique(candidates, candidateCount, vb);
                }
            }
        }

        participants = new address[](candidateCount);
        for (uint256 i = 0; i < candidateCount; i++) {
            participants[i] = candidates[i];
        }

        uint256 maxPairs = topA.length * topB.length;
        overlapBps = maxPairs == 0 ? 0 : (mutualPairCount * 10000) / maxPairs;
    }

    // ============ INTERNAL ============
    function _deployAgreement(address[] memory participants, uint256 threshold) internal returns (address) {
        MinimalMultiSig newAgreement = new MinimalMultiSig(participants, threshold);
        return address(newAgreement);
    }

    function _recordAgreement(
        address agreement,
        bytes32 branchIdA,
        bytes32 branchIdB,
        address[] memory participants,
        uint256 threshold,
        uint256 overlapBps
    ) internal {
        agreementCount++;
        agreementContracts[agreementCount] = agreement;
        branchAgreements[branchIdA][branchIdB] = agreement;
        branchAgreements[branchIdB][branchIdA] = agreement;

        emit AgreementCreated(
            agreementCount,
            branchIdA,
            branchIdB,
            agreement,
            participants,
            threshold,
            overlapBps,
            block.timestamp
        );
    }

    function _ensureBranchRegistered(bytes32 branchId) internal view {
        (string memory name, ) = councilRegistry.getBranch(branchId);
        require(bytes(name).length > 0, "Branch not registered");
    }

    function _allUnique(address[] memory arr) internal pure returns (bool) {
        for (uint256 i = 0; i < arr.length; i++) {
            for (uint256 j = i + 1; j < arr.length; j++) {
                if (arr[i] == arr[j]) return false;
            }
        }
        return true;
    }

    function _addUnique(
        address[] memory arr,
        uint256 currentLength,
        address value
    ) internal pure returns (uint256) {
        for (uint256 i = 0; i < currentLength; i++) {
            if (arr[i] == value) {
                return currentLength;
            }
        }
        arr[currentLength] = value;
        return currentLength + 1;
    }

    receive() external payable {
        revert("Not payable");
    }
}
