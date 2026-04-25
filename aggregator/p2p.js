// aggregator/p2p.js
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
let myWallet; // Will be set from register_and_start.js

async function startP2PNode(wallet) {
  myWallet = wallet; // Store for later use in submitAggregatedTransaction

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
  console.log("[P2P] Fully decentralized node ready");
  
  return libp2p;
}

async function handleSignatureMessage(evt) {
  try {
    const data = JSON.parse(new TextDecoder().decode(evt.detail.data));
    const { campaignUid, score, signature, oracle } = data;

    if (!pendingCampaigns.has(campaignUid)) {
      pendingCampaigns.set(campaignUid, { scores: [], signatures: [], signers: [] });
    }

    const entry = pendingCampaigns.get(campaignUid);

    if (entry.signers.includes(oracle)) return; // duplicate

    entry.scores.push(score);
    entry.signatures.push(signature);
    entry.signers.push(oracle);

    console.log(`[P2P] Received signature for ${campaignUid} (${entry.signers.length}/${REQUIRED_ORACLES})`);

    // Check if we are the leader and have enough signatures
    if (entry.signers.length >= REQUIRED_ORACLES) {
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
  // Simplified for v1.0.0 — in v1.1 we will make this dynamic
  const activeCount = 5;
  const campaignBigInt = BigInt(campaignUid);
  return Number(campaignBigInt % BigInt(activeCount)) === 0; // First in list wins
}

async function submitAggregatedTransaction(campaignUid, entry) {
  try {
    const recipient = myWallet.address; // ← FIXED: bounty goes to the operator who submits
    const bounty = ethers.parseEther("0.001");
    const payloadNonce = 0;

    console.log(`[P2P] Submitting aggregated tx for ${campaignUid} with ${entry.signers.length} signatures...`);

    const pilotEscrow = new ethers.Contract(PILOT_ESCROW_ADDRESS, [
      "function closeCampaign(bytes32,address,uint256,uint256,uint256[],bytes[]) external"
    ], myWallet);

    const tx = await pilotEscrow.closeCampaign(
      campaignUid,
      recipient,
      bounty,
      payloadNonce,
      entry.scores,
      entry.signatures
    );

    const receipt = await tx.wait();
    console.log(`✅ SUCCESS: Campaign closed in block ${receipt.blockNumber} — bounty sent to ${recipient}`);
  } catch (err) {
    console.error(`❌ Submission failed for ${campaignUid}:`, err.message);
  }
}

async function publishSignature(campaignUid, score, signature) {
  const message = { campaignUid, score, signature, oracle: myPeerId, timestamp: Date.now() };
  await libp2p.services.pubsub.publish(TOPIC, new TextEncoder().encode(JSON.stringify(message)));
}

async function checkAndSubmitIfLeader() { /* unchanged */ }

module.exports = { startP2PNode, publishSignature };
