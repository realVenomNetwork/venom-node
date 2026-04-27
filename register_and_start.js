#!/usr/bin/env node
require('dotenv').config({ quiet: true });
const { ethers } = require('ethers');

const VERSION = "1.0.1";
const VENOM_REGISTRY_ADDRESS = process.env.VENOM_REGISTRY_ADDRESS;
const REQUIRED_ENV = [
  "RPC_URL",
  "DEPLOYER_PRIVATE_KEY",
  "VENOM_REGISTRY_ADDRESS",
  "PILOT_ESCROW_ADDRESS"
];

let p2pNode = null;
let producerHandle = null;
let workerHandle = null;

function validateEnv() {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

async function shutdown(signal) {
  console.log(`\n${signal} received, shutting down VENOM Node...`);
  try {
    if (workerHandle) await workerHandle.close();
    if (producerHandle?.stop) producerHandle.stop();
    if (p2pNode) await p2pNode.stop();
    const { closeQueueResources } = require('./aggregator/queue');
    await closeQueueResources();
  } catch (error) {
    console.error("Shutdown error:", error);
    process.exit(1);
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function main() {
  validateEnv();
  const { startP2PNode } = require('./aggregator/p2p');
  const { startProducer } = require('./aggregator/producer');
  const { startWorker } = require('./aggregator/worker');

  console.log(`Starting VENOM Node v${VERSION}...`);

  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);

  const registry = new ethers.Contract(VENOM_REGISTRY_ADDRESS, [
    "function isActiveOracle(address) view returns (bool)",
    "function registerOracle(string) payable",
    "function MIN_STAKE() view returns (uint256)"
  ], wallet);

  const isRegistered = await registry.isActiveOracle(wallet.address);
  const stakeAmount = await registry.MIN_STAKE();

  if (!isRegistered) {
    console.log("Registering node on-chain...");

    p2pNode = await startP2PNode(wallet);

    const multiaddrs = p2pNode.getMultiaddrs();
    const publicMultiaddr = multiaddrs.find(m => m.toString().includes('/tcp/')) || multiaddrs[0];
    if (!publicMultiaddr) {
      throw new Error("Libp2p started without a public multiaddr");
    }
    const multiaddrStr = publicMultiaddr.toString();

    const tx = await registry.registerOracle(multiaddrStr, { value: stakeAmount });
    await tx.wait();

    console.log(`Registered with real multiaddr: ${multiaddrStr}`);
  } else {
    console.log("Already registered");
    p2pNode = await startP2PNode(wallet);
  }

  console.log("\nStarting Producer, Worker, and P2P mesh...");
  producerHandle = await startProducer();
  workerHandle = await startWorker();

  console.log(`\nVENOM Node v${VERSION} is fully operational.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
