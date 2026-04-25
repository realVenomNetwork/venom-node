// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./VenomRegistry.sol";

contract PilotEscrow is Ownable {
    VenomRegistry public immutable registry;

    uint256 public constant REQUIRED_ORACLES = 5;
    uint256 public constant PASS_THRESHOLD = 60;
    uint256 public constant MAX_DEVIATION = 25; // 25 points = 25%

    // EIP-712
    string public constant NAME = "VENOM PilotEscrow";
    string public constant VERSION = "1";
    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant SCORE_TYPEHASH =
        keccak256("Score(bytes32 campaignUid,uint256 score)");
    bytes32 public immutable DOMAIN_SEPARATOR;

    struct Campaign {
        address recipient;
        uint256 bounty;
        bool closed;
        uint256 fundedBlock;
    }

    mapping(bytes32 => Campaign) public campaigns;

    event CampaignFunded(bytes32 indexed campaignUid, address indexed funder, uint256 amount);
    event CampaignClosed(bytes32 indexed campaignUid, address indexed recipient, uint256 bounty, uint256 medianScore);

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

    function closeCampaign(
        bytes32 campaignUid,
        address /* recipient — ignored; uses stored value */,
        uint256 /* bounty — ignored; uses stored value */,
        uint256 /* payloadNonce — reserved */,
        uint256[] calldata scores,
        bytes[] calldata signatures
    ) external {
        Campaign storage campaign = campaigns[campaignUid];
        require(!campaign.closed, "Campaign already closed");
        require(campaign.recipient != address(0), "Campaign not funded");
        require(scores.length == signatures.length, "Length mismatch");
        require(scores.length >= REQUIRED_ORACLES, "Not enough submissions");

        // 1. Validate + recover signers; build aligned (score, signer) pairs
        uint256 validCount = 0;
        uint256[] memory validScores = new uint256[](scores.length);
        address[] memory validSigners = new address[](scores.length);

        for (uint256 i = 0; i < scores.length; i++) {
            address signer = _recoverSigner(campaignUid, scores[i], signatures[i]);
            if (signer != address(0) && registry.isActiveOracle(signer)) {
                validScores[validCount] = scores[i];
                validSigners[validCount] = signer;
                validCount++;
            }
        }
        require(validCount >= REQUIRED_ORACLES, "Not enough valid oracles");

        // 2. Median on a COPY so alignment is preserved for slashing
        uint256 medianScore = _medianOfCopy(validScores, validCount);

        // 3. Threshold gate
        require(medianScore >= PASS_THRESHOLD, "Median below threshold");

        // 4. Effects before interactions
        campaign.closed = true;

        // 5. Slashing — pairs remain aligned
        for (uint256 i = 0; i < validCount; i++) {
            uint256 deviation = validScores[i] > medianScore
                ? validScores[i] - medianScore
                : medianScore - validScores[i];

            if (deviation > MAX_DEVIATION) {
                registry.reportDeviation(validSigners[i], validScores[i], medianScore);
            }
        }

        // 6. Pay using stored values
        (bool ok, ) = payable(campaign.recipient).call{value: campaign.bounty}("");
        require(ok, "Transfer failed");

        emit CampaignClosed(campaignUid, campaign.recipient, campaign.bounty, medianScore);
    }

    // EIP-712 recovery
    function _recoverSigner(bytes32 campaignUid, uint256 score, bytes memory signature)
        internal
        view
        returns (address)
    {
        bytes32 structHash = keccak256(abi.encode(SCORE_TYPEHASH, campaignUid, score));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

        (bytes32 r, bytes32 s, uint8 v) = _splitSignature(signature);

        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return address(0);
        }
        return ecrecover(digest, v, r, s);
    }

    function _splitSignature(bytes memory sig)
        internal
        pure
        returns (bytes32 r, bytes32 s, uint8 v)
    {
        require(sig.length == 65, "Invalid signature length");
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        if (v < 27) v += 27;
    }

    function _medianOfCopy(uint256[] memory src, uint256 count)
        internal
        pure
        returns (uint256)
    {
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
