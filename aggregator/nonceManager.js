// aggregator/nonceManager.js
const { getConnection } = require('./queue');
const { ethers } = require('ethers');
const path = require('path');

const rootEnvPath = path.join(__dirname, "../.env");
require("dotenv").config({ path: rootEnvPath, quiet: true });

const NONCE_KEY = 'venom:deployer:nonce';
let pendingCount = 0;

async function initializeNonce(deployerAddress, provider) {
  const connection = getConnection();
  const currentNonce = await connection.get(NONCE_KEY);
  if (currentNonce !== null) {
    console.log(`[Nonce] Using existing nonce from Redis: ${currentNonce}`);
    return parseInt(currentNonce);
  }

  // First time boot - fetch from chain, excluding pending tx count
  const onChainNonce = await provider.getTransactionCount(deployerAddress, "latest");

  await connection.set(NONCE_KEY, onChainNonce);
  console.log(`[Nonce] Initialized nonce from chain: ${onChainNonce}`);
  return onChainNonce;
}

async function getNextNonce() {
  const connection = getConnection();
  // Use simple increment for now; proper nonce management should use ethers' internal mechanism
  // This serves as a basic coordination mechanism but should be replaced with proper tx management
  const result = await connection.incr(NONCE_KEY);
  return result - 1;
}

async function resetNonce(newNonce) {
  await getConnection().set(NONCE_KEY, newNonce);
}

module.exports = { initializeNonce, getNextNonce, resetNonce };
