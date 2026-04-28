// aggregator/nonceManager.js
const { getConnection } = require('./queue');
const { ethers } = require('ethers');

const NONCE_KEY = 'venom:deployer:nonce';

async function initializeNonce(deployerAddress) {
  const connection = getConnection();
  const currentNonce = await connection.get(NONCE_KEY);
  if (currentNonce !== null) {
    console.log(`[Nonce] Using existing nonce from Redis: ${currentNonce}`);
    return parseInt(currentNonce);
  }

  // First time boot - fetch from chain
  const rpcUrl = process.env.RPC_URL || "https://base-sepolia-rpc.publicnode.com";
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const onChainNonce = await provider.getTransactionCount(deployerAddress, "pending");
  
  await connection.set(NONCE_KEY, onChainNonce);
  console.log(`[Nonce] Initialized nonce from chain: ${onChainNonce}`);
  return onChainNonce;
}

async function getNextNonce() {
  const connection = getConnection();
  // Atomic increment — guarantees unique nonce even with 100+ workers
  const newNonce = await connection.incr(NONCE_KEY);
  // incr returns the value after incrementing, so we subtract 1 to get the actual sequential nonce
  return newNonce - 1;
}

module.exports = {
  initializeNonce,
  getNextNonce
};
