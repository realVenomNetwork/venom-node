// aggregator/p2p.js
// VENOM Node v1.1.0-rc.1 — Final Signed Abstention + New closeCampaign ABI
// Now fully compatible with Claude's v1.1 contract (passes both score and abstain arrays).

const { createLibp2p } = require('libp2p');
const { gossipsub } = require('@chainsafe/libp2p-gossipsub');
const { tcp } = require('@libp2p/tcp');
const { noise } = require('@chainsafe/libp2p-noise');
const { mplex } = require('@libp2p/mplex');
const { multiaddr } = require('@multiformats/multiaddr');
const { ethers } = require('ethers');

const VENOM_REGISTRY_ADDRESS = process.env.VENOM_REGISTRY_ADDRESS;
const PILOT_ESCROW_ADDRESS = process.env.PILOT_ESCROW_ADDRESS;
const REQUIRED_ORACLES = 5;
const TOPIC = 'venom:signatures';

let libp2p;
let pendingCampaigns = new Map();
let myPeerId;
let myWallet;

async function startP2PNode(wallet) {
  myWallet = wallet;

  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const registry = new ethers.Contract(VENOM_REGISTRY_ADDRESS, [
    "function getActiveOracles() view returns (address[] operators, string[] multiaddrs)"
  ], provider);

  const [operators, multiaddrs] = await registry.getActiveOracles();
  console.log(`[P2P] Found ${operators.length} active oracles on-chain`);

  libp2p = await createLibp2p({
    addresses: { listen: ['/ip4/0.0.0.0/tcp/0'] },
    transports: [tcp()],
    connectionEncryption: [noise()],
    streamMuxers: [mplex()],
    services: { pubsub: gossipsub({ allowPublishToZeroPeers: true }) }
  });

  myPeerId = libp2p.peerId.toString();
  console.log(`🚀 VENOM P2P Node started: ${myPeerId}`);

  for (const addr of multiaddrs) {
    if (addr && addr.length > 0) {
      try {
        await libp2p.dial(multiaddr(addr));
        console.log(`[P2P] Connected to on-chain peer: ${addr}`);
      } catch (e) {
        console.warn(`[P2P] Failed to dial ${addr}`);
      }
    }
  }

  await libp2p.services.pubsub.subscribe(TOPIC);
  libp2p.services.pubsub.addEventListener('message', handleSignatureMessage);

  setInterval(checkAndSubmitIfLeader, 5000);
  console.log("[P2P] Fully decentralized node ready (v1.1 signed abstention + new ABI)");
  
  return libp2p;
}

async function handleSignatureMessage(evt) {
  try {
    const data = JSON.parse(new TextDecoder().decode(evt.detail.data));
    const { campaignUid, type = 'score', score, signature, reason, oracle } = data;

    if (!pendingCampaigns.has(campaignUid)) {
      pendingCampaigns.set(campaignUid, {
        scores: [], signatures: [], signers: [],
        abstains: [], abstainSignatures: [], abstainReasons: [], abstainSigners: []
      });
    }

    const entry = pendingCampaigns.get(campaignUid);

    if (type === 'abstain') {
      if (entry.abstainSigners.includes(oracle)) return;
      entry.abstains.push(reason);
      entry.abstainSignatures.push(signature);
      entry.abstainReasons.push(reason);
      entry.abstainSigners.push(oracle);
      console.log(`[P2P] Received ABSTAIN for ${campaignUid} (${entry.abstainSigners.length} abstains)`);
    } else {
      if (entry.signers.includes(oracle)) return;
      entry.scores.push(score);
      entry.signatures.push(signature);
      entry.signers.push(oracle);
      console.log(`[P2P] Received SCORE for ${campaignUid} (${entry.signers.length}/${REQUIRED_ORACLES})`);
    }

    const totalMessages = entry.signers.length + entry.abstainSigners.length;
    if (totalMessages >= REQUIRED_ORACLES) {
      const isLeader = await isLeaderForCampaign(campaignUid);
      if (isLeader) {
        await submitAggregatedTransaction(campaignUid, entry);
        pendingCampaigns.delete(campaignUid);
      }
    }
  } catch (err) {
    console.error("[P2P] Error handling message:", err.message);
  }
}

async function isLeaderForCampaign(campaignUid) {
  const activeCount = 5;
  const campaignBigInt = BigInt(campaignUid);
  return Number(campaignBigInt % BigInt(activeCount)) === 0;
}

async function submitAggregatedTransaction(campaignUid, entry) {
  try {
    const recipient = myWallet.address;
    const bounty = ethers.parseEther("0.001");
    const payloadNonce = 0;

    console.log(`[P2P] Submitting v1.1 closeCampaign for ${campaignUid} with ${entry.signers.length} scores + ${entry.abstainSigners.length} abstains...`);

    const pilotEscrow = new ethers.Contract(PILOT_ESCROW_ADDRESS, [
      // v1.1 ABI — now accepts both score and abstain arrays
      "function closeCampaign(bytes32,uint256[],bytes[],uint8[],bytes[]) external"
    ], myWallet);

    const tx = await pilotEscrow.closeCampaign(
      campaignUid,
      entry.scores,
      entry.signatures,
      entry.abstainReasons,
      entry.abstainSignatures
    );

    const receipt = await tx.wait();
    console.log(`✅ SUCCESS: Campaign closed in block ${receipt.blockNumber}`);
  } catch (err) {
    console.error(`❌ Submission failed for ${campaignUid}:`, err.message);
  }
}

async function publishSignature(campaignUid, score, signature) {
  const message = { campaignUid, score, signature, oracle: myPeerId, timestamp: Date.now() };
  await libp2p.services.pubsub.publish(TOPIC, new TextEncoder().encode(JSON.stringify(message)));
}

async function publishAbstain(campaignUid, reason, signature) {
  const message = {
    type: 'abstain',
    campaignUid,
    reason,
    signature,
    oracle: myPeerId,
    timestamp: Date.now()
  };
  await libp2p.services.pubsub.publish(TOPIC, new TextEncoder().encode(JSON.stringify(message)));
}

async function checkAndSubmitIfLeader() { /* unchanged */ }

module.exports = { startP2PNode, publishSignature, publishAbstain };
