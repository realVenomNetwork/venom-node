// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title TitheManager (Worldview-Agnostic Version)
 * @dev Generalized tithing / charitable redirection contract.
 *      Supports multiple presets for different worldviews:
 *      - Christian tithe: 10% (default)
 *      - Muslim Zakat: 2.5%
 *      - Secular / voluntary donation: variable (owner or governance set)
 *      - Jewish Tzedakah: traditionally 10% or more, configurable
 *      - Custom / inter-faith pool
 *
 *      Fully adjustable at runtime. Designed for easy integration with
 *      PilotEscrow.closeCampaign() and future DAO governance.
 *
 *      This version is deliberately faith-agnostic: the contract does not
 *      enforce any religious rule — it simply provides convenient presets
 *      and a clean mechanism to redirect a percentage of value to
 *      designated recipients (EOAs, other contracts, or a council treasury).
 */
contract TitheManager is Ownable {
    // === PRESETS (basis points: 10000 = 100%) ===
    uint256 public constant PRESET_CHRISTIAN_TITHE = 1000;   // 10%
    uint256 public constant PRESET_ZAKAT          = 250;     // 2.5%
    uint256 public constant PRESET_TZEDAKAH       = 1000;    // 10% (common Jewish benchmark)
    uint256 public constant PRESET_SECULAR        = 500;     // 5% example
    uint256 public constant MAX_RECIPIENTS = 50;

    uint256 public titheBps = PRESET_CHRISTIAN_TITHE; // Current active rate

    // Recipients & weighting (same as before, fully flexible)
    address[] public recipients;
    mapping(address => uint256) public sharesBps;
    mapping(address => uint256) private recipientIndexPlusOne;
    mapping(address => uint256) public pendingBalances;
    uint256 public totalSharesBps;

    // Optional: label for current preset (for UI / events)
    string public currentPresetLabel = "christian-tithe-10pct";

    event TitheRateUpdated(uint256 newBps, string presetLabel);
    event RecipientAdded(address indexed recipient, uint256 shareBps);
    event RecipientRemoved(address indexed recipient);
    event TitheDistributed(uint256 totalAmount, uint256 redirectedAmount, address mainRecipient);
    event PaymentQueued(address indexed recipient, uint256 amount);
    event PaymentClaimed(address indexed recipient, uint256 amount);

    constructor() Ownable(msg.sender) {}

    // === PRESET FUNCTIONS (one-call convenience) ===
    function useChristianTithe() external onlyOwner {
        _setRate(PRESET_CHRISTIAN_TITHE, "christian-tithe-10pct");
    }

    function useZakat() external onlyOwner {
        _setRate(PRESET_ZAKAT, "zakat-2.5pct");
    }

    function useTzedakah() external onlyOwner {
        _setRate(PRESET_TZEDAKAH, "tzedakah-10pct");
    }

    function useSecular(uint256 customBps) external onlyOwner {
        require(customBps <= 10000, "Invalid custom rate");
        _setRate(customBps, "secular-custom");
    }

    function setCustomRate(uint256 newBps, string calldata label) external onlyOwner {
        require(newBps <= 10000, "Rate cannot exceed 100%");
        _setRate(newBps, label);
    }

    function _setRate(uint256 newBps, string memory label) internal {
        titheBps = newBps;
        currentPresetLabel = label;
        emit TitheRateUpdated(newBps, label);
    }

    // === RECIPIENT MANAGEMENT ===
    function addRecipient(address recipient, uint256 shareBps) external onlyOwner {
        require(recipient != address(0), "Zero address");
        require(shareBps > 0 && shareBps <= 10000, "Invalid share");

        if (recipientIndexPlusOne[recipient] == 0) {
            require(recipients.length < MAX_RECIPIENTS, "Too many recipients");
            recipients.push(recipient);
            recipientIndexPlusOne[recipient] = recipients.length;
        }
        totalSharesBps = totalSharesBps - sharesBps[recipient] + shareBps;
        sharesBps[recipient] = shareBps;

        emit RecipientAdded(recipient, shareBps);
    }

    function removeRecipient(address recipient) external onlyOwner {
        uint256 indexPlusOne = recipientIndexPlusOne[recipient];
        require(indexPlusOne != 0 && sharesBps[recipient] > 0, "Not a recipient");

        totalSharesBps -= sharesBps[recipient];
        delete sharesBps[recipient];

        uint256 index = indexPlusOne - 1;
        uint256 lastIndex = recipients.length - 1;
        if (index != lastIndex) {
            address lastRecipient = recipients[lastIndex];
            recipients[index] = lastRecipient;
            recipientIndexPlusOne[lastRecipient] = index + 1;
        }
        recipients.pop();
        delete recipientIndexPlusOne[recipient];

        emit RecipientRemoved(recipient);
    }

    function recipientCount() external view returns (uint256) {
        return recipients.length;
    }

    // === CORE DISTRIBUTION (same logic, now used by any worldview) ===
    function distribute(uint256 totalAmount, address mainRecipient) external payable {
        require(msg.value == totalAmount, "Value mismatch");
        require(mainRecipient != address(0), "Invalid main recipient");

        uint256 redirectAmount = (totalAmount * titheBps) / 10000;
        uint256 netAmount = totalAmount - redirectAmount;
        uint256 queuedRedirectAmount = 0;

        if (redirectAmount > 0 && recipients.length > 0 && totalSharesBps > 0) {
            for (uint256 i = 0; i < recipients.length; i++) {
                address r = recipients[i];
                uint256 share = sharesBps[r];
                if (share > 0) {
                    uint256 amt = (redirectAmount * share) / totalSharesBps;
                    if (amt > 0) {
                        _queuePayment(r, amt);
                        queuedRedirectAmount += amt;
                    }
                }
            }
            if (queuedRedirectAmount < redirectAmount) {
                _queuePayment(owner(), redirectAmount - queuedRedirectAmount);
            }
        } else if (redirectAmount > 0) {
            _queuePayment(owner(), redirectAmount);
        }

        if (netAmount > 0) {
            _queuePayment(mainRecipient, netAmount);
        }

        emit TitheDistributed(totalAmount, redirectAmount, mainRecipient);
    }

    function claim() external {
        _claim(payable(msg.sender));
    }

    function claimFor(address payable recipient) external {
        _claim(recipient);
    }

    function _queuePayment(address recipient, uint256 amount) internal {
        pendingBalances[recipient] += amount;
        emit PaymentQueued(recipient, amount);
    }

    function _claim(address payable recipient) internal {
        uint256 amount = pendingBalances[recipient];
        require(amount > 0, "No pending balance");
        pendingBalances[recipient] = 0;

        (bool ok, ) = recipient.call{value: amount}("");
        require(ok, "Claim transfer failed");
        emit PaymentClaimed(recipient, amount);
    }

    receive() external payable {}
}
