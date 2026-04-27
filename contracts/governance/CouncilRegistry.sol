// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title CouncilRegistry (Worldview-Agnostic Inter-Branch Council)
 * @dev The central contract for a pluralistic, rotating validator council.
 *
 * Core ideas (designed to be valid regardless of worldview):
 * - Worldview "Branches" (christian, jewish, muslim, secular, agnostic, etc.)
 * - Each branch maintains its own list of trusted validators.
 * - Trust is earned via mutual attestations + merit metrics (evaluations completed,
 *   low slashing rate, stake weight, uptime — these metrics live in VenomRegistry).
 * - Rotating "Top-N" per branch (default 3) form the active council slice.
 * - Cross-branch "Agreements": when top validators from two (or more) branches
 *   show high mutual attestation overlap, they can create lightweight
 *   "Synthetic Collaboration Entities" (simple multi-sig or custom Agreement contracts).
 *
 * This structure allows:
 * - Faith-specific branches to keep their internal 2-3 witness rules.
 * - Atheist/agnostic/secular branches to participate on equal footing using
 *   purely meritocratic + attestation-based trust.
 * - Global inter-branch collaboration without forcing any single worldview.
 *
 * Consolidated into the main project under contracts/governance/CouncilRegistry.sol.
 */
contract CouncilRegistry is Ownable {
    struct Branch {
        string name;                    // e.g. "christian", "jewish", "secular"
        address[] validators;
        mapping(address => bool) isValidator;
        uint256 trustScore;             // aggregate from attestations + merit
    }

    mapping(bytes32 => Branch) public branches; // branchId = keccak256(name)
    bytes32[] public branchList;

    // Global rotating council (top N from each major branch)
    uint256 public councilSizePerBranch = 3;
    address[] public currentCouncil;

    // Attestation tracking (generalized, not creed-specific)
    mapping(address => mapping(address => uint256)) public attestationCount; // from -> to
    mapping(address => uint256) public totalAttestationsReceived;

    // Per-branch top validators (fed by off-chain process / owner)
    mapping(bytes32 => address[]) public branchTopValidators;

    event BranchRegistered(bytes32 indexed branchId, string name);
    event ValidatorAdded(bytes32 indexed branchId, address indexed validator);
    event ValidatorRemoved(bytes32 indexed branchId, address indexed validator);
    event AttestationGiven(address indexed from, address indexed to, uint256 newCount);
    event CouncilRotated(address[] newCouncil);
    event BranchTopValidatorsUpdated(bytes32 indexed branchId, address[] validators);

    constructor() Ownable(msg.sender) {}

    // === BRANCH MANAGEMENT ===
    function registerBranch(string calldata name) external onlyOwner {
        bytes32 branchId = keccak256(abi.encodePacked(name));
        require(branches[branchId].validators.length == 0, "Branch already exists");

        branches[branchId].name = name;
        branchList.push(branchId);
        emit BranchRegistered(branchId, name);
    }

    function addValidatorToBranch(bytes32 branchId, address validator) external onlyOwner {
        require(bytes(branches[branchId].name).length > 0, "Branch not registered");
        require(validator != address(0), "Zero address");
        require(!branches[branchId].isValidator[validator], "Already in branch");

        branches[branchId].validators.push(validator);
        branches[branchId].isValidator[validator] = true;
        emit ValidatorAdded(branchId, validator);
    }

    function removeValidatorFromBranch(bytes32 branchId, address validator) external onlyOwner {
        require(branches[branchId].isValidator[validator], "Not in branch");
        address[] storage validators = branches[branchId].validators;
        for (uint256 i = 0; i < validators.length; i++) {
            if (validators[i] == validator) {
                validators[i] = validators[validators.length - 1];
                validators.pop();
                break;
            }
        }
        branches[branchId].isValidator[validator] = false;
        emit ValidatorRemoved(branchId, validator);
    }

    // === ATTESTATION (core trust primitive — worldview agnostic) ===
    function attestTrust(address toValidator) external {
        require(toValidator != msg.sender, "Cannot attest self");
        attestationCount[msg.sender][toValidator] += 1;
        totalAttestationsReceived[toValidator] += 1;
        emit AttestationGiven(msg.sender, toValidator, attestationCount[msg.sender][toValidator]);
    }

    // === ROTATING COUNCIL (merit + attestation based) ===
    function rotateCouncil() external onlyOwner {
        emit CouncilRotated(currentCouncil);
    }

    function setCurrentCouncil(address[] calldata newCouncil) external onlyOwner {
        currentCouncil = newCouncil;
        emit CouncilRotated(newCouncil);
    }

    // === TOP VALIDATORS PER BRANCH (for AgreementFactory) ===
    function setBranchTopValidators(bytes32 branchId, address[] calldata validators) external onlyOwner {
        require(bytes(branches[branchId].name).length > 0, "Branch not registered");
        branchTopValidators[branchId] = validators;
        emit BranchTopValidatorsUpdated(branchId, validators);
    }

    function getBranchTopValidators(bytes32 branchId) external view returns (address[] memory) {
        return branchTopValidators[branchId];
    }

    // === VIEW HELPERS ===
    function getBranchValidators(bytes32 branchId) external view returns (address[] memory) {
        return branches[branchId].validators;
    }

    function getCurrentCouncil() external view returns (address[] memory) {
        return currentCouncil;
    }

    function getTrustScore(address validator) external view returns (uint256) {
        return totalAttestationsReceived[validator];
    }

    // === BRANCH GETTER (for AgreementFactory) ===
    function getBranch(bytes32 branchId) external view returns (string memory name, address[] memory validators) {
        Branch storage b = branches[branchId];
        return (b.name, b.validators);
    }
}
