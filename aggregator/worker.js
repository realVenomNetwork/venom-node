// aggregator/worker.js
const { Worker } = require('bullmq');
const { connection, QUEUE_NAME } = require('./queue');
const { ethers } = require('ethers');
const path = require('path');
const MultiRpcProvider = require('../rpc/router');
const { publishSignature } = require('./p2p');

const rootEnvPath = path.join(__dirname, "../.env");
require("dotenv").config({ path: rootEnvPath, quiet: true });

const PILOT_ESCROW_ADDRESS = process.env.PILOT_ESCROW_ADDRESS;
const ML_SERVICE_URL = "http://127.0.0.1:8000/evaluate";

// === MULTI-RPC PROVIDER ===
const rpcUrls = (process.env.RPC_URLS || process.env.RPC_URL || "https://base-sepolia-rpc.publicnode.com").split(",").map(u => u.trim());
const multiProvider = new MultiRpcProvider(rpcUrls);
const provider = multiProvider.getProvider();

const deployerKey = process.env.DEPLOYER_PRIVATE_KEY || process.env.BROADCASTER_PRIVATE_KEY;
if (!deployerKey) throw new Error("Missing DEPLOYER_PRIVATE_KEY in .env");
const wallet = new ethers.Wallet(deployerKey, provider);

const PilotEscrowABI = [
  "function closeCampaign(bytes32,address,uint256,uint256,uint256[],bytes[]) external",
  "function campaigns(bytes32) view returns (uint256 balance, bool closed, bool retired, bool compromised, uint256 lastNonce)"
];

const pilotEscrow = new ethers.Contract(PILOT_ESCROW_ADDRESS, PilotEscrowABI, wallet);

// High-quality payload
const GOOD_PAYLOAD = {
  payload: "**Arguments For Allocating 15% ($360,000):**\n- Strengthens the DAO's public goods reputation and attracts mission-aligned contributors.\n- Creates measurable positive externalities that benefit the broader ecosystem.\n- Provides a clear, time-boxed experiment with defined success metrics.\n\n**Arguments Against Allocating 15% ($360,000):**\n- Reduces the treasury's runway from approximately 4.2 years to 3.6 years, increasing long-term financial risk.\n- Opportunity cost: the same capital could be deployed into yield-bearing strategies.\n- Governance overhead increases as the DAO must design, run, and monitor a new funding process.\n\n**Recommendation:**\nThe DAO should proceed with a **reduced allocation of 8–10%** ($192,000–$240,000) for the first round.",
  reference_answer: "The DAO should carefully weigh the pros and cons of the $2.4M treasury. Pros include strengthening reputation and attracting talent. Cons include reducing the runway and missing out on yield-bearing opportunities."
};

async function scoreWithFastAPI(evalData) {
  const res = await fetch(ML_SERVICE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(evalData)
  });
  return res.json();
}

async function processCampaign(job) {
  const { campaignUid } = job.data;
  console.log(`[Worker] Processing ${campaignUid}`);

  try {
    const campaign = await pilotEscrow.campaigns(campaignUid);
    if (campaign.closed) {
      console.log(`  → Already closed: ${campaignUid}`);
      return;
    }

    // TODO: In real deployment, fetch actual campaign payload from IPFS / off-chain store
    // For v1.0.0 we keep the test payload but log a clear warning
    const evalData = GOOD_PAYLOAD; // Replace this with real fetch in next iteration
    console.warn(`[Worker] Using test payload for ${campaignUid} — replace with real content fetch`);

    const scoreResult = await scoreWithFastAPI(evalData);
    if (!scoreResult.passes_threshold) {
      console.log(`  → Skipped (score ${scoreResult.final_score})`);
      return;
    }

    const scoreInt = Math.floor(scoreResult.final_score * 100);
    const messageHash = ethers.solidityPackedKeccak256(["bytes32", "uint256"], [campaignUid, scoreInt]);
    const signature = await wallet.signMessage(ethers.getBytes(messageHash));

    console.log(`  → Evaluated and signed score ${scoreInt} for ${campaignUid}`);

    await publishSignature(campaignUid, scoreInt, signature);

  } catch (err) {
    console.error(`❌ Failed: ${campaignUid}`, err.message);
    throw err;
  }
}

async function startWorker() {
  const deployerAddress = wallet.address;

  // Make sure P2P node is started in register_and_start.js, so we don't start it here 
  // again unless needed. Worker just publishes via p2p.js which shares the instance.
  
  const worker = new Worker(QUEUE_NAME, processCampaign, {
    connection,
    concurrency: 4
  });

  console.log("🚀 Starting VENOM Worker (BullMQ + MultiRPC)");
  console.log(`   Address: ${deployerAddress} | Concurrency: 4\n`);

  worker.on('failed', (job, err) => console.error(`Job ${job.id} failed:`, err.message));
}

startWorker().catch(console.error);
