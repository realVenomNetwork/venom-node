// scripts/deploy_phase4.js
const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const EXPECTED_CHAIN_IDS = Object.freeze({
  hardhat: 31337,
  "base-sepolia": 84532,
});

const DEPLOY_PROFILES = Object.freeze({
  production: {
    requiredOracles: 5,
    scoreQuorumPct: 50,
    participationFloorPct: 67,
    campaignTimeoutBlocks: 7200,
    minStakeEth: "1.0",
    slashPercent: 5,
    maxDeviation: 25
  },
  "canary-01-5": {
    requiredOracles: 3,
    scoreQuorumPct: 50,
    participationFloorPct: 67,
    campaignTimeoutBlocks: 3600,
    minStakeEth: "0.1",
    slashPercent: 5,
    maxDeviation: 25
  },
  solo: {
    requiredOracles: 1,
    scoreQuorumPct: 50,
    participationFloorPct: 67,
    campaignTimeoutBlocks: 1800,
    minStakeEth: "0.05",
    slashPercent: 5,
    maxDeviation: 25
  }
});

function resolveDeployProfile() {
  const name = process.env.DEPLOY_PROFILE || process.env.CANARY_PROFILE || "production";
  const profile = DEPLOY_PROFILES[name];
  if (!profile) {
    throw new Error(`Unknown deploy profile: ${name}. Valid profiles: ${Object.keys(DEPLOY_PROFILES).join(", ")}`);
  }
  return {
    name,
    ...profile,
    minStake: hre.ethers.parseEther(profile.minStakeEth)
  };
}

function resolveGitCommit() {
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT;
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function maybeVerify(address, constructorArguments) {
  if (hre.network.name === "hardhat") return;
  try {
    await hre.run("verify:verify", { address, constructorArguments });
  } catch (error) {
    console.warn(`[Deploy] Verification skipped/failed for ${address}: ${error.message}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readWithRetry(description, readFn, isExpected, options = {}) {
  const attempts = options.attempts || 6;
  const delayMs = options.delayMs || 2000;
  let lastValue;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    lastValue = await readFn();
    if (isExpected(lastValue)) return lastValue;
    if (attempt < attempts) {
      console.warn(`[Deploy] ${description} not yet visible (attempt ${attempt}/${attempts}); retrying in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }
  return lastValue;
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying Phase 4 contracts with account:", deployer.address);
  const profile = resolveDeployProfile();
  console.log("Deploy profile:", profile.name);
  const network = await hre.ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const expectedChainId = EXPECTED_CHAIN_IDS[hre.network.name];
  if (expectedChainId && chainId !== expectedChainId) {
    throw new Error(`Wrong chain for ${hre.network.name}: expected ${expectedChainId}, got ${chainId}`);
  }
  console.log("Network:", hre.network.name, "chainId:", chainId);

  // 1. Deploy VenomRegistry
  const VenomRegistry = await hre.ethers.getContractFactory("VenomRegistry");
  const registryConstructorArguments = [
    profile.minStake,
    profile.slashPercent,
    profile.maxDeviation,
  ];
  const registryArtifactArguments = [
    profile.minStake.toString(),
    profile.slashPercent,
    profile.maxDeviation,
  ];
  const venomRegistry = await VenomRegistry.deploy(...registryConstructorArguments);
  await venomRegistry.waitForDeployment();
  const venomRegistryAddress = await venomRegistry.getAddress();
  const venomRegistryTx = venomRegistry.deploymentTransaction();
  console.log("VenomRegistry deployed to:", venomRegistryAddress);

  // 2. Deploy PilotEscrow (passing registry address)
  const PilotEscrow = await hre.ethers.getContractFactory("PilotEscrow");
  const escrowConstructorArguments = [
    venomRegistryAddress,
    profile.requiredOracles,
    profile.scoreQuorumPct,
    profile.participationFloorPct,
    profile.campaignTimeoutBlocks,
  ];
  const pilotEscrow = await PilotEscrow.deploy(...escrowConstructorArguments);
  await pilotEscrow.waitForDeployment();
  const pilotEscrowAddress = await pilotEscrow.getAddress();
  const pilotEscrowTx = pilotEscrow.deploymentTransaction();
  console.log("PilotEscrow deployed to:", pilotEscrowAddress);

  // 3. Set PilotEscrow in Registry
  const bindTx = await venomRegistry.setPilotEscrow(pilotEscrowAddress);
  const bindConfirmations = hre.network.name === "hardhat" ? 1 : 3;
  const bindReceipt = await bindTx.wait(bindConfirmations);
  console.log("PilotEscrow address set in VenomRegistry");

  const boundEscrow = await readWithRetry(
    "Registry PilotEscrow bind",
    () => venomRegistry.pilotEscrow(),
    (value) => value.toLowerCase() === pilotEscrowAddress.toLowerCase()
  );
  const [pendingEscrow, registryOwner, escrowOwner, escrowRegistry] = await Promise.all([
    venomRegistry.pendingPilotEscrow(),
    venomRegistry.owner(),
    pilotEscrow.owner(),
    pilotEscrow.registry(),
  ]);
  if (boundEscrow.toLowerCase() !== pilotEscrowAddress.toLowerCase()) {
    throw new Error(`Registry bound escrow mismatch: expected ${pilotEscrowAddress}, got ${boundEscrow}`);
  }
  if (pendingEscrow !== hre.ethers.ZeroAddress) {
    throw new Error(`Unexpected pending PilotEscrow after initial bind: ${pendingEscrow}`);
  }
  if (escrowRegistry.toLowerCase() !== venomRegistryAddress.toLowerCase()) {
    throw new Error(`PilotEscrow registry mismatch: expected ${venomRegistryAddress}, got ${escrowRegistry}`);
  }

  const [registryCode, escrowCode] = await Promise.all([
    hre.ethers.provider.getCode(venomRegistryAddress),
    hre.ethers.provider.getCode(pilotEscrowAddress),
  ]);
  if (!registryCode || registryCode === "0x") throw new Error("VenomRegistry bytecode missing after deploy");
  if (!escrowCode || escrowCode === "0x") throw new Error("PilotEscrow bytecode missing after deploy");

  const artifact = {
    schemaVersion: 1,
    network: hre.network.name,
    chainId,
    gitCommit: resolveGitCommit(),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    profile: {
      name: profile.name,
      constants: {
        REQUIRED_ORACLES: profile.requiredOracles,
        SCORE_QUORUM_PCT: profile.scoreQuorumPct,
        PARTICIPATION_FLOOR_PCT: profile.participationFloorPct,
        CAMPAIGN_TIMEOUT_BLOCKS: profile.campaignTimeoutBlocks,
        MIN_STAKE: profile.minStake.toString(),
        SLASH_PERCENT: profile.slashPercent,
        MAX_DEVIATION: profile.maxDeviation,
      },
    },
    owners: {
      VenomRegistry: registryOwner,
      PilotEscrow: escrowOwner,
    },
    contracts: {
      VenomRegistry: {
        address: venomRegistryAddress,
        constructorArguments: registryArtifactArguments,
        deploymentTxHash: venomRegistryTx ? venomRegistryTx.hash : null,
      },
      PilotEscrow: {
        address: pilotEscrowAddress,
        constructorArguments: escrowConstructorArguments,
        deploymentTxHash: pilotEscrowTx ? pilotEscrowTx.hash : null,
      },
    },
    binding: {
      txHash: bindReceipt ? (bindReceipt.hash || bindReceipt.transactionHash) : bindTx.hash,
      blockNumber: bindReceipt ? Number(bindReceipt.blockNumber) : null,
      registryPilotEscrow: boundEscrow,
      pendingPilotEscrow: pendingEscrow,
      escrowRegistry,
    },
  };
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(deploymentsDir, { recursive: true });
  const artifactPath = path.join(deploymentsDir, `${hre.network.name}.json`);
  fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log("Deployment artifact written to:", artifactPath);

  await maybeVerify(venomRegistryAddress, registryArtifactArguments);
  await maybeVerify(pilotEscrowAddress, escrowConstructorArguments);

  console.log("\n=== Phase 4 Deployment Complete ===");
  console.log("VENOM_REGISTRY_ADDRESS=", venomRegistryAddress);
  console.log("PILOT_ESCROW_ADDRESS=", pilotEscrowAddress);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
