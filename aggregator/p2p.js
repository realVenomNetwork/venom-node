// aggregator/p2p.js
// Libp2p gossip aggregation for signed score and abstain messages.

const { ethers } = require('ethers');
const { generatePostcardFromCloseReceipt } = require('../src/postcard');
const { recordDashboardEvent } = require('../src/dashboard/quorum-replay');

let REQUIRED_ORACLES = 5;
let SCORE_QUORUM_PCT = 50;
let PARTICIPATION_FLOOR_PCT = 67;
const TOPIC = 'venom:signatures';
const PENDING_CAMPAIGN_TTL_MS = Number(process.env.P2P_PENDING_CAMPAIGN_TTL_MS || 4 * 60 * 60 * 1000);
const PENDING_CAMPAIGN_GC_MS = Number(process.env.P2P_PENDING_CAMPAIGN_GC_MS || 60 * 1000);
const MAX_PENDING_CAMPAIGNS = Number(process.env.P2P_MAX_PENDING_CAMPAIGNS || 1000);
const LEADER_TIMEOUT_MS = Number(process.env.P2P_LEADER_TIMEOUT_MS || 15 * 1000);
const MAX_MESSAGE_AGE_MS = Number(process.env.P2P_MAX_MESSAGE_AGE_MS || 5 * 60 * 1000);
const MAX_MESSAGES_PER_WINDOW = Number(process.env.P2P_MAX_MESSAGES_PER_WINDOW || 100);
const RATE_WINDOW_MS = Number(process.env.P2P_RATE_WINDOW_MS || 10000);
const CLOSE_CONFIRMATIONS = Number(process.env.CLOSE_CONFIRMATIONS || 3);

let libp2p;
let libp2pModules;
let leaderInterval;
let oracleRefreshInterval;
let pendingCampaignGcInterval;
let activeOracleCount = REQUIRED_ORACLES;
let activeOracleAddresses = new Set();
let pendingCampaigns = new Map();
let myPeerId;
let myWallet;
let eip712Domain;
let registryContract;
let pilotEscrowContract;
const locallyClosedCampaigns = new Set();
const peerRateLimits = new Map();
let warnedMissingConnectionApi = false;
let warnedMissingOracleList = false;

const SCORE_TYPES = {
  Score: [
    { name: "campaignUid", type: "bytes32" },
    { name: "score", type: "uint256" }
  ]
};
const ABSTAIN_TYPES = {
  Abstain: [
    { name: "campaignUid", type: "bytes32" },
    { name: "reason", type: "uint8" }
  ]
};
const ABSTAIN_REASON_CODES = Object.freeze({
  Timeout: 1,
  PayloadTooLarge: 2,
  FetchFailed: 3,
  NotFound: 4,
  HashMismatch: 5,
  BelowThreshold: 6,
  MLServiceFailed: 7,
  MissingPayload: 8
});

function isRateLimited(peerId) {
  const now = Date.now();
  let entry = peerRateLimits.get(peerId);
  if (!entry || now > entry.resetTime) {
    entry = { count: 0, resetTime: now + RATE_WINDOW_MS };
    peerRateLimits.set(peerId, entry);
  }
  entry.count++;
  return entry.count > MAX_MESSAGES_PER_WINDOW;
}

function cleanupRateLimiter() {
  const now = Date.now();
  for (const [peerId, entry] of peerRateLimits.entries()) {
    if (now > entry.resetTime) {
      peerRateLimits.delete(peerId);
    }
  }
}

function isCampaignLocallyClosed(campaignUid) {
  return locallyClosedCampaigns.has(campaignUid.toLowerCase());
}

function markCampaignLocallyClosed(campaignUid) {
  locallyClosedCampaigns.add(campaignUid.toLowerCase());
}

async function loadLibp2pModules() {
  if (libp2pModules) return libp2pModules;

  const [
    libp2pPkg,
    gossipsubPkg,
    tcpPkg,
    noisePkg,
    yamuxPkg,
    multiaddrPkg,
    identifyPkg
  ] = await Promise.all([
    import('libp2p'),
    import('@chainsafe/libp2p-gossipsub'),
    import('@libp2p/tcp'),
    import('@chainsafe/libp2p-noise'),
    import('@chainsafe/libp2p-yamux'),
    import('@multiformats/multiaddr'),
    import('@libp2p/identify')
  ]);

  libp2pModules = {
    createLibp2p: libp2pPkg.createLibp2p,
    gossipsub: gossipsubPkg.gossipsub,
    tcp: tcpPkg.tcp,
    noise: noisePkg.noise,
    yamux: yamuxPkg.yamux,
    multiaddr: multiaddrPkg.multiaddr,
    identify: identifyPkg.identify
  };
  return libp2pModules;
}

async function loadQuorumConstants() {
  if (!pilotEscrowContract) return;
  try {
    const [reqOracles, scoreQuorum, participationFloor] = await Promise.all([
      pilotEscrowContract.REQUIRED_ORACLES(),
      pilotEscrowContract.SCORE_QUORUM_PCT(),
      pilotEscrowContract.PARTICIPATION_FLOOR_PCT()
    ]);
    REQUIRED_ORACLES = Number(reqOracles);
    SCORE_QUORUM_PCT = Number(scoreQuorum);
    PARTICIPATION_FLOOR_PCT = Number(participationFloor);
    console.log(`[P2P] Loaded quorum constants from contract: REQUIRED_ORACLES=${REQUIRED_ORACLES}, SCORE_QUORUM_PCT=${SCORE_QUORUM_PCT}, PARTICIPATION_FLOOR_PCT=${PARTICIPATION_FLOOR_PCT}`);
  } catch (err) {
    console.warn(`[P2P] Failed to load quorum constants from contract, using defaults: ${err.message}`);
  }
}

async function startP2PNode(wallet) {
  myWallet = wallet;

  const registryAddress = process.env.VENOM_REGISTRY_ADDRESS;
  if (!registryAddress) throw new Error("Missing VENOM_REGISTRY_ADDRESS");
  const pilotEscrowAddress = process.env.PILOT_ESCROW_ADDRESS;
  if (!pilotEscrowAddress) throw new Error("Missing PILOT_ESCROW_ADDRESS");

  const { createLibp2p, gossipsub, tcp, noise, yamux, multiaddr, identify } = await loadLibp2pModules();

  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const network = await provider.getNetwork();
  eip712Domain = {
    name: "VENOM PilotEscrow",
    version: "1",
    chainId: Number(network.chainId),
    verifyingContract: pilotEscrowAddress
  };
  registryContract = new ethers.Contract(registryAddress, [
    "function getActiveOracles() view returns (address[] operators, string[] multiaddrs)"
  ], provider);
  pilotEscrowContract = new ethers.Contract(pilotEscrowAddress, [
    "function REQUIRED_ORACLES() view returns (uint256)",
    "function SCORE_QUORUM_PCT() view returns (uint256)",
    "function PARTICIPATION_FLOOR_PCT() view returns (uint256)"
  ], provider);

  await loadQuorumConstants();

  const { operators, multiaddrs } = await refreshActiveOracles();

  libp2p = await createLibp2p({
    addresses: { listen: ['/ip4/0.0.0.0/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      pubsub: gossipsub({
        allowPublishToZeroPeers: true,
        emitSelf: true
      })
    }
  });

  myPeerId = libp2p.peerId.toString();
  console.log(`VENOM P2P node started: ${myPeerId}`);

  for (let index = 0; index < multiaddrs.length; index++) {
    const addr = multiaddrs[index];
    if (isLocalOraclePeer(operators[index], addr)) continue;
    if (addr && addr.length > 0) {
      try {
        await libp2p.dial(multiaddr(addr));
        console.log(`[P2P] Connected to on-chain peer: ${addr}`);
      } catch {
        console.warn(`[P2P] Failed to dial ${addr}`);
      }
    }
  }

  await libp2p.services.pubsub.subscribe(TOPIC);
  libp2p.services.pubsub.addEventListener('message', handleSignatureMessage);

  leaderInterval = setInterval(checkAndSubmitIfLeader, 5000);
  oracleRefreshInterval = setInterval(() => {
    refreshActiveOracles().catch((error) => {
      console.warn(`[P2P] Active oracle refresh failed: ${error.message}`);
    });
  }, Number(process.env.P2P_ORACLE_REFRESH_MS || 60000));
  pendingCampaignGcInterval = setInterval(prunePendingCampaigns, PENDING_CAMPAIGN_GC_MS);
  const originalStop = libp2p.stop.bind(libp2p);
  libp2p.stop = async () => {
    if (leaderInterval) {
      clearInterval(leaderInterval);
      leaderInterval = null;
    }
    if (oracleRefreshInterval) {
      clearInterval(oracleRefreshInterval);
      oracleRefreshInterval = null;
    }
    if (pendingCampaignGcInterval) {
      clearInterval(pendingCampaignGcInterval);
      pendingCampaignGcInterval = null;
    }
    await originalStop();
  };

  console.log("[P2P] Node ready (v1.1 signed abstention + closeCampaign ABI)");
  return libp2p;
}

function normalizeIterable(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value[Symbol.iterator] === 'function') return Array.from(value);
  return null;
}

function peerIdFromMultiaddr(addr) {
  const match = String(addr || '').match(/\/p2p\/([^/]+)/);
  return match ? match[1] : null;
}

function isLocalOraclePeer(operator, addr) {
  if (operator && myWallet && operator.toLowerCase() === myWallet.address.toLowerCase()) return true;
  const peerId = peerIdFromMultiaddr(addr);
  return Boolean(peerId && myPeerId && peerId === myPeerId);
}

async function ensurePeersConnected(multiaddrs, operators = []) {
  if (!libp2p) return;
  const targetMultiaddrs = normalizeIterable(multiaddrs);
  if (!targetMultiaddrs) {
    if (!warnedMissingOracleList) {
      console.log("[P2P] Active oracle multiaddr list unavailable; skipping peer reconnect");
      warnedMissingOracleList = true;
    }
    return;
  }

  const connectedAddrs = new Set();
  const connections = typeof libp2p.getConnections === 'function'
    ? libp2p.getConnections()
    : (libp2p.connections && typeof libp2p.connections.values === 'function'
        ? Array.from(libp2p.connections.values())
        : []);
  if (connections.length === 0 && !libp2p.getConnections && !libp2p.connections && !warnedMissingConnectionApi) {
    console.log("[P2P] libp2p connection list unavailable; peer reconnect will dial configured oracle multiaddrs");
    warnedMissingConnectionApi = true;
  }

  for (const conn of connections) {
    const remoteAddr = conn.remoteAddr && conn.remoteAddr.toString ? conn.remoteAddr.toString() : "";
    for (const addr of remoteAddr.split(',')) {
      connectedAddrs.add(addr);
    }
  }

  const { multiaddr } = await loadLibp2pModules();
  for (let index = 0; index < targetMultiaddrs.length; index++) {
    const addr = targetMultiaddrs[index];
    if (isLocalOraclePeer(operators[index], addr)) continue;
    if (addr && addr.length > 0 && !connectedAddrs.has(addr)) {
      try {
        await libp2p.dial(multiaddr(addr));
        console.log(`[P2P] Re-connected to peer: ${addr}`);
      } catch (err) {
        console.warn(`[P2P] Failed to re-dial ${addr}: ${err.message}`);
      }
    }
  }
}

async function refreshActiveOracles() {
  if (!registryContract) throw new Error("P2P registry contract not initialized");
  const [operatorResult, multiaddrResult] = await registryContract.getActiveOracles();
  const operators = normalizeIterable(operatorResult);
  const multiaddrs = normalizeIterable(multiaddrResult);
  if (!operators) {
    if (!warnedMissingOracleList) {
      console.log("[P2P] Active oracle list unavailable; keeping previous active oracle cache");
      warnedMissingOracleList = true;
    }
    await loadQuorumConstants();
    return { operators: [], multiaddrs: [] };
  }
  activeOracleCount = Math.max(operators.length, 1);
  activeOracleAddresses = new Set(operators.map((operator) => operator.toLowerCase()));
  console.log(`[P2P] Found ${operators.length} active oracles on-chain`);

  await ensurePeersConnected(multiaddrs, operators);
  await loadQuorumConstants();

  return { operators, multiaddrs: multiaddrs || [] };
}

function normalizeAbstainReason(reason) {
  if (Number.isInteger(reason) && reason >= 0 && reason <= 255) return reason;
  if (typeof reason === "string" && /^\d+$/.test(reason)) {
    const parsed = Number(reason);
    if (parsed >= 0 && parsed <= 255) return parsed;
  }
  if (typeof reason === "string" && ABSTAIN_REASON_CODES[reason]) {
    return ABSTAIN_REASON_CODES[reason];
  }
  return null;
}

function recoverScoreSigner(campaignUid, score, signature) {
  return ethers.verifyTypedData(eip712Domain, SCORE_TYPES, { campaignUid, score }, signature);
}

function recoverAbstainSigner(campaignUid, reason, signature) {
  return ethers.verifyTypedData(eip712Domain, ABSTAIN_TYPES, { campaignUid, reason }, signature);
}

function prunePendingCampaigns(now = Date.now()) {
  for (const [campaignUid, entry] of pendingCampaigns.entries()) {
    if (now - entry.updatedAt > PENDING_CAMPAIGN_TTL_MS) {
      pendingCampaigns.delete(campaignUid);
    }
  }

  while (pendingCampaigns.size > MAX_PENDING_CAMPAIGNS) {
    let oldestCampaignUid = null;
    let oldestUpdatedAt = Number.MAX_SAFE_INTEGER;
    for (const [campaignUid, entry] of pendingCampaigns.entries()) {
      if (entry.updatedAt < oldestUpdatedAt) {
        oldestUpdatedAt = entry.updatedAt;
        oldestCampaignUid = campaignUid;
      }
    }
    if (!oldestCampaignUid) break;
    pendingCampaigns.delete(oldestCampaignUid);
  }
}

function getOrCreatePendingCampaign(campaignUid) {
  if (!pendingCampaigns.has(campaignUid)) {
    const now = Date.now();
    pendingCampaigns.set(campaignUid, {
      createdAt: now,
      updatedAt: now,
      quorumReachedAt: null,
      scores: [],
      signatures: [],
      signers: [],
      abstainSignatures: [],
      abstainReasons: [],
      abstainSigners: []
    });
  }
  return pendingCampaigns.get(campaignUid);
}

function leaderForRound(campaignUid, scoreSigners, round = 0) {
  if (!Array.isArray(scoreSigners) || scoreSigners.length === 0) return null;
  const sortedActiveOracles = Array.from(activeOracleAddresses).sort();
  if (sortedActiveOracles.length === 0) return null;
  const seed = ethers.keccak256(ethers.concat([campaignUid, ...sortedActiveOracles]));
  const base = Number(BigInt(seed) % BigInt(sortedActiveOracles.length));
  return sortedActiveOracles[(base + round) % sortedActiveOracles.length];
}

function amILeader(campaignUid, scoreSigners, round = 0) {
  if (!myWallet) return false;
  return leaderForRound(campaignUid, scoreSigners, round) === myWallet.address.toLowerCase();
}

function quorumMet(entry) {
  const scoreCount = entry.signers.length;
  const totalCount = scoreCount + entry.abstainSigners.length;
  return (
    scoreCount >= REQUIRED_ORACLES &&
    scoreCount * 100 >= activeOracleCount * SCORE_QUORUM_PCT &&
    totalCount * 100 >= activeOracleCount * PARTICIPATION_FLOOR_PCT
  );
}

function medianScore(scores) {
  if (!Array.isArray(scores) || scores.length === 0) return null;
  const sorted = [...scores].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function errorText(error) {
  return [
    error?.message,
    error?.reason,
    error?.shortMessage,
    error?.info?.error?.message,
    error?.error?.message
  ].filter(Boolean).join(" ");
}

function isAlreadyClosedError(error) {
  const text = errorText(error);
  return text.includes("Campaign already closed") || text.includes("Already closed");
}

function closeTxOverrides() {
  const overrides = {};
  if (process.env.CLOSE_GAS_LIMIT) {
    overrides.gasLimit = BigInt(process.env.CLOSE_GAS_LIMIT);
  }
  if (process.env.CLOSE_MAX_FEE_GWEI) {
    overrides.maxFeePerGas = ethers.parseUnits(process.env.CLOSE_MAX_FEE_GWEI, "gwei");
  }
  if (process.env.CLOSE_MAX_PRIORITY_FEE_GWEI) {
    overrides.maxPriorityFeePerGas = ethers.parseUnits(process.env.CLOSE_MAX_PRIORITY_FEE_GWEI, "gwei");
  }
  return overrides;
}

async function handleSignatureMessage(evt) {
  try {
    if (Math.random() < 0.01) cleanupRateLimiter();

    const data = evt.detail.data ? JSON.parse(new TextDecoder().decode(evt.detail.data)) : {};
    const { campaignUid, type = 'score', score, signature, reason } = data;
    const peerId = data.peerId || 'unknown';

    if (!ethers.isHexString(campaignUid, 32) || typeof signature !== "string") {
      console.warn("[P2P] Dropping malformed gossip message");
      return;
    }

    if (isRateLimited(peerId)) {
      console.warn(`[P2P] Rate limited peer ${peerId}`);
      return;
    }

    if (data.timestamp && typeof data.timestamp === 'number') {
      const age = Date.now() - data.timestamp;
      if (age > MAX_MESSAGE_AGE_MS) {
        console.warn(`[P2P] Dropping stale message for ${campaignUid} from ${peerId}`);
        return;
      }
    }

    let signer;
    let scoreNumber;
    let reasonCode;

    if (type === 'abstain') {
      reasonCode = normalizeAbstainReason(data.reasonCode ?? reason);
      if (reasonCode === null) {
        console.warn(`[P2P] Dropping abstain with invalid reason for ${campaignUid}`);
        return;
      }
      signer = recoverAbstainSigner(campaignUid, reasonCode, signature).toLowerCase();
    } else {
      scoreNumber = Number(score);
      if (!Number.isInteger(scoreNumber) || scoreNumber < 0 || scoreNumber > 100) {
        console.warn(`[P2P] Dropping score outside supported range for ${campaignUid}`);
        return;
      }
      signer = recoverScoreSigner(campaignUid, scoreNumber, signature).toLowerCase();
    }

    if (!activeOracleAddresses.has(signer)) {
      console.warn(`[P2P] Dropping ${type} from inactive signer ${signer}`);
      return;
    }

    if (pendingCampaigns.size >= Math.floor(MAX_PENDING_CAMPAIGNS * 0.9)) {
      prunePendingCampaigns();
    }

    const entry = getOrCreatePendingCampaign(campaignUid);

    if (type === 'abstain') {
      if (entry.abstainSigners.includes(signer)) return;
      entry.abstainSignatures.push(signature);
      entry.abstainReasons.push(reasonCode);
      entry.abstainSigners.push(signer);
      recordDashboardEvent({
        type: "abstain_observed",
        campaignUid,
        source: "p2p",
        signer,
        reasonCode,
        message: "Abstain signature observed by this node."
      }).catch((error) => {
        console.warn(`[Dashboard] Failed to record abstain observation: ${error.message}`);
      });
      console.log(`[P2P] Received ABSTAIN for ${campaignUid} (${entry.abstainSigners.length} abstains)`);
    } else {
      if (entry.signers.includes(signer)) return;
      entry.scores.push(scoreNumber);
      entry.signatures.push(signature);
      entry.signers.push(signer);
      recordDashboardEvent({
        type: "score_observed",
        campaignUid,
        source: "p2p",
        signer,
        score: scoreNumber,
        message: "Score signature observed by this node."
      }).catch((error) => {
        console.warn(`[Dashboard] Failed to record score observation: ${error.message}`);
      });
      console.log(`[P2P] Received SCORE for ${campaignUid} (${entry.signers.length}/${REQUIRED_ORACLES})`);
    }

    entry.updatedAt = Date.now();
    if (quorumMet(entry)) {
      if (entry.quorumReachedAt === null) {
        entry.quorumReachedAt = Date.now();
        recordDashboardEvent({
          type: "quorum_reached",
          campaignUid,
          source: "p2p",
          message: "This node observed enough local peer messages to mark quorum reached."
        }).catch((error) => {
          console.warn(`[Dashboard] Failed to record quorum observation: ${error.message}`);
        });
        console.log(`[P2P] Quorum reached for ${campaignUid} (round 0 leader: ${leaderForRound(campaignUid, entry.signers, 0)})`);
      }

      if (amILeader(campaignUid, entry.signers, 0)) {
        const submitted = await submitAggregatedTransaction(campaignUid, entry);
        if (submitted) pendingCampaigns.delete(campaignUid);
      }
    }
  } catch (err) {
    console.error("[P2P] Error handling message:", err.message);
  }
}

async function submitAggregatedTransaction(campaignUid, entry) {
  try {
    const pilotEscrowAddress = process.env.PILOT_ESCROW_ADDRESS;
    if (!pilotEscrowAddress) throw new Error("Missing PILOT_ESCROW_ADDRESS");

    if (isCampaignLocallyClosed(campaignUid)) {
      return true;
    }

    console.log(`[P2P] Submitting closeCampaign for ${campaignUid} with ${entry.signers.length} scores + ${entry.abstainSigners.length} abstains...`);
    recordDashboardEvent({
      type: "close_submitted",
      campaignUid,
      source: "p2p",
      submitter: myWallet.address,
      message: "This node submitted closeCampaign."
    }).catch((error) => {
      console.warn(`[Dashboard] Failed to record close submission: ${error.message}`);
    });

    const pilotEscrow = new ethers.Contract(pilotEscrowAddress, [
      "function closeCampaign(bytes32,uint256[],bytes[],uint8[],bytes[]) external",
      "function campaigns(bytes32) view returns (address recipient, uint256 bounty, bool closed, uint256 fundedBlock, string contentUri, bytes32 contentHash)"
    ], myWallet);

    const combinedScores = entry.scores.map((score, i) => ({ score, signature: entry.signatures[i] }));
    combinedScores.sort((a, b) => a.score - b.score);
    const sortedScores = combinedScores.map(c => c.score);
    const sortedSignatures = combinedScores.map(c => c.signature);

    const tx = await pilotEscrow.closeCampaign(
      campaignUid,
      sortedScores,
      sortedSignatures,
      entry.abstainReasons,
      entry.abstainSignatures,
      closeTxOverrides()
    );

    const receipt = await tx.wait(CLOSE_CONFIRMATIONS);
    const campaign = await pilotEscrow.campaigns(campaignUid);
    if (!campaign.closed && campaign[2] !== true) {
      throw new Error("closeCampaign receipt observed, but campaign is not closed on-chain");
    }
    console.log(`SUCCESS: Campaign closed in block ${receipt.blockNumber}`);
    markCampaignLocallyClosed(campaignUid);
    recordDashboardEvent({
      type: "close_observed",
      campaignUid,
      source: "p2p",
      submitter: myWallet.address,
      transactionHash: receipt.hash || receipt.transactionHash,
      blockNumber: Number(receipt.blockNumber),
      message: "This node observed closeCampaign succeed on-chain."
    }).catch((error) => {
      console.warn(`[Dashboard] Failed to record close observation: ${error.message}`);
    });
    try {
      const postcardResult = await generatePostcardFromCloseReceipt({
        campaignUid,
        receipt,
        submitter: myWallet.address,
        localOperator: myWallet.address,
        closeObservation: {
          contract_address: pilotEscrowAddress
        },
        judgmentCapsule: {
          summary: "This node submitted closeCampaign and observed the successful on-chain receipt.",
          median_score: medianScore(entry.scores),
          score_count: entry.signers.length,
          abstain_count: entry.abstainSigners.length
        }
      });
      await recordDashboardEvent({
        type: "postcard_logged",
        campaignUid,
        source: "postcard",
        submitter: myWallet.address,
        transactionHash: receipt.hash || receipt.transactionHash,
        blockNumber: Number(receipt.blockNumber),
        postcardPaths: postcardResult.paths,
        message: "Campaign Postcard v1 was written locally."
      });
      console.log(`[P2P] Wrote Campaign Postcard v1 for ${campaignUid}`);
    } catch (postcardError) {
      console.warn(`[P2P] Campaign closed, but postcard was not written: ${postcardError.message}`);
    }
    return true;
  } catch (err) {
    console.error(`Submission failed for ${campaignUid}:`, err.message);
    locallyClosedCampaigns.delete(campaignUid.toLowerCase());
    return isAlreadyClosedError(err);
  }
}

async function publishSignature(campaignUid, score, signature) {
  if (!libp2p) throw new Error("P2P node not started");
  const message = {
    type: 'score',
    campaignUid,
    score,
    signature,
    signer: myWallet.address,
    peerId: myPeerId,
    timestamp: Date.now()
  };
  await libp2p.services.pubsub.publish(TOPIC, new TextEncoder().encode(JSON.stringify(message)));
}

async function publishAbstain(campaignUid, reasonCode, signature, reasonLabel = "") {
  if (!libp2p) throw new Error("P2P node not started");
  const message = {
    type: 'abstain',
    campaignUid,
    reason: reasonCode,
    reasonCode,
    reasonLabel,
    signature,
    signer: myWallet.address,
    peerId: myPeerId,
    timestamp: Date.now()
  };
  await libp2p.services.pubsub.publish(TOPIC, new TextEncoder().encode(JSON.stringify(message)));
}

async function checkAndSubmitIfLeader() {
  if (!myWallet) return;

  const now = Date.now();
  const myAddress = myWallet.address.toLowerCase();

  for (const [campaignUid, entry] of pendingCampaigns.entries()) {
    if (entry.quorumReachedAt === null) continue;
    if (!quorumMet(entry)) continue;

    if (isCampaignLocallyClosed(campaignUid)) {
      continue;
    }

    const elapsed = now - entry.quorumReachedAt;
    if (elapsed < LEADER_TIMEOUT_MS) continue;

    const round = Math.floor(elapsed / LEADER_TIMEOUT_MS);
    const currentLeader = leaderForRound(campaignUid, entry.signers, round);
    if (currentLeader !== myAddress) continue;

    console.log(`[P2P] Fallback leader round ${round} for ${campaignUid}`);
    const submitted = await submitAggregatedTransaction(campaignUid, entry);
    if (submitted) pendingCampaigns.delete(campaignUid);
  }
}

module.exports = {
  startP2PNode,
  publishSignature,
  publishAbstain,
  refreshActiveOracles,
  prunePendingCampaigns,
  leaderForRound,
  quorumMet,
  isAlreadyClosedError,
  __setActiveOracleCountForTesting(count) {
    activeOracleCount = count;
  },
  __setActiveOracleAddressesForTesting(addresses) {
    activeOracleAddresses = new Set(addresses);
  },
  __resetForTesting() {
    activeOracleCount = REQUIRED_ORACLES;
    activeOracleAddresses = new Set();
  }
};
