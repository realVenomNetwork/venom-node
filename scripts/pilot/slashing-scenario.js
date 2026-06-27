#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { ethers } = require("ethers");
const IORedis = require("ioredis");

const BASE_SEPOLIA_CHAIN_ID = 84532;
const PILOT_ESCROW_ABI = [
  "function fundCampaign(bytes32 campaignUid, string calldata _contentUri, bytes32 _contentHash) external payable",
  "function campaigns(bytes32) view returns (address recipient, uint256 bounty, bool closed, uint256 fundedBlock, string contentUri, bytes32 contentHash)",
  "event CampaignFunded(bytes32 indexed campaignUid, address indexed funder, uint256 amount, string contentUri, bytes32 contentHash)",
  "event CampaignClosed(bytes32 indexed campaignUid, address indexed recipient, uint256 bounty, uint256 medianScore)",
  "event DeviationReported(bytes32 indexed campaignUid, address indexed oracle, uint256 submittedScore, uint256 medianScore, uint256 deviation)"
];
const VENOM_REGISTRY_ABI = [
  "function oracles(address) view returns (address operator, uint256 stake, uint256 scoreCount, uint256 lastActive, bool active, string multiaddr)",
  "function isActiveOracle(address) view returns (bool)",
  "function activeOracleCount() view returns (uint256)",
  "event OracleSlashed(address indexed operator, uint256 amount, string reason)",
  "event SlashSkipped(address indexed operator, string reason)"
];

function parseArgs(argv) {
  const args = { profile: "canary-05", deviation: 30, targetIndex: null, campaignUid: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--profile" && i + 1 < argv.length) args.profile = argv[++i];
    if (argv[i] === "--deviation" && i + 1 < argv.length) args.deviation = parseInt(argv[++i], 10);
    if (argv[i] === "--target-index" && i + 1 < argv.length) args.targetIndex = parseInt(argv[++i], 10);
    if (argv[i] === "--campaign-uid" && i + 1 < argv.length) args.campaignUid = argv[++i];
  }
  return args;
}

function loadEnv(envPath) {
  const env = {};
  if (!fs.existsSync(envPath)) return env;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

function loadDeploymentArtifact(profile) {
  const artifactPath = path.resolve(`deployments/base-sepolia-${profile}.json`);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Deployment artifact not found: ${artifactPath}`);
  }
  return JSON.parse(fs.readFileSync(artifactPath, "utf8"));
}

function discoverOperatorEnvs(baseDir) {
  const operators = [];
  if (!fs.existsSync(baseDir)) {
    throw new Error(`Operator env directory not found: ${baseDir}`);
  }
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith("operator-")) {
      const envPath = path.join(baseDir, entry.name, ".env");
      const env = loadEnv(envPath);
      if (env.OPERATOR_PRIVATE_KEY && env.VENOM_REGISTRY_ADDRESS) {
        operators.push({
          id: entry.name,
          envPath,
          env,
          address: new ethers.Wallet(env.OPERATOR_PRIVATE_KEY).address
        });
      }
    }
  }
  return operators.sort((a, b) => a.id.localeCompare(b.id));
}

function createProvider(rpcUrls) {
  const urls = rpcUrls.split(",").map(u => u.trim()).filter(Boolean);
  for (const url of urls) {
    try {
      const provider = new ethers.JsonRpcProvider(url, BASE_SEPOLIA_CHAIN_ID);
      return provider;
    } catch {}
  }
  throw new Error("No valid RPC provider available");
}

function waitFor(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fundCampaign(provider, artifact, args, funderKey, contentUri, contentHash) {
  const wallet = new ethers.Wallet(funderKey, provider);
  const escrow = new ethers.Contract(artifact.PilotEscrow, PILOT_ESCROW_ABI, wallet);
  const uid = args.campaignUid || ethers.keccak256(ethers.toUtf8Bytes(`slashing-test-${Date.now()}`));
  const bounty = ethers.parseEther("0.005");
  const tx = await escrow.fundCampaign(uid, contentUri, contentHash, { value: bounty });
  const receipt = await tx.wait(3);
  return { uid, receipt, bounty };
}

async function getOperatorStake(registry, address) {
  const oracle = await registry.oracles(address);
  return { stake: oracle.stake, active: oracle.active };
}

async function startOperators(operators, baseDir, injectConfig) {
  const procs = [];
  for (let i = 0; i < operators.length; i++) {
    const op = operators[i];
    const env = { ...process.env, ...op.env };
    if (i === injectConfig.targetIndex && injectConfig.score !== null) {
      env.VENOM_TEST_INJECT_SCORE = String(injectConfig.score);
    }
    const proc = spawn("node", ["register_and_start.js"], {
      cwd: path.resolve("."),
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    proc.stdout.on("data", d => process.stdout.write(`[${op.id}] ${d}`));
    proc.stderr.on("data", d => process.stderr.write(`[${op.id}] ${d}`));
    procs.push({ id: op.id, proc, address: op.address });
  }
  return procs;
}

function stopOperators(procs) {
  for (const { proc } of procs) {
    try { proc.kill("SIGTERM"); } catch {}
  }
}

async function setupRedisPubSub(redisUrl) {
  const pub = new IORedis(redisUrl);
  const sub = new IORedis(redisUrl);
  return { pub, sub };
}

async function waitForEvent(contract, eventName, filter, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      contract.removeAllListeners(eventName);
      reject(new Error(`Timeout waiting for ${eventName}`));
    }, timeoutMs);
    contract.on(eventName, (...args) => {
      const event = args[args.length - 1];
      if (filter && !filter(event)) return;
      clearTimeout(timer);
      contract.removeAllListeners(eventName);
      resolve(event);
    });
  });
}

async function main() {
  const timeline = [];
  const log = (msg) => {
    const entry = `[${new Date().toISOString()}] ${msg}`;
    timeline.push(entry);
    console.log(entry);
  };

  const args = parseArgs(process.argv.slice(2));
  log(`Starting slashing scenario: profile=${args.profile}, deviation=${args.deviation}`);

  const artifact = loadDeploymentArtifact(args.profile);
  const baseDir = `.venom-${args.profile}`;
  const operators = discoverOperatorEnvs(baseDir);

  const minOperators = (args.targetIndex !== null ? args.targetIndex : 2) + 1;
  if (operators.length < minOperators) {
    throw new Error(`Need at least ${minOperators} operators, found ${operators.length}`);
  }
  log(`Discovered ${operators.length} operators`);
  operators.forEach(op => log(`  ${op.id}: ${op.address}`));

  const deployerEnv = loadEnv(".env");
  const provider = createProvider(deployerEnv.RPC_URLS || deployerEnv.RPC_URL);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(`Wrong chain: expected ${BASE_SEPOLIA_CHAIN_ID}, got ${network.chainId}`);
  }

  const registry = new ethers.Contract(artifact.VenomRegistry, VENOM_REGISTRY_ABI, provider);
  const escrow = new ethers.Contract(artifact.PilotEscrow, PILOT_ESCROW_ABI, provider);

  const activeCount = await registry.activeOracleCount();
  log(`Active oracle count: ${activeCount}`);
  if (Number(activeCount) < operators.length) {
    throw new Error(`Not all operators registered: ${activeCount} < ${operators.length}`);
  }

  const stakesBefore = {};
  for (const op of operators) {
    const { stake } = await getOperatorStake(registry, op.address);
    stakesBefore[op.address] = stake;
    log(`${op.id} stake before: ${ethers.formatEther(stake)} ETH`);
  }

  const content = JSON.stringify({
    payload: "The DAO should allocate 8% of treasury to public goods. This strengthens ecosystem reputation and attracts talent while preserving 92% runway.",
    reference_answer: "The DAO should carefully weigh the pros and cons of treasury allocation."
  });
  const contentHash = ethers.keccak256(ethers.toUtf8Bytes(content));
  const contentUri = `data:application/json;base64,${Buffer.from(content).toString("base64")}`;

  const funderKey = deployerEnv.DEPLOYER_PRIVATE_KEY || deployerEnv.OPERATOR_PRIVATE_KEY;
  if (!funderKey) {
    throw new Error("No funder key available");
  }

  log("Funding campaign...");
  const { uid: campaignUid, receipt: fundReceipt } = await fundCampaign(
    provider, artifact, args, funderKey, contentUri, contentHash
  );
  log(`Campaign funded: ${campaignUid}, tx: ${fundReceipt.hash}`);

  const campaign = await escrow.campaigns(campaignUid);
  log(`Campaign bounty: ${ethers.formatEther(campaign.bounty)} ETH`);

  const targetIndex = args.targetIndex !== null ? args.targetIndex : operators.length - 1;
  const medianScore = 70;
  const injectedScore = medianScore + args.deviation;
  log(`Target operator: ${operators[targetIndex].id} (index ${targetIndex})`);
  log(`Valid scores: ${medianScore}, Injected score: ${injectedScore} (deviation: +${args.deviation})`);

  log("Starting operators...");
  const procs = await startOperators(operators, baseDir, {
    targetIndex,
    score: injectedScore
  });

  log("Waiting for scores to propagate...");
  await waitFor(30000);

  log("Waiting for CampaignClosed event...");
  const closeEvent = await waitForEvent(escrow, "CampaignClosed", (e) => {
    return e.args.campaignUid.toLowerCase() === campaignUid.toLowerCase();
  }, 300000);
  log(`Campaign closed: median=${closeEvent.args.medianScore}, bounty=${ethers.formatEther(closeEvent.args.bounty)} ETH`);

  log("Waiting for DeviationReported event...");
  let deviationEvent;
  try {
    deviationEvent = await waitForEvent(escrow, "DeviationReported", (e) => {
      return e.args.campaignUid.toLowerCase() === campaignUid.toLowerCase();
    }, 120000);
    log(`Deviation reported: oracle=${deviationEvent.args.oracle}, submitted=${deviationEvent.args.submittedScore}, median=${deviationEvent.args.medianScore}, deviation=${deviationEvent.args.deviation}`);
  } catch {
    log("No DeviationReported event observed (may be emitted by close tx)");
  }

  log("Waiting for OracleSlashed event...");
  const slashEvent = await waitForEvent(registry, "OracleSlashed", (e) => {
    return e.args.operator.toLowerCase() === operators[targetIndex].address.toLowerCase();
  }, 120000);
  log(`Oracle slashed: ${slashEvent.args.operator}, amount=${ethers.formatEther(slashEvent.args.amount)} ETH, reason=${slashEvent.args.reason}`);

  log("Verifying stake reduction...");
  const stakesAfter = {};
  for (const op of operators) {
    const { stake } = await getOperatorStake(registry, op.address);
    stakesAfter[op.address] = stake;
    const before = stakesBefore[op.address];
    const diff = before - stake;
    log(`${op.id} stake after: ${ethers.formatEther(stake)} ETH (delta: ${ethers.formatEther(diff)} ETH)`);
  }

  const targetBefore = stakesBefore[operators[targetIndex].address];
  const targetAfter = stakesAfter[operators[targetIndex].address];
  const slashAmount = targetBefore - targetAfter;
  const slashPercent = Number(slashEvent.args.amount) * 100n / targetBefore;

  log(`\n=== SLASHING VERIFICATION ===`);
  log(`Target operator: ${operators[targetIndex].id} (${operators[targetIndex].address})`);
  log(`Stake before: ${ethers.formatEther(targetBefore)} ETH`);
  log(`Stake after:  ${ethers.formatEther(targetAfter)} ETH`);
  log(`Slash amount: ${ethers.formatEther(slashAmount)} ETH`);
  log(`Slash percent: ${slashPercent}%`);

  const slashPct = BigInt(artifact.profile?.constants?.SLASH_PERCENT || 5);
  const expectedSlash = (targetBefore * slashPct) / 100n;
  const tolerance = expectedSlash / 100n;
  const success = slashAmount >= expectedSlash - tolerance && slashAmount <= expectedSlash + tolerance;

  log(`\n=== TIMELINE ===`);
  timeline.forEach(t => console.log(t));

  stopOperators(procs);

  if (success) {
    log(`\nSUCCESS: Slashing verified. ${operators[targetIndex].id} stake reduced by ~5%`);
    process.exit(0);
  } else {
    log(`\nFAILURE: Slash amount mismatch. Expected ~${ethers.formatEther(expectedSlash)} ETH, got ${ethers.formatEther(slashAmount)} ETH`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
