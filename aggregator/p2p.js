// aggregator/p2p.js
// Libp2p gossip aggregation for signed score and abstain messages.

const { ethers } = require('ethers');

const REQUIRED_ORACLES = 5;
const TOPIC = 'venom:signatures';

let libp2p;
let libp2pModules;
let leaderInterval;
let activeOracleCount = REQUIRED_ORACLES;
let pendingCampaigns = new Map();
let myPeerId;
let myWallet;

async function loadLibp2pModules() {
  if (libp2pModules) return libp2pModules;

  const [
    libp2pPkg,
    gossipsubPkg,
    tcpPkg,
    noisePkg,
    mplexPkg,
    multiaddrPkg
  ] = await Promise.all([
    import('libp2p'),
    import('@chainsafe/libp2p-gossipsub'),
    import('@libp2p/tcp'),
    import('@chainsafe/libp2p-noise'),
    import('@libp2p/mplex'),
    import('@multiformats/multiaddr')
  ]);

  libp2pModules = {
    createLibp2p: libp2pPkg.createLibp2p,
    gossipsub: gossipsubPkg.gossipsub,
    tcp: tcpPkg.tcp,
    noise: noisePkg.noise,
    mplex: mplexPkg.mplex,
    multiaddr: multiaddrPkg.multiaddr
  };
  return libp2pModules;
}

async function startP2PNode(wallet) {
  myWallet = wallet;

  const registryAddress = process.env.VENOM_REGISTRY_ADDRESS;
  if (!registryAddress) throw new Error("Missing VENOM_REGISTRY_ADDRESS");

  const { createLibp2p, gossipsub, tcp, noise, mplex, multiaddr } = await loadLibp2pModules();

  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const registry = new ethers.Contract(registryAddress, [
    "function getActiveOracles() view returns (address[] operators, string[] multiaddrs)"
  ], provider);

  const [operators, multiaddrs] = await registry.getActiveOracles();
  activeOracleCount = Math.max(operators.length, 1);
  console.log(`[P2P] Found ${operators.length} active oracles on-chain`);

  libp2p = await createLibp2p({
    addresses: { listen: ['/ip4/0.0.0.0/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [mplex()],
    services: { pubsub: gossipsub({ allowPublishToZeroPeers: true }) }
  });

  myPeerId = libp2p.peerId.toString();
  console.log(`VENOM P2P node started: ${myPeerId}`);

  for (const addr of multiaddrs) {
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
  const originalStop = libp2p.stop.bind(libp2p);
  libp2p.stop = async () => {
    if (leaderInterval) {
      clearInterval(leaderInterval);
      leaderInterval = null;
    }
    await originalStop();
  };

  console.log("[P2P] Node ready (v1.1 signed abstention + closeCampaign ABI)");
  return libp2p;
}

async function handleSignatureMessage(evt) {
  try {
    const data = JSON.parse(new TextDecoder().decode(evt.detail.data));
    const { campaignUid, type = 'score', score, signature, reason, oracle } = data;

    if (!pendingCampaigns.has(campaignUid)) {
      pendingCampaigns.set(campaignUid, {
        scores: [],
        signatures: [],
        signers: [],
        abstainSignatures: [],
        abstainReasons: [],
        abstainSigners: []
      });
    }

    const entry = pendingCampaigns.get(campaignUid);

    if (type === 'abstain') {
      if (entry.abstainSigners.includes(oracle)) return;
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
    if (totalMessages >= REQUIRED_ORACLES && await isLeaderForCampaign(campaignUid)) {
      await submitAggregatedTransaction(campaignUid, entry);
      pendingCampaigns.delete(campaignUid);
    }
  } catch (err) {
    console.error("[P2P] Error handling message:", err.message);
  }
}

async function isLeaderForCampaign(campaignUid) {
  const campaignBigInt = BigInt(campaignUid);
  return Number(campaignBigInt % BigInt(activeOracleCount)) === 0;
}

async function submitAggregatedTransaction(campaignUid, entry) {
  try {
    const pilotEscrowAddress = process.env.PILOT_ESCROW_ADDRESS;
    if (!pilotEscrowAddress) throw new Error("Missing PILOT_ESCROW_ADDRESS");

    console.log(`[P2P] Submitting closeCampaign for ${campaignUid} with ${entry.signers.length} scores + ${entry.abstainSigners.length} abstains...`);

    const pilotEscrow = new ethers.Contract(pilotEscrowAddress, [
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
    console.log(`SUCCESS: Campaign closed in block ${receipt.blockNumber}`);
  } catch (err) {
    console.error(`Submission failed for ${campaignUid}:`, err.message);
  }
}

async function publishSignature(campaignUid, score, signature) {
  if (!libp2p) throw new Error("P2P node not started");
  const message = { campaignUid, score, signature, oracle: myPeerId, timestamp: Date.now() };
  await libp2p.services.pubsub.publish(TOPIC, new TextEncoder().encode(JSON.stringify(message)));
}

async function publishAbstain(campaignUid, reason, signature) {
  if (!libp2p) throw new Error("P2P node not started");
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

async function checkAndSubmitIfLeader() {
  // Reserved for timeout/retry leadership checks. Normal submission is message-driven.
}

module.exports = { startP2PNode, publishSignature, publishAbstain };
