#!/usr/bin/env node
/**
 * venom-node Entrypoint
 * - Checks registration in VenomRegistry
 * - Auto-registers with stake + multiaddr if needed
 * - Starts Producer + Worker Pool + Libp2p Relayer
 */

const { ethers } = require('ethers');
const { startP2PNode, publishSignature } = require('./aggregator/p2p');
const { startProducer } = require('./aggregator/producer');
const { startWorker } = require('./aggregator/worker');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const VENOM_REGISTRY_ADDRESS = process.env.VENOM_REGISTRY_ADDRESS || "0x0000000000000000000000000000000000000000"; // ← Deployed address
const STAKE_AMOUNT = ethers.parseEther("1.0");

async function main() {
  console.log("🚀 Starting VENOM Node...");

  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);

  const registry = new ethers.Contract(VENOM_REGISTRY_ADDRESS, [
    "function isActiveOracle(address) view returns (bool)",
    "function registerOracle(string) payable"
  ], wallet);

  // 1. Check if already registered
  const isRegistered = await registry.isActiveOracle(wallet.address);

  if (!isRegistered) {
    console.log("📝 Operator not registered. Registering now...");

    // Generate deterministic Libp2p multiaddr (simplified for demo)
    const peerId = await generatePeerId();
    const multiaddr = `/ip4/0.0.0.0/tcp/4001/p2p/${peerId}`;

    const tx = await registry.registerOracle(multiaddr, {
      value: STAKE_AMOUNT
    });
    await tx.wait();

    console.log(`✅ Successfully registered with stake 1 ETH`);
    console.log(`   Multiaddr: ${multiaddr}`);
  } else {
    console.log("✅ Operator already registered");
  }

  // 2. Start all components
  console.log("\n🔄 Starting components...");

  await startP2PNode();
  await startProducer();
  await startWorker();

  console.log("\n🎉 VENOM Node is fully operational!");
  console.log("   - Libp2p Gossip Mesh: Active");
  console.log("   - BullMQ Workers: Running");
  console.log("   - FastAPI ML Service: Connected");
}

async function generatePeerId() {
  // In production: use real libp2p peer ID generation
  // For now: deterministic from private key
  const { keccak256 } = require('ethers');
  const hash = keccak256(process.env.DEPLOYER_PRIVATE_KEY);
  return hash.slice(2, 66); // 64 char peer ID
}

main().catch(console.error);
