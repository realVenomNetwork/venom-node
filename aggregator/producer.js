// aggregator/producer.js
const { getCampaignQueue, getConnection } = require('./queue');
const { ethers } = require('ethers');
const MultiRpcProvider = require('../rpc/router');
const path = require('path');
const { recordDashboardEvent } = require('../src/dashboard/quorum-replay');

const rootEnvPath = path.join(__dirname, "../.env");
require("dotenv").config({ path: rootEnvPath, quiet: true });

const PilotEscrowABI = [
  "event CampaignFunded(bytes32 indexed campaignUid, address indexed funder, uint256 amount, string contentUri, bytes32 contentHash)"
];

let multiProvider = null;
let pilotEscrow = null;
let lastScannedBlock = null;
let producerInterval = null;
const SCAN_LOOKBACK_BLOCKS = Number(process.env.PRODUCER_SCAN_LOOKBACK_BLOCKS || 10000);
const REORG_LOOKBACK_BLOCKS = Number(process.env.PRODUCER_REORG_LOOKBACK_BLOCKS || 10);
const SCAN_CHUNK_BLOCKS = Number(process.env.PRODUCER_SCAN_CHUNK_BLOCKS || 1000);
const CAMPAIGN_QUEUE_TTL = 3600; // 1 hour

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
  await getConnection().set(getCursorKey(), String(blockNumber), 'EX', 86400);
}

function isBlockRangeError(error) {
  const text = [
    error?.message,
    error?.shortMessage,
    error?.info?.error?.message,
    error?.error?.message
  ].filter(Boolean).join(" ").toLowerCase();

  return text.includes("block range") ||
    text.includes("too many results") ||
    text.includes("query returned more than") ||
    text.includes("response size exceeded") ||
    text.includes("limit exceeded");
}

async function queryCampaignFundedEvents(runtime, fromBlock, toBlock, chunkSize = SCAN_CHUNK_BLOCKS) {
  const events = [];
  let start = fromBlock;

  while (start <= toBlock) {
    const end = Math.min(toBlock, start + Math.max(1, chunkSize) - 1);
    try {
      const chunk = await runtime.pilotEscrow.queryFilter("CampaignFunded", start, end);
      events.push(...chunk);
      start = end + 1;
    } catch (error) {
      const span = end - start + 1;
      if (span > 1 && isBlockRangeError(error)) {
        const smallerChunk = Math.max(1, Math.floor(span / 2));
        console.warn(`[Producer] RPC rejected ${span}-block log range; retrying in ${smallerChunk}-block chunks`);
        events.push(...await queryCampaignFundedEvents(runtime, start, end, smallerChunk));
        start = end + 1;
        continue;
      }
      throw error;
    }
  }

  return events;
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

    const events = await queryCampaignFundedEvents(runtime, fromBlock, toBlock);

    for (const event of events) {
      const uid = event.args.campaignUid;
      const contentUri = event.args.contentUri;
      const contentHash = event.args.contentHash;
      const campaignKey = `venom:campaign:queued:${uid.toLowerCase()}`;

      const exists = await getConnection().exists(campaignKey);
      if (exists) {
        console.log(`  -> Skipping already queued campaign: ${uid}`);
        continue;
      }

      // Queue first (BullMQ jobId:uid provides idempotency), then set cache flag
      await getCampaignQueue().add('process-campaign', {
        campaignUid: uid,
        cid: contentUri,
        contentHash: contentHash
      }, {
        jobId: uid,
        removeOnComplete: true,
        removeOnFail: 100
      });

      await getConnection().set(campaignKey, "1", 'EX', CAMPAIGN_QUEUE_TTL);

      recordDashboardEvent({
        type: "campaign_observed",
        campaignUid: uid,
        source: "producer",
        message: "CampaignFunded observed by this node."
      }).catch((error) => {
        console.warn(`[Dashboard] Failed to record campaign observation: ${error.message}`);
      });
      console.log(`  -> Queued campaign: ${uid} (cid: ${contentUri || 'none'})`);
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
  saveLastScannedBlock,
  queryCampaignFundedEvents,
  isBlockRangeError
};
