// aggregator/producer.js
const { campaignQueue } = require('./queue');
const { ethers } = require('ethers');
const MultiRpcProvider = require('../rpc/router');
const path = require('path');

const rootEnvPath = path.join(__dirname, "../.env");
require("dotenv").config({ path: rootEnvPath, quiet: true });

const PILOT_ESCROW_ADDRESS = process.env.PILOT_ESCROW_ADDRESS;

// === MULTI-RPC PROVIDER ===
const rpcUrls = (process.env.RPC_URLS || process.env.RPC_URL || "https://base-sepolia-rpc.publicnode.com").split(",").map(u => u.trim());
const multiProvider = new MultiRpcProvider(rpcUrls);
const provider = multiProvider.getProvider();

const PilotEscrowABI = [
  "event CampaignFunded(bytes32 indexed campaignUid, address indexed funder, uint256 amount)"
];

const pilotEscrow = new ethers.Contract(PILOT_ESCROW_ADDRESS, PilotEscrowABI, provider);

let lastScannedBlock = null;

async function discoverAndQueueNewCampaigns() {
  try {
    const currentBlock = await multiProvider.getBlockNumber();
    const fromBlock = lastScannedBlock || Math.max(0, currentBlock - 200);
    const toBlock = currentBlock;

    if (toBlock <= fromBlock) return;

    console.log(`[Producer] Scanning blocks ${fromBlock} → ${toBlock}`);

    const events = await pilotEscrow.queryFilter("CampaignFunded", fromBlock, toBlock);

    for (const event of events) {
      const uid = event.args.campaignUid;
      await campaignQueue.add('process-campaign', { campaignUid: uid }, {
        removeOnComplete: true,
        removeOnFail: 100
      });
      console.log(`  → Queued campaign: ${uid}`);
    }

    lastScannedBlock = toBlock + 1;
  } catch (err) {
    console.error("[Producer] Discovery error:", err.message);
  }
}

async function startProducer() {
  console.log("🚀 Starting VENOM Producer (BullMQ + MultiRPC)");
  console.log(`   Contract: ${PILOT_ESCROW_ADDRESS}\n`);
  
  await discoverAndQueueNewCampaigns();
  setInterval(discoverAndQueueNewCampaigns, 30000);
}

startProducer().catch(console.error);
