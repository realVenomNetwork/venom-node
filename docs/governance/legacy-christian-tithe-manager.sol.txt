// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title TitheManager
 * @dev Modular contract for redirecting a configurable tithe (default 10%) 
 *      of campaign bounties or other payments to designated EOAs (tithe recipients).
 *      Designed to integrate with PilotEscrow.closeCampaign() for Biblical tithing principles.
 *      Percentages are in basis points (10000 = 100%) for precision.
 *      Supports weighted distribution among multiple recipients.
 *      Future-proof: Can be called by any contract; owner can update % and recipients.
 *      Gas note: Tithe is calculated on the principal amount (bounty); gas fees are paid separately by the transaction sender.
 */
contract TitheManager is Ownable {
    uint256 public titheBps = 1000; // 10% default (1000 / 10000)
    address[] public titheRecipients;
    mapping(address => uint256) public sharesBps; // Weighted shares in basis points
    uint256 public totalSharesBps;

    event TithePercentageUpdated(uint256 newBps);
    event TitheRecipientAdded(address indexed recipient, uint256 shareBps);
    event TitheRecipientRemoved(address indexed recipient);
    event TitheDistributed(uint256 totalAmount, uint256 titheAmount, address mainRecipient);

    constructor() Ownable(msg.sender) {}

    /**
     * @dev Update the tithe percentage. Callable only by owner.
     * @param newBps New percentage in basis points (e.g. 1000 for 10%, 0 to disable).
     */
    function setTithePercentage(uint256 newBps) external onlyOwner {
        require(newBps <= 10000, "Tithe cannot exceed 100%");
        titheBps = newBps;
        emit TithePercentageUpdated(newBps);
    }

    /**
     * @dev Add or update a tithe recipient with a share (weighted distribution).
     *      Shares are in basis points relative to total.
     */
    function addTitheRecipient(address recipient, uint256 shareBps) external onlyOwner {
        require(recipient != address(0), "Zero address not allowed");
        require(shareBps > 0 && shareBps <= 10000, "Invalid share");

        if (sharesBps[recipient] == 0) {
            titheRecipients.push(recipient);
        }
        totalSharesBps = totalSharesBps - sharesBps[recipient] + shareBps;
        sharesBps[recipient] = shareBps;

        emit TitheRecipientAdded(recipient, shareBps);
    }

    /**
     * @dev Remove a tithe recipient (sets share to 0; array entry remains but skipped in distribution).
     */
    function removeTitheRecipient(address recipient) external onlyOwner {
        require(sharesBps[recipient] > 0, "Recipient not found");
        totalSharesBps -= sharesBps[recipient];
        sharesBps[recipient] = 0;
        emit TitheRecipientRemoved(recipient);
    }

    /**
     * @dev Core distribution function. Called with the full amount (e.g. bounty).
     *      Splits titheBps% among recipients (weighted), sends remainder to mainRecipient.
     *      Must be called with msg.value == totalAmount.
     */
    function distribute(uint256 totalAmount, address mainRecipient) external payable {
        require(msg.value == totalAmount, "ETH value must match totalAmount");
        require(mainRecipient != address(0), "Invalid main recipient");

        uint256 titheAmount = (totalAmount * titheBps) / 10000;
        uint256 netAmount = totalAmount - titheAmount;

        // Distribute tithe (weighted or equal fallback)
        if (titheAmount > 0 && titheRecipients.length > 0 && totalSharesBps > 0) {
            for (uint256 i = 0; i < titheRecipients.length; i++) {
                address r = titheRecipients[i];
                uint256 share = sharesBps[r];
                if (share > 0) {
                    uint256 shareAmount = (titheAmount * share) / totalSharesBps;
                    if (shareAmount > 0) {
                        (bool success, ) = payable(r).call{value: shareAmount}("");
                        require(success, "Tithe transfer to recipient failed");
                    }
                }
            }
        } else if (titheAmount > 0) {
            // Fallback: send tithe to owner if no recipients configured
            (bool success, ) = payable(owner()).call{value: titheAmount}("");
            require(success, "Tithe fallback transfer failed");
        }

        // Send net to main recipient (e.g. campaign funder-designated recipient)
        if (netAmount > 0) {
            (bool success, ) = payable(mainRecipient).call{value: netAmount}("");
            require(success, "Net transfer to main recipient failed");
        }

        emit TitheDistributed(totalAmount, titheAmount, mainRecipient);
    }

    /**
     * @dev Emergency withdraw (only owner) in case of stuck funds.
     */
    function emergencyWithdraw() external onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "No balance");
        (bool success, ) = payable(owner()).call{value: balance}("");
        require(success, "Withdraw failed");
    }

    receive() external payable {}
}
