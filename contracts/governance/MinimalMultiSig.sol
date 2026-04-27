// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title MinimalMultiSig
 * @dev A clean, lightweight multi-signature wallet for use as a Synthetic Collaboration Entity.
 * Supports submission, confirmation, and execution with nonce-based replay protection.
 *
 * @notice Submits a new transaction. The first submission sets the nonce-based hash;
 * subsequent signers call confirmTransaction() to add their approval.
 * Once confirmations >= threshold, executeTransaction() can be called.
 * NOTE: Failed executions do not finalize the transaction hash. This allows
 * signers to retry after funding the wallet or fixing a transient target issue.
 */
contract MinimalMultiSig is ReentrancyGuard {
    struct Transaction {
        address target;
        uint256 value;
        bytes data;
        uint256 txNonce;
    }

    address[] public signers;
    mapping(address => bool) public isSigner;
    uint256 public threshold;
    uint256 public nonce;

    mapping(bytes32 => bool) public executed;
    mapping(bytes32 => bool) public submitted;
    mapping(bytes32 => uint256) public confirmations;
    mapping(bytes32 => mapping(address => bool)) public hasConfirmed;
    mapping(bytes32 => Transaction) private transactions;

    event Deposit(address indexed sender, uint256 amount);
    event TransactionSubmitted(bytes32 indexed txHash, address indexed target, uint256 value, bytes data);
    event Confirmation(address indexed signer, bytes32 indexed txHash);
    event Execution(bytes32 indexed txHash);
    event ExecutionFailure(bytes32 indexed txHash);

    modifier onlySigner() {
        require(isSigner[msg.sender], "Not a signer");
        _;
    }

    constructor(address[] memory _signers, uint256 _threshold) {
        require(_signers.length > 0, "No signers");
        require(_threshold > 0 && _threshold <= _signers.length, "Invalid threshold");

        for (uint256 i = 0; i < _signers.length; i++) {
            address signer = _signers[i];
            require(signer != address(0), "Zero address");
            require(!isSigner[signer], "Duplicate signer");
            isSigner[signer] = true;
            signers.push(signer);
        }
        threshold = _threshold;
    }

    receive() external payable {
        emit Deposit(msg.sender, msg.value);
    }

    function submitTransaction(address target, uint256 value, bytes calldata data)
        external
        onlySigner
        returns (bytes32 txHash)
    {
        uint256 txNonce = nonce;
        nonce++;
        txHash = getTransactionHash(target, value, data, txNonce);
        require(!executed[txHash], "Already executed");

        submitted[txHash] = true;
        transactions[txHash] = Transaction({
            target: target,
            value: value,
            data: data,
            txNonce: txNonce
        });
        emit TransactionSubmitted(txHash, target, value, data);
        _addConfirmation(txHash);
    }

    function confirmTransaction(bytes32 txHash) external onlySigner {
        require(submitted[txHash], "Not submitted");
        require(!executed[txHash], "Already executed");
        _addConfirmation(txHash);
    }

    function executeTransaction(bytes32 txHash)
        external
        onlySigner
        nonReentrant
        returns (bytes memory)
    {
        require(submitted[txHash], "Not submitted");
        require(confirmations[txHash] >= threshold, "Not enough confirmations");
        require(!executed[txHash], "Already executed");

        executed[txHash] = true;
        Transaction storage transaction = transactions[txHash];

        (bool success, bytes memory returnData) = transaction.target.call{value: transaction.value}(transaction.data);

        if (!success) {
            executed[txHash] = false;
            emit ExecutionFailure(txHash);
        } else {
            emit Execution(txHash);
        }
        return returnData;
    }

    function getTransactionHash(address target, uint256 value, bytes calldata data, uint256 _nonce)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(target, value, data, _nonce));
    }

    function getTransaction(bytes32 txHash)
        external
        view
        returns (address target, uint256 value, bytes memory data, uint256 txNonce)
    {
        require(submitted[txHash], "Not submitted");
        Transaction storage transaction = transactions[txHash];
        return (transaction.target, transaction.value, transaction.data, transaction.txNonce);
    }

    function _addConfirmation(bytes32 txHash) internal {
        require(!hasConfirmed[txHash][msg.sender], "Already confirmed");
        hasConfirmed[txHash][msg.sender] = true;
        confirmations[txHash]++;
        emit Confirmation(msg.sender, txHash);
    }
}
