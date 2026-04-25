// aggregator/worker.js
const { Worker } = require('bullmq');
const { connection, QUEUE_NAME } = require('./queue');
const { ethers } = require('ethers');
const path = require('path');
const MultiRpcProvider = require('../rpc/router');
const { publishSignature, publishAbstain } = require('./p2p');

const rootEnvPath = path.join(__dirname, "../.env");
require("dotenv").config({ path: rootEnvPath, quiet: true });

const PILOT_ESCROW_ADDRESS = process.env.PILOT_ESCROW_ADDRESS;
const ML_SERVICE_URL = process.env.ML_SERVICE_URL || "http://127.0.0.1:8000/evaluate";
const IPFS_GATEWAYS = (process.env.IPFS_GATEWAYS || "").split(",").map(g => g.trim()).filter(Boolean);
const MAX_PAYLOAD_BYTES = parseInt(process.env.MAX_PAYLOAD_BYTES || "51200", 10);
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || "15000", 10);

// === MULTI-RPC PROVIDER ===
const rpcUrls = (process.env.RPC_URLS || process.env.RPC_URL || "https://base-sepolia-rpc.publicnode.com").split(",").map(u => u.trim());
const multiProvider = new MultiRpcProvider(rpcUrls);
const provider = multiProvider.getProvider();

const deployerKey = process.env.DEPLOYER_PRIVATE_KEY || process.env.BROADCASTER_PRIVATE_KEY;
if (!deployerKey) throw new Error("Missing DEPLOYER_PRIVATE_KEY in .env");
const wallet = new ethers.Wallet(deployerKey, provider);

const PilotEscrowABI = [
  "function closeCampaign(bytes32,address,uint256,uint256,uint256[],bytes[]) external",
  "function campaigns(bytes32) view returns (address recipient, uint256 bounty, bool closed, uint256 fundedBlock)"
];

const pilotEscrow = new ethers.Contract(PILOT_ESCROW_ADDRESS, PilotEscrowABI, wallet);

// High-quality payload
const GOOD_PAYLOAD = {
  payload: "**Arguments For Allocating 15% ($360,000):**\n- Strengthens the DAO's public goods reputation and attracts mission-aligned contributors.\n- Creates measurable positive externalities that benefit the broader ecosystem.\n- Provides a clear, time-boxed experiment with defined success metrics.\n\n**Arguments Against Allocating 15% ($360,000):**\n- Reduces the treasury's runway from approximately 4.2 years to 3.6 years, increasing long-term financial risk.\n- Opportunity cost: the same capital could be deployed into yield-bearing strategies.\n- Governance overhead increases as the DAO must design, run, and monitor a new funding process.\n\n**Recommendation:**\nThe DAO should proceed with a **reduced allocation of 8–10%** ($192,000–$240,000) for the first round.",
  reference_answer: "The DAO should carefully weigh the pros and cons of the $2.4M treasury. Pros include strengthening reputation and attracting talent. Cons include reducing the runway and missing out on yield-bearing opportunities."
};

async function fetchFromIpfs(cid) {
  if (!IPFS_GATEWAYS.length) throw new Error("No IPFS gateways configured.");
  
  for (const gateway of IPFS_GATEWAYS) {
    const url = `${gateway}/${cid}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      
      if (!response.ok) {
        if (response.status === 404) throw new Error("NotFound");
        throw new Error("FetchFailed");
      }

      const contentLength = response.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > MAX_PAYLOAD_BYTES) {
        throw new Error("PayloadTooLarge");
      }

      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD_BYTES) {
        throw new Error("PayloadTooLarge");
      }

      const data = JSON.parse(text);
      return data;
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === "AbortError" || err.message === "TimeoutError") {
        console.warn(`[Worker] Gateway ${gateway} timed out.`);
        continue;
      }
      if (["NotFound", "PayloadTooLarge", "FetchFailed"].includes(err.message)) {
        throw err;
      }
      console.warn(`[Worker] Gateway ${gateway} failed: ${err.message}`);
    }
  }
  throw new Error("Timeout");
}

async function scoreWithFastAPI(evalData) {
  const res = await fetch(ML_SERVICE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(evalData)
  });
  return res.json();
}

async function processCampaign(job) {
  const { campaignUid, cid } = job.data;
  console.log(`[Worker] Processing ${campaignUid}`);

  try {
    const campaign = await pilotEscrow.campaigns(campaignUid);
    if (campaign.closed) {
      console.log(`  → Already closed: ${campaignUid}`);
      return;
    }

    let evalData;
    if (process.env.USE_TEST_PAYLOAD === "true" || !cid) {
      console.warn(`[Worker] Using test payload for ${campaignUid} — replace with real content fetch`);
      evalData = GOOD_PAYLOAD;
    } else {
      try {
        evalData = await fetchFromIpfs(cid);
      } catch (e) {
        const reason = ["Timeout", "PayloadTooLarge", "FetchFailed", "NotFound", "HashMismatch"].includes(e.message) ? e.message : "FetchFailed";
        console.log(`  → Fetch failed (${reason}). Publishing abstain.`);
        await publishAbstain(campaignUid, reason);
        return;
      }
    }

    const scoreResult = await scoreWithFastAPI(evalData);
    if (!scoreResult.passes_threshold) {
      console.log(`  → Skipped (score ${scoreResult.final_score})`);
      return;
    }

    const scoreInt = Math.floor(scoreResult.final_score * 100);
    const domain = {
      name: "VENOM PilotEscrow",
      version: "1",
      chainId: (await provider.getNetwork()).chainId,
      verifyingContract: PILOT_ESCROW_ADDRESS,
    };

    const types = {
      Score: [
        { name: "campaignUid", type: "bytes32" },
        { name: "score", type: "uint256" },
      ],
    };

    const value = { campaignUid, score: scoreInt };
    const signature = await wallet.signTypedData(domain, types, value);

    console.log(`  → Evaluated and signed score ${scoreInt} for ${campaignUid}`);

    await publishSignature(campaignUid, scoreInt, signature);

  } catch (err) {
    console.error(`❌ Failed: ${campaignUid}`, err.message);
    throw err;
  }
}

async function startWorker() {
  const deployerAddress = wallet.address;

  const worker = new Worker(QUEUE_NAME, processCampaign, {
    connection,
    concurrency: 4
  });

  console.log("🚀 Starting VENOM Worker (BullMQ + MultiRPC)");
  console.log(`   Address: ${deployerAddress} | Concurrency: 4\n`);

  worker.on('failed', (job, err) => console.error(`Job ${job.id} failed:`, err.message));
}

startWorker().catch(console.error);
