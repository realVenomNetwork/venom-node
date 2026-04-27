// aggregator/worker.js
// VENOM Node v1.1.0-rc.1 - IPFS fetch fallback, ML scoring, signed score/abstain gossip.

const { Worker } = require('bullmq');
const { getConnection, QUEUE_NAME } = require('./queue');
const { ethers } = require('ethers');
const path = require('path');
const MultiRpcProvider = require('../rpc/router');
const { publishSignature, publishAbstain } = require('./p2p');

const rootEnvPath = path.join(__dirname, "../.env");
require("dotenv").config({ path: rootEnvPath, quiet: true });

const DEFAULT_ML_SERVICE_URL = process.env.NODE_ENV === "production"
  ? "http://ml-service:8000/evaluate"
  : "http://127.0.0.1:8000/evaluate";
const ML_SERVICE_URL = process.env.ML_SERVICE_URL || DEFAULT_ML_SERVICE_URL;
const IPFS_GATEWAYS = (process.env.IPFS_GATEWAYS || "").split(",").map(g => g.trim()).filter(Boolean);
const MAX_PAYLOAD_BYTES = parseInt(process.env.MAX_PAYLOAD_BYTES || "51200", 10);
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || "15000", 10);
const FETCH_FAILURE_PRECEDENCE = ["PayloadTooLarge", "HashMismatch", "NotFound", "Timeout", "FetchFailed"];

const PilotEscrowABI = [
  "function campaigns(bytes32) view returns (address recipient, uint256 bounty, bool closed, uint256 fundedBlock)"
];

const DOMAIN = {
  name: "VENOM PilotEscrow",
  version: "1",
  chainId: null,
  verifyingContract: process.env.PILOT_ESCROW_ADDRESS,
};

const GOOD_PAYLOAD = {
  payload: [
    "**Arguments For Allocating 15% ($360,000):**",
    "- Strengthens the DAO's public goods reputation and attracts mission-aligned contributors.",
    "- Creates measurable positive externalities that benefit the broader ecosystem.",
    "- Provides a clear, time-boxed experiment with defined success metrics.",
    "",
    "**Arguments Against Allocating 15% ($360,000):**",
    "- Reduces the treasury's runway from approximately 4.2 years to 3.6 years, increasing long-term financial risk.",
    "- Opportunity cost: the same capital could be deployed into yield-bearing strategies.",
    "- Governance overhead increases as the DAO must design, run, and monitor a new funding process.",
    "",
    "**Recommendation:**",
    "The DAO should proceed with a reduced allocation of 8-10% ($192,000-$240,000) for the first round."
  ].join("\n"),
  reference_answer: "The DAO should carefully weigh the pros and cons of the $2.4M treasury. Pros include strengthening reputation and attracting talent. Cons include reducing the runway and missing out on yield-bearing opportunities."
};

let runtime = null;
let cachedChainId = null;

function getWorkerRuntime() {
  if (runtime) return runtime;

  const pilotEscrowAddress = process.env.PILOT_ESCROW_ADDRESS;
  if (!pilotEscrowAddress) {
    throw new Error("Missing PILOT_ESCROW_ADDRESS");
  }

  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY || process.env.BROADCASTER_PRIVATE_KEY;
  if (!deployerKey) {
    throw new Error("Missing DEPLOYER_PRIVATE_KEY in .env");
  }

  const rpcUrls = (process.env.RPC_URLS || process.env.RPC_URL || "https://base-sepolia-rpc.publicnode.com")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);

  const multiProvider = new MultiRpcProvider(rpcUrls);
  const provider = multiProvider.getProvider();
  const wallet = new ethers.Wallet(deployerKey, provider);
  const pilotEscrow = new ethers.Contract(pilotEscrowAddress, PilotEscrowABI, wallet);

  runtime = { multiProvider, provider, wallet, pilotEscrow, pilotEscrowAddress };
  return runtime;
}

async function getChainId() {
  if (cachedChainId === null) {
    cachedChainId = (await getWorkerRuntime().provider.getNetwork()).chainId;
  }
  return cachedChainId;
}

function selectFailureReason(failures) {
  if (!failures.length) return "FetchFailed";
  const reasonCounts = {};
  for (const failure of failures) {
    reasonCounts[failure] = (reasonCounts[failure] || 0) + 1;
  }
  return Object.keys(reasonCounts).sort((a, b) => {
    const byCount = reasonCounts[b] - reasonCounts[a];
    if (byCount !== 0) return byCount;
    return FETCH_FAILURE_PRECEDENCE.indexOf(a) - FETCH_FAILURE_PRECEDENCE.indexOf(b);
  })[0];
}

async function fetchFromIpfs(cid) {
  if (!IPFS_GATEWAYS.length) throw new Error("No IPFS gateways configured.");

  const failures = [];

  for (const gateway of IPFS_GATEWAYS) {
    const url = `${gateway}/${cid}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        failures.push(response.status === 404 ? "NotFound" : "FetchFailed");
        continue;
      }

      const contentLength = response.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > MAX_PAYLOAD_BYTES) {
        throw new Error("PayloadTooLarge");
      }

      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD_BYTES) {
        throw new Error("PayloadTooLarge");
      }

      try {
        const data = JSON.parse(text);
        return data.payload ? data : { payload: text, reference_answer: "" };
      } catch {
        return { payload: text, reference_answer: "" };
      }
    } catch (err) {
      clearTimeout(timeout);
      if (err.message === "PayloadTooLarge") throw err;
      failures.push(err.name === "AbortError" ? "Timeout" : "FetchFailed");
    }
  }

  throw new Error(selectFailureReason(failures));
}

async function scoreWithFastAPI(evalData) {
  const res = await fetch(ML_SERVICE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(evalData)
  });
  return res.json();
}

async function publishSignedAbstain(campaignUid, reason) {
  const { wallet, pilotEscrowAddress } = getWorkerRuntime();
  const chainId = await getChainId();
  const domain = { ...DOMAIN, chainId, verifyingContract: pilotEscrowAddress };
  const types = {
    Abstain: [
      { name: "campaignUid", type: "bytes32" },
      { name: "reason", type: "uint8" }
    ]
  };
  const reasonCode = ["Timeout", "PayloadTooLarge", "FetchFailed", "NotFound", "HashMismatch"].indexOf(reason) + 1 || 1;
  const signature = await wallet.signTypedData(domain, types, { campaignUid, reason: reasonCode });
  await publishAbstain(campaignUid, reason, signature);
}

async function publishSignedScore(campaignUid, scoreInt) {
  const { wallet, pilotEscrowAddress } = getWorkerRuntime();
  const chainId = await getChainId();
  const domain = { ...DOMAIN, chainId, verifyingContract: pilotEscrowAddress };
  const types = {
    Score: [
      { name: "campaignUid", type: "bytes32" },
      { name: "score", type: "uint256" },
    ],
  };
  const signature = await wallet.signTypedData(domain, types, { campaignUid, score: scoreInt });
  await publishSignature(campaignUid, scoreInt, signature);
}

async function processCampaign(job) {
  const { campaignUid, cid } = job.data;
  const { pilotEscrow } = getWorkerRuntime();
  console.log(`[Worker] Processing ${campaignUid}`);

  try {
    const campaign = await pilotEscrow.campaigns(campaignUid);
    if (campaign.closed) {
      console.log(`  -> Already closed: ${campaignUid}`);
      return;
    }

    let evalData;
    if (process.env.USE_TEST_PAYLOAD === "true" || !cid) {
      console.warn(`[Worker] Using test payload for ${campaignUid}; replace with real content fetch`);
      evalData = GOOD_PAYLOAD;
    } else {
      try {
        evalData = await fetchFromIpfs(cid);
      } catch (error) {
        const reason = ["Timeout", "PayloadTooLarge", "FetchFailed", "NotFound", "HashMismatch"].includes(error.message)
          ? error.message
          : "FetchFailed";
        console.log(`  -> Fetch failed (${reason}). Publishing signed abstain.`);
        await publishSignedAbstain(campaignUid, reason);
        return;
      }
    }

    const scoreResult = await scoreWithFastAPI(evalData);
    if (!scoreResult.passes_threshold) {
      console.log(`  -> Skipped (score ${scoreResult.final_score})`);
      return;
    }

    const scoreInt = Math.floor(scoreResult.final_score * 100);
    await publishSignedScore(campaignUid, scoreInt);
    console.log(`  -> Evaluated and signed score ${scoreInt} for ${campaignUid}`);
  } catch (err) {
    console.error(`Failed: ${campaignUid}`, err.message);
    throw err;
  }
}

async function startWorker() {
  const { wallet } = getWorkerRuntime();

  const worker = new Worker(QUEUE_NAME, processCampaign, {
    connection: getConnection(),
    concurrency: 4
  });

  console.log("Starting VENOM Worker v1.1.0-rc.1 (BullMQ + signed abstention + IPFS fallback)");
  console.log(`   Address: ${wallet.address} | Concurrency: 4 | Gateways: ${IPFS_GATEWAYS.length} | ML: ${ML_SERVICE_URL}\n`);

  worker.on('failed', (job, err) => console.error(`Job ${job.id} failed:`, err.message));
  return worker;
}

if (require.main === module) {
  startWorker().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  startWorker,
  processCampaign,
  fetchFromIpfs,
  selectFailureReason
};
