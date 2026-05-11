// aggregator/worker.js
// VENOM Node v1.1.0-rc.1 - IPFS fetch fallback, ML scoring, signed score/abstain gossip.

const { Worker } = require('bullmq');
const { getConnection, QUEUE_NAME, OPERATOR_QUEUE_SUFFIX } = require('./queue');
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
const IPFS_CONCURRENT_FETCH = parseInt(process.env.IPFS_CONCURRENT_FETCH || "3", 10);
const IPFS_GATEWAY_TIMEOUT = parseInt(process.env.IPFS_GATEWAY_TIMEOUT || "8000", 10);
const ML_TIMEOUT_MS = parseInt(process.env.ML_TIMEOUT_MS || "30000", 10);
const JOB_LOCK_BUFFER_MS = 20000;
const JOB_LOCK_FETCH_BUDGET_MS = Math.max(FETCH_TIMEOUT_MS, IPFS_GATEWAY_TIMEOUT);
const DEFAULT_JOB_LOCK_DURATION_MS = JOB_LOCK_FETCH_BUDGET_MS + ML_TIMEOUT_MS + JOB_LOCK_BUFFER_MS;
const JOB_LOCK_DURATION_MS = parseInt(
  process.env.JOB_LOCK_DURATION_MS || process.env.WORKER_JOB_TIMEOUT_MS || String(DEFAULT_JOB_LOCK_DURATION_MS),
  10
);
const WORKER_JOB_TIMEOUT_MS = JOB_LOCK_DURATION_MS;
const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || "4", 10);
const PROCESSED_CAMPAIGN_TTL_SECONDS = parseInt(process.env.PROCESSED_CAMPAIGN_TTL_SECONDS || "86400", 10);
const PENDING_DELIVERY_TTL_SECONDS = parseInt(process.env.PENDING_DELIVERY_TTL_SECONDS || "3600", 10);
const PENDING_DELIVERY_SCAN_BATCH = parseInt(process.env.PENDING_DELIVERY_SCAN_BATCH || "100", 10);
const PENDING_DELIVERY_KEY_PREFIX = "venom:worker:pending";
const FETCH_FAILURE_PRECEDENCE = ["PayloadTooLarge", "HashMismatch", "NotFound", "Timeout", "FetchFailed"];
const SCORE_MAX = parseInt(process.env.SCORE_MAX || "100", 10);
const SCORE_MIN = parseInt(process.env.SCORE_MIN || "0", 10);
const CID_REGEX = /^(Qm[1-9A-HJ-NP-Za-km-z]{44,}|baf[a-z2-7]{55,})$/i;
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
  "function campaigns(bytes32) view returns (address recipient, uint256 bounty, bool closed, uint256 fundedBlock, string contentUri, bytes32 contentHash)"
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

  const operatorKey = process.env.OPERATOR_PRIVATE_KEY;
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

function assertWorkerLockConfig() {
  const minimumTimeout = JOB_LOCK_FETCH_BUDGET_MS + ML_TIMEOUT_MS + JOB_LOCK_BUFFER_MS;
  if (!Number.isFinite(JOB_LOCK_DURATION_MS) || JOB_LOCK_DURATION_MS < minimumTimeout) {
    throw new Error(
      `JOB_LOCK_DURATION_MS must be at least ${minimumTimeout}ms ` +
      `(fetch budget=${JOB_LOCK_FETCH_BUDGET_MS}ms + ML_TIMEOUT_MS=${ML_TIMEOUT_MS}ms + ${JOB_LOCK_BUFFER_MS}ms buffer).`
    );
  }
}

function assertWorkerTimeoutConfig() {
  return assertWorkerLockConfig();
}

function normalizeCid(input) {
  if (!input || typeof input !== "string") return "";
  const trimmed = input.trim();

  if (trimmed.startsWith("ipfs://")) {
    return trimmed.slice("ipfs://".length).split(/[/?#]/)[0];
  }

  if (trimmed.startsWith("/ipfs/")) {
    return trimmed.slice("/ipfs/".length).split(/[/?#]/)[0];
  }

  try {
    const url = new URL(trimmed);
    const parts = url.pathname.split("/").filter(Boolean);
    const ipfsIndex = parts.indexOf("ipfs");
    if (ipfsIndex >= 0 && parts[ipfsIndex + 1]) {
      return parts[ipfsIndex + 1];
    }
  } catch {
    // Not a URL; treat it as a raw CID.
  }

  return trimmed.split(/[/?#]/)[0];
}

function isValidCid(input) {
  return CID_REGEX.test(normalizeCid(input));
}

function getProcessedCampaignKey(campaignUid) {
  const { wallet } = getWorkerRuntime();
  return `venom:worker:processed:${wallet.address.toLowerCase()}:${campaignUid}`;
}

function getPendingDeliveryKey(campaignUid) {
  const { wallet } = getWorkerRuntime();
  return `${PENDING_DELIVERY_KEY_PREFIX}:${wallet.address.toLowerCase()}:${campaignUid}`;
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

async function markCampaignProcessedAndClearDelivery(campaignUid) {
  await markCampaignProcessed(campaignUid);
  await deletePendingDelivery(campaignUid);
}

async function getPendingDelivery(campaignUid) {
  const raw = await getConnection().get(getPendingDeliveryKey(campaignUid));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function setPendingDelivery(campaignUid, delivery) {
  await getConnection().set(
    getPendingDeliveryKey(campaignUid),
    JSON.stringify({ ...delivery, campaignUid, timestamp: Date.now() }),
    "EX",
    PENDING_DELIVERY_TTL_SECONDS
  );
}

async function deletePendingDelivery(campaignUid) {
  await getConnection().del(getPendingDeliveryKey(campaignUid));
}

async function publishPendingDelivery(campaignUid, delivery) {
  if (!delivery || typeof delivery !== "object") return false;
  if (delivery.type === "score" && Number.isInteger(delivery.score) && typeof delivery.signature === "string") {
    await publishSignature(campaignUid, delivery.score, delivery.signature);
    return true;
  }
  if (delivery.type === "abstain" && Number.isInteger(delivery.reasonCode) && typeof delivery.signature === "string") {
    await publishAbstain(campaignUid, delivery.reasonCode, delivery.signature, delivery.reasonLabel || "");
    return true;
  }
  return false;
}

async function retryPendingDeliveries() {
  const { wallet } = getWorkerRuntime();
  const conn = getConnection();
  const keyPrefix = `${PENDING_DELIVERY_KEY_PREFIX}:${wallet.address.toLowerCase()}:`;
  const pattern = `${keyPrefix}*`;
  let cursor = "0";

  do {
    const [nextCursor, keys] = await conn.scan(cursor, "MATCH", pattern, "COUNT", PENDING_DELIVERY_SCAN_BATCH);
    cursor = String(nextCursor);

    for (const key of keys) {
      const campaignUid = key.slice(keyPrefix.length);
      const delivery = await getPendingDelivery(campaignUid);
      if (!delivery) continue;

      try {
        if (await publishPendingDelivery(campaignUid, delivery)) {
          await markCampaignProcessed(campaignUid);
          await deletePendingDelivery(campaignUid);
          console.log(`[Worker] Re-published pending delivery for ${campaignUid}`);
        }
      } catch (error) {
        console.warn(`[Worker] Pending delivery retry failed for ${campaignUid}: ${error.message}`);
      }
    }
  } while (cursor !== "0");
}

async function readLimitedText(response) {
  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_PAYLOAD_BYTES) {
    throw new Error("PayloadTooLarge");
  }

  if (!response.body || typeof response.body.getReader !== "function") {
    let totalBytes = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      totalBytes += chunk.length;
      if (totalBytes > MAX_PAYLOAD_BYTES) {
        throw new Error("PayloadTooLarge");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
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

  const normalizedCid = normalizeCid(cid);
  if (!isValidCid(normalizedCid)) {
    throw new Error("Invalid CID format");
  }

  const failures = [];

  const results = await Promise.allSettled(
    IPFS_GATEWAYS.map(async (gateway) => {
      const url = `${gateway}/${normalizedCid}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), IPFS_GATEWAY_TIMEOUT);

      try {
        const response = await fetch(url, { signal: controller.signal });

        if (!response.ok) {
          failures.push({ gateway, status: response.status, reason: response.status === 404 ? "NotFound" : "FetchFailed" });
          return null;
        }

        const text = await readLimitedText(response);

        try {
          const data = JSON.parse(text);
          return {
            gateway,
            data: data.payload ? data : { payload: text, reference_answer: "" },
          };
        } catch {
          return {
            gateway,
            data: { payload: text, reference_answer: "" },
          };
        }
      } catch (err) {
        if (err.message === "PayloadTooLarge") {
          throw err;
        }
        failures.push({ gateway, reason: err.name === "AbortError" ? "Timeout" : "FetchFailed", error: err.message });
        return null;
      } finally {
        clearTimeout(timeout);
      }
    })
  );

  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled' && results[i].value) {
      console.log(`[Worker] Successfully fetched from ${results[i].value.gateway}`);
      return results[i].value.data;
    }
  }

  const successfulResult = results.find(r => r.status === 'fulfilled' && r.value);
  if (!successfulResult) {
    throw new Error(selectFailureReason(failures.map(f => f.reason)));
  }

  return successfulResult.value.data;
}

function computeContentHash(payload) {
  return ethers.keccak256(ethers.toUtf8Bytes(payload));
}

async function scoreWithFastAPI(evalData) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ML_TIMEOUT_MS);
  const startTime = Date.now();

  try {
    const res = await fetch(ML_SERVICE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": process.env.ML_SERVICE_API_KEY || ""
      },
      body: JSON.stringify(evalData),
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error(`ML service returned ${res.status}`);
    }

    console.log(`[Worker] ML service responded in ${Date.now() - startTime}ms`);

    const result = await res.json();
    if (typeof result.final_score !== "number" || typeof result.passes_threshold !== "boolean") {
      throw new Error("Invalid ML service response");
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function scoreWithFastAPIWithRetry(evalData, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await scoreWithFastAPI(evalData);
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
    }
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
  await setPendingDelivery(campaignUid, {
    type: "abstain",
    reasonCode,
    reasonLabel: reason,
    signature,
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
  await setPendingDelivery(campaignUid, {
    type: "score",
    score: scoreInt,
    signature,
  });
  await publishSignature(campaignUid, scoreInt, signature);
}

async function processCampaign(job) {
  assertTestPayloadAllowed();
  const { campaignUid, cid, contentHash } = job.data;
  const { multiProvider, pilotEscrowAddress } = getWorkerRuntime();
  console.log(`[Worker] Processing ${campaignUid}`);

  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(campaignUid)) {
    throw new Error(`Invalid campaignUid format: ${campaignUid}`);
  }

  // Rebuild contract from current provider to follow RPC failover
  const provider = multiProvider.getProvider();
  const pilotEscrow = new ethers.Contract(pilotEscrowAddress, PilotEscrowABI, provider);

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
      await markCampaignProcessedAndClearDelivery(campaignUid);
      return;
    } else {
      try {
        evalData = await fetchFromIpfs(cid);

        // Verify content hash if provided on-chain
        if (contentHash && contentHash !== ethers.ZeroHash) {
          const computedHash = computeContentHash(evalData.payload);
          if (computedHash.toLowerCase() !== contentHash.toLowerCase()) {
            console.log(`  -> Content hash mismatch (expected ${contentHash}, got ${computedHash}). Publishing signed abstain.`);
            await publishSignedAbstain(campaignUid, "HashMismatch");
            await markCampaignProcessedAndClearDelivery(campaignUid);
            return;
          }
        }
      } catch (error) {
        const reason = ["Timeout", "PayloadTooLarge", "FetchFailed", "NotFound", "HashMismatch"].includes(error.message)
          ? error.message
          : "FetchFailed";
        console.log(`  -> Fetch failed (${reason}). Publishing signed abstain.`);
        await publishSignedAbstain(campaignUid, reason);
        await markCampaignProcessedAndClearDelivery(campaignUid);
        return;
      }
    }

    if (!evalData) return;

    let scoreResult;
    try {
      scoreResult = await scoreWithFastAPIWithRetry(evalData);
    } catch (error) {
      console.log(`  -> ML service failed (${error.message}). Publishing signed abstain.`);
      await publishSignedAbstain(campaignUid, "MLServiceFailed");
      await markCampaignProcessedAndClearDelivery(campaignUid);
      return;
    }

    if (!scoreResult.passes_threshold) {
      console.log(`  -> Below threshold (score ${scoreResult.final_score}). Publishing signed abstain.`);
      await publishSignedAbstain(campaignUid, "BelowThreshold");
      await markCampaignProcessedAndClearDelivery(campaignUid);
      return;
    }

    const scoreInt = Math.floor(scoreResult.final_score * 100);
    if (!Number.isInteger(scoreInt) || scoreInt < SCORE_MIN || scoreInt > SCORE_MAX) {
      console.warn(`  -> ML score out of range (${scoreResult.final_score}). Publishing signed abstain.`);
      await publishSignedAbstain(campaignUid, "MLServiceFailed");
      await markCampaignProcessedAndClearDelivery(campaignUid);
      return;
    }
    await publishSignedScore(campaignUid, scoreInt);
    await markCampaignProcessedAndClearDelivery(campaignUid);
    console.log(`  -> Evaluated and signed score ${scoreInt} for ${campaignUid}`);
  } catch (err) {
    console.error(`Failed: ${campaignUid}`, err.message);
    throw err;
  }
}

async function startWorker() {
  assertRuntimeModeConfig(process.env);
  assertWorkerTimeoutConfig();
  await retryPendingDeliveries();

  const { wallet } = getWorkerRuntime();

  const worker = new Worker(QUEUE_NAME, processCampaign, {
    connection: getConnection(),
    concurrency: WORKER_CONCURRENCY,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
      maxDelay: 30000
    },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
    lockDuration: JOB_LOCK_DURATION_MS,
    lockRenewalTime: Math.max(1000, Math.floor(JOB_LOCK_DURATION_MS / 2))
  });

  console.log("Starting VENOM Worker v1.1.0 (BullMQ + signed abstention + IPFS concurrent fallback)");
  console.log(`   Address: ${wallet.address} | Queue: ${QUEUE_NAME}${OPERATOR_QUEUE_SUFFIX ? ` | Queue suffix: ${OPERATOR_QUEUE_SUFFIX}` : ""}`);
  console.log(`   Concurrency: ${WORKER_CONCURRENCY} | Gateways: ${IPFS_GATEWAYS.length} | ML: ${ML_SERVICE_URL} | Job lock: ${JOB_LOCK_DURATION_MS}ms\n`);

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
  normalizeCid,
  isValidCid,
  selectFailureReason,
  getAbstainReasonCode,
  getProcessedCampaignKey,
  getPendingDeliveryKey,
  getPendingDelivery,
  setPendingDelivery,
  deletePendingDelivery,
  retryPendingDeliveries,
  markCampaignProcessedAndClearDelivery,
  readLimitedText,
  scoreWithFastAPI,
  computeContentHash,
  JOB_LOCK_DURATION_MS,
  WORKER_JOB_TIMEOUT_MS,
  assertWorkerTimeoutConfig,
  assertWorkerLockConfig
};
