// aggregator/worker.js
// VENOM Node v1.1.0-rc.1 - IPFS fetch fallback, ML scoring, signed score/abstain gossip.

const { Worker } = require('bullmq');
const { getConnection, QUEUE_NAME } = require('./queue');
const { ethers } = require('ethers');
const path = require('path');
const MultiRpcProvider = require('../rpc/router');
const { publishSignature, publishAbstain } = require('./p2p');
const TEST_PAYLOAD = require('../data/fixtures/good-payload.json');
const { assertRuntimeModeConfig } = require('../src/config/runtime-mode');
const { recordDashboardEvent } = require('../src/dashboard/quorum-replay');

const rootEnvPath = path.join(__dirname, "../.env");
require("dotenv").config({ path: rootEnvPath, quiet: true });

const DEFAULT_ML_SERVICE_URL = process.env.NODE_ENV === "production"
  ? "http://ml-service:8000/evaluate"
  : "http://127.0.0.1:8000/evaluate";
const ML_SERVICE_URL = process.env.ML_SERVICE_URL || DEFAULT_ML_SERVICE_URL;
const IPFS_GATEWAYS = (process.env.IPFS_GATEWAYS || "").split(",").map(g => g.trim()).filter(Boolean);
const MAX_PAYLOAD_BYTES = parseInt(process.env.MAX_PAYLOAD_BYTES || "51200", 10);
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || "15000", 10);
const ML_TIMEOUT_MS = parseInt(process.env.ML_TIMEOUT_MS || "30000", 10);
const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || "4", 10);
const PROCESSED_CAMPAIGN_TTL_SECONDS = parseInt(process.env.PROCESSED_CAMPAIGN_TTL_SECONDS || "86400", 10);
const FETCH_FAILURE_PRECEDENCE = ["PayloadTooLarge", "HashMismatch", "NotFound", "Timeout", "FetchFailed"];
const ABSTAIN_REASONS = Object.freeze({
  Timeout: 1,
  PayloadTooLarge: 2,
  FetchFailed: 3,
  NotFound: 4,
  HashMismatch: 5,
  BelowThreshold: 6,
  MLServiceFailed: 7,
  MissingPayload: 8
});

const PilotEscrowABI = [
  "function campaigns(bytes32) view returns (address recipient, uint256 bounty, bool closed, uint256 fundedBlock)"
];

const DOMAIN = {
  name: "VENOM PilotEscrow",
  version: "1",
  chainId: null,
  verifyingContract: process.env.PILOT_ESCROW_ADDRESS,
};

let runtime = null;
let cachedChainId = null;

function getWorkerRuntime() {
  if (runtime) return runtime;

  const pilotEscrowAddress = process.env.PILOT_ESCROW_ADDRESS;
  if (!pilotEscrowAddress) {
    throw new Error("Missing PILOT_ESCROW_ADDRESS");
  }

  const operatorKey = process.env.OPERATOR_PRIVATE_KEY || process.env.BROADCASTER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  if (!operatorKey) {
    throw new Error("Missing OPERATOR_PRIVATE_KEY in .env");
  }

  const rpcUrls = (process.env.RPC_URLS || process.env.RPC_URL || "https://base-sepolia-rpc.publicnode.com")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);

  const multiProvider = new MultiRpcProvider(rpcUrls);
  const provider = multiProvider.getProvider();
  const wallet = new ethers.Wallet(operatorKey, provider);
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

function getAbstainReasonCode(reason) {
  return ABSTAIN_REASONS[reason] || ABSTAIN_REASONS.FetchFailed;
}

function assertTestPayloadAllowed() {
  assertRuntimeModeConfig(process.env);
}

function getProcessedCampaignKey(campaignUid) {
  const { wallet } = getWorkerRuntime();
  return `venom:worker:processed:${wallet.address.toLowerCase()}:${campaignUid}`;
}

async function hasProcessedCampaign(campaignUid) {
  return Boolean(await getConnection().get(getProcessedCampaignKey(campaignUid)));
}

async function markCampaignProcessed(campaignUid) {
  await getConnection().set(
    getProcessedCampaignKey(campaignUid),
    "1",
    "EX",
    PROCESSED_CAMPAIGN_TTL_SECONDS
  );
}

async function readLimitedText(response) {
  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_PAYLOAD_BYTES) {
    throw new Error("PayloadTooLarge");
  }

  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new Error("PayloadTooLarge");
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalBytes += value.byteLength;
    if (totalBytes > MAX_PAYLOAD_BYTES) {
      await reader.cancel();
      throw new Error("PayloadTooLarge");
    }
    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return text;
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

      if (!response.ok) {
        failures.push(response.status === 404 ? "NotFound" : "FetchFailed");
        continue;
      }

      const text = await readLimitedText(response);

      try {
        const data = JSON.parse(text);
        return data.payload ? data : { payload: text, reference_answer: "" };
      } catch {
        return { payload: text, reference_answer: "" };
      }
    } catch (err) {
      if (err.message === "PayloadTooLarge") throw err;
      failures.push(err.name === "AbortError" ? "Timeout" : "FetchFailed");
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(selectFailureReason(failures));
}

async function scoreWithFastAPI(evalData) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ML_TIMEOUT_MS);

  try {
    const res = await fetch(ML_SERVICE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(evalData),
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error(`ML service returned ${res.status}`);
    }

    const result = await res.json();
    if (typeof result.final_score !== "number" || typeof result.passes_threshold !== "boolean") {
      throw new Error("Invalid ML service response");
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
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
  const reasonCode = getAbstainReasonCode(reason);
  const signature = await wallet.signTypedData(domain, types, { campaignUid, reason: reasonCode });
  recordDashboardEvent({
    type: "local_abstain",
    campaignUid,
    source: "worker",
    signer: wallet.address,
    reasonCode,
    message: `This node produced a signed abstain: ${reason}.`
  }).catch((error) => {
    console.warn(`[Dashboard] Failed to record local abstain: ${error.message}`);
  });
  await publishAbstain(campaignUid, reasonCode, signature, reason);
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
  recordDashboardEvent({
    type: "local_score",
    campaignUid,
    source: "worker",
    signer: wallet.address,
    score: scoreInt,
    message: `This node produced a signed score: ${scoreInt}.`
  }).catch((error) => {
    console.warn(`[Dashboard] Failed to record local score: ${error.message}`);
  });
  await publishSignature(campaignUid, scoreInt, signature);
}

async function processCampaign(job) {
  assertTestPayloadAllowed();
  const { campaignUid, cid } = job.data;
  const { pilotEscrow } = getWorkerRuntime();
  console.log(`[Worker] Processing ${campaignUid}`);

  try {
    if (await hasProcessedCampaign(campaignUid)) {
      console.log(`  -> Already processed by this operator: ${campaignUid}`);
      return;
    }

    const campaign = await pilotEscrow.campaigns(campaignUid);
    if (campaign.closed) {
      console.log(`  -> Already closed: ${campaignUid}`);
      return;
    }

    let evalData;
    if (process.env.USE_TEST_PAYLOAD === "true") {
      console.warn(`[Worker] Using test payload for ${campaignUid}; replace with real content fetch`);
      evalData = TEST_PAYLOAD;
    } else if (!cid) {
      console.log(`  -> Missing payload CID. Publishing signed abstain.`);
      await publishSignedAbstain(campaignUid, "MissingPayload");
      await markCampaignProcessed(campaignUid);
      return;
    } else {
      try {
        evalData = await fetchFromIpfs(cid);
      } catch (error) {
        const reason = ["Timeout", "PayloadTooLarge", "FetchFailed", "NotFound", "HashMismatch"].includes(error.message)
          ? error.message
          : "FetchFailed";
        console.log(`  -> Fetch failed (${reason}). Publishing signed abstain.`);
        await publishSignedAbstain(campaignUid, reason);
        await markCampaignProcessed(campaignUid);
        return;
      }
    }

    if (!evalData) return;

    let scoreResult;
    try {
      scoreResult = await scoreWithFastAPI(evalData);
    } catch (error) {
      console.log(`  -> ML service failed (${error.message}). Publishing signed abstain.`);
      await publishSignedAbstain(campaignUid, "MLServiceFailed");
      await markCampaignProcessed(campaignUid);
      return;
    }

    if (!scoreResult.passes_threshold) {
      console.log(`  -> Below threshold (score ${scoreResult.final_score}). Publishing signed abstain.`);
      await publishSignedAbstain(campaignUid, "BelowThreshold");
      await markCampaignProcessed(campaignUid);
      return;
    }

    const scoreInt = Math.floor(scoreResult.final_score * 100);
    if (!Number.isInteger(scoreInt) || scoreInt < 0 || scoreInt > 100) {
      console.warn(`  -> ML score out of range (${scoreResult.final_score}). Publishing signed abstain.`);
      await publishSignedAbstain(campaignUid, "MLServiceFailed");
      await markCampaignProcessed(campaignUid);
      return;
    }
    await publishSignedScore(campaignUid, scoreInt);
    await markCampaignProcessed(campaignUid);
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
    concurrency: WORKER_CONCURRENCY
  });

  console.log("Starting VENOM Worker v1.1.0-rc.1 (BullMQ + signed abstention + IPFS fallback)");
  console.log(`   Address: ${wallet.address} | Concurrency: ${WORKER_CONCURRENCY} | Gateways: ${IPFS_GATEWAYS.length} | ML: ${ML_SERVICE_URL}\n`);

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
  selectFailureReason,
  getAbstainReasonCode,
  getProcessedCampaignKey,
  readLimitedText,
  scoreWithFastAPI
};
