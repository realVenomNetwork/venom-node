// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title CreedValidator
 * @dev Modular contract for Christian creed validation of oracles/nodes.
 *      Supports the four core confessions:
 *      1. Jesus is the Son of God
 *      2. Jesus is Messiah (Christ) who came in human form (Incarnation)
 *      3. Jesus is resurrected from the dead
 *      4. Jesus is Lord
 *
 *      Validation uses multi-attestation (e.g. 3-of-5 or 2-of-3 model configurable).
 *      Opt-out supported for nodes that prefer individual/manual review.
 *      Designed to integrate with VenomRegistry (or stand alone).
 *      Future-proof: Attestations are on-chain, reputation can later incorporate ML scoring from eval_engine.
 *      "Two or three witnesses" principle from Scripture (Deut 19:15, Matt 18:16, 2 Cor 13:1).
 */
contract CreedValidator is Ownable {
    // The four creeds (0-indexed for array)
    uint8 public constant CREED_SON_OF_GOD = 0;
    uint8 public constant CREED_MESSIAH_IN_FLESH = 1;
    uint8 public constant CREED_RESURRECTED = 2;
    uint8 public constant CREED_LORD = 3;
    uint8 public constant NUM_CREEDS = 4;

    struct NodeValidation {
        bool isOptedOut;                    // If true, validation not required for this node
        bool isFullyValidated;              // True if attestationCount >= minAttestations
        uint256 attestationCount;
        uint256 resetNonce;
        mapping(address => uint256) countedAttesterEpoch;
        mapping(address => mapping(uint8 => uint256)) attestedCreedEpoch;
        // Optional: store hash of testimony or IPFS CID for off-chain verification
        bytes32[4] creedHashes;             // keccak256 of signed testimony for each creed
    }

    mapping(address => NodeValidation) public nodeValidations;
    uint256 public minAttestations = 3;     // Default: 3 attestations (e.g. 3-of-5 model)
    uint256 public constant MAX_ATTESTATIONS = 10; // Cap for gas safety

    event NodeAttested(address indexed node, address indexed attester, uint8 creedIndex, bytes32 testimonyHash);
    event NodeFullyValidated(address indexed node, uint256 attestationCount);
    event MinAttestationsUpdated(uint256 newMin);
    event NodeOptOutToggled(address indexed node, bool optedOut);

    constructor() Ownable(msg.sender) {}

    /**
     * @dev Set minimum attestations required for full validation (owner only).
     *      Recommended: 3 for small networks, scale with activeOracleCount.
     */
    function setMinAttestations(uint256 newMin) external onlyOwner {
        require(newMin >= 2 && newMin <= MAX_ATTESTATIONS, "Invalid min attestations");
        minAttestations = newMin;
        emit MinAttestationsUpdated(newMin);
    }

    /**
     * @dev Toggle opt-out for a node. Opted-out nodes can still operate but may have reduced weight or require manual approval in higher-level logic.
     */
    function toggleOptOut(address node) external {
        require(msg.sender == node || msg.sender == owner(), "Only node or owner");
        nodeValidations[node].isOptedOut = !nodeValidations[node].isOptedOut;
        emit NodeOptOutToggled(node, nodeValidations[node].isOptedOut);
    }

    /**
     * @dev Attest that a node confesses the creeds (or specific creed).
     *      Caller must be a trusted attester (in full integration: active oracle from VenomRegistry).
     *      Supports per-creed testimony hash for auditability.
     */
    function attestNode(
        address node,
        uint8 creedIndex,
        bytes32 testimonyHash
    ) public {
        require(creedIndex < NUM_CREEDS, "Invalid creed index");
        require(node != address(0) && node != msg.sender, "Invalid node or self-attestation");
        require(!nodeValidations[node].isOptedOut, "Node has opted out of validation");

        NodeValidation storage validation = nodeValidations[node];
        uint256 epoch = validation.resetNonce + 1;
        require(validation.attestedCreedEpoch[msg.sender][creedIndex] != epoch, "Already attested creed");
        validation.attestedCreedEpoch[msg.sender][creedIndex] = epoch;
        if (validation.countedAttesterEpoch[msg.sender] != epoch) {
            validation.countedAttesterEpoch[msg.sender] = epoch;
            validation.attestationCount++;
        }
        validation.creedHashes[creedIndex] = testimonyHash; // Last hash wins per creed; extend if needed

        emit NodeAttested(node, msg.sender, creedIndex, testimonyHash);

        if (!validation.isFullyValidated && validation.attestationCount >= minAttestations) {
            validation.isFullyValidated = true;
            emit NodeFullyValidated(node, validation.attestationCount);
        }
    }

    /**
     * @dev Batch attest multiple creeds for efficiency (gas optimization).
     */
    function batchAttestNode(
        address node,
        uint8[] calldata creedIndices,
        bytes32[] calldata testimonyHashes
    ) external {
        require(creedIndices.length == testimonyHashes.length && creedIndices.length > 0, "Length mismatch");
        require(node != address(0) && node != msg.sender, "Invalid node or self-attestation");
        require(!nodeValidations[node].isOptedOut, "Node has opted out of validation");

        NodeValidation storage validation = nodeValidations[node];
        uint256 epoch = validation.resetNonce + 1;
        if (validation.countedAttesterEpoch[msg.sender] != epoch) {
            validation.countedAttesterEpoch[msg.sender] = epoch;
            validation.attestationCount++;
        }

        for (uint256 i = 0; i < creedIndices.length; i++) {
            uint8 creedIndex = creedIndices[i];
            require(creedIndex < NUM_CREEDS, "Invalid creed index");
            require(validation.attestedCreedEpoch[msg.sender][creedIndex] != epoch, "Already attested creed");
            validation.attestedCreedEpoch[msg.sender][creedIndex] = epoch;
            validation.creedHashes[creedIndex] = testimonyHashes[i];
            emit NodeAttested(node, msg.sender, creedIndex, testimonyHashes[i]);
        }

        if (!validation.isFullyValidated && validation.attestationCount >= minAttestations) {
            validation.isFullyValidated = true;
            emit NodeFullyValidated(node, validation.attestationCount);
        }
    }

    /**
     * @dev Check if a node is validated (or opted out).
     *      In VenomRegistry integration: use this to gate isActiveOracle or score weighting.
     */
    function isValidated(address node) external view returns (bool) {
        NodeValidation storage v = nodeValidations[node];
        return v.isOptedOut || v.isFullyValidated;
    }

    /**
     * @dev Get full validation status for a node.
     */
    function getValidationStatus(address node)
        external
        view
        returns (
            bool optedOut,
            bool fullyValidated,
            uint256 attestationCount,
            bytes32[4] memory creedHashes
        )
    {
        NodeValidation storage v = nodeValidations[node];
        return (v.isOptedOut, v.isFullyValidated, v.attestationCount, v.creedHashes);
    }

    /**
     * @dev Reset validation for a node (owner only, for governance corrections).
     */
    function resetValidation(address node) external onlyOwner {
        NodeValidation storage validation = nodeValidations[node];
        validation.isOptedOut = false;
        validation.isFullyValidated = false;
        validation.attestationCount = 0;
        validation.resetNonce++;
        for (uint256 i = 0; i < NUM_CREEDS; i++) {
            validation.creedHashes[i] = bytes32(0);
        }
    }
}
