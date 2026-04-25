#!/usr/bin/env node
const { ethers } = require('ethers');
const { startP2PNode } = require('./aggregator/p2p');
const { startProducer } = require('./aggregator/producer');
const { startWorker } = require('./aggregator/worker');

const VENOM_REGISTRY_ADDRESS = process.env.VENOM_REGISTRY_ADDRESS;
const STAKE_AMOUNT = ethers.parseEther("1.0");

async function main() {
  console.log("🚀 Starting VENOM Node...");

  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);

  const registry = new ethers.Contract(VENOM_REGISTRY_ADDRESS, [
    "function isActiveOracle(address) view returns (bool)",
    "function registerOracle(string) payable"
  ], wallet);

  const isRegistered = await registry.isActiveOracle(wallet.address);

  if (!isRegistered) {
    console.log("📝 Registering node on-chain...");

    // 1. Start Libp2p FIRST so we get the real multiaddr
    const p2p = await startP2PNode(wallet); // This now returns the libp2p instance

    // 2. Get the actual listening multiaddr
    const multiaddrs = p2p.getMultiaddrs();
    const publicMultiaddr = multiaddrs.find(m => m.toString().includes('/tcp/')) || multiaddrs[0];
    const multiaddrStr = publicMultiaddr.toString();

    // 3. Register with real address
    const tx = await registry.registerOracle(multiaddrStr, { value: STAKE_AMOUNT });
    await tx.wait();

    console.log(`✅ Registered with real multiaddr: ${multiaddrStr}`);
  } else {
    console.log("✅ Already registered");
    await startP2PNode(wallet);
  }

  console.log("\n🔄 Starting Producer, Worker, and P2P mesh...");
  await startProducer();
  await startWorker();

  console.log("\n🎉 VENOM Node v1.0.0 is fully operational!");
}

main().catch(console.error);