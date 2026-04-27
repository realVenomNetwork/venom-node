// aggregator/producer.js
const { getCampaignQueue, getConnection } = require('./queue');
const { ethers } = require('ethers');
const MultiRpcProvider = require('../rpc/router');
const path = require('path');

const rootEnvPath = path.join(__dirname, "../.env");
require("dotenv").config({ path: rootEnvPath, quiet: true });

const PilotEscrowABI = [
  "event CampaignFunded(bytes32 indexed campaignUid, address indexed funder, uint256 amount)"
];

let multiProvider = null;
let pilotEscrow = null;
let lastScannedBlock = null;
let producerInterval = null;
const SCAN_LOOKBACK_BLOCKS = Number(process.env.PRODUCER_SCAN_LOOKBACK_BLOCKS || 200);
const REORG_LOOKBACK_BLOCKS = Number(process.env.PRODUCER_REORG_LOOKBACK_BLOCKS || 10);

function getProducerRuntime() {
  if (multiProvider && pilotEscrow) {
    return { multiProvider, pilotEscrow };
  }

  const pilotEscrowAddress = process.env.PILOT_ESCROW_ADDRESS;
  if (!pilotEscrowAddress) {
    throw new Error("Missing PILOT_ESCROW_ADDRESS");
  }

  const rpcUrls = (process.env.RPC_URLS || process.env.RPC_URL || "https://base-sepolia-rpc.publicnode.com")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);

  multiProvider = new MultiRpcProvider(rpcUrls);
  const provider = multiProvider.getProvider();
  pilotEscrow = new ethers.Contract(pilotEscrowAddress, PilotEscrowABI, provider);
  return { multiProvider, pilotEscrow };
}

function getCursorKey() {
  const address = process.env.PILOT_ESCROW_ADDRESS || "unknown";
  return `venom:producer:lastScannedBlock:${address.toLowerCase()}`;
}

async function loadLastScannedBlock() {
  if (lastScannedBlock !== null) return lastScannedBlock;
  const stored = await getConnection().get(getCursorKey());
  if (stored !== null) {
    lastScannedBlock = Number(stored);
  }
  return lastScannedBlock;
}

async function saveLastScannedBlock(blockNumber) {
  lastScannedBlock = blockNumber;
  await getConnection().set(getCursorKey(), String(blockNumber));
}

async function discoverAndQueueNewCampaigns() {
  try {
    const runtime = getProducerRuntime();
    const currentBlock = await runtime.multiProvider.getBlockNumber();
    const storedCursor = await loadLastScannedBlock();
    const fromBlock = storedCursor === null
      ? Math.max(0, currentBlock - SCAN_LOOKBACK_BLOCKS)
      : Math.max(0, storedCursor - REORG_LOOKBACK_BLOCKS);
    const toBlock = currentBlock;

    if (toBlock < fromBlock) return;

    console.log(`[Producer] Scanning blocks ${fromBlock} -> ${toBlock}`);

    const events = await runtime.pilotEscrow.queryFilter("CampaignFunded", fromBlock, toBlock);

    for (const event of events) {
      const uid = event.args.campaignUid;
      await getCampaignQueue().add('process-campaign', { campaignUid: uid }, {
        jobId: uid,
        removeOnComplete: true,
        removeOnFail: 100
      });
      console.log(`  -> Queued campaign: ${uid}`);
    }

    await saveLastScannedBlock(toBlock + 1);
  } catch (err) {
    console.error("[Producer] Discovery error:", err.message);
  }
}

async function startProducer() {
  console.log("Starting VENOM Producer (BullMQ + MultiRPC)");
  console.log(`   Contract: ${process.env.PILOT_ESCROW_ADDRESS}\n`);

  await discoverAndQueueNewCampaigns();
  producerInterval = setInterval(discoverAndQueueNewCampaigns, 30000);
  return {
    stop() {
      if (producerInterval) {
        clearInterval(producerInterval);
        producerInterval = null;
      }
    }
  };
}

if (require.main === module) {
  startProducer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  startProducer,
  discoverAndQueueNewCampaigns,
  getCursorKey,
  loadLastScannedBlock,
  saveLastScannedBlock
};
