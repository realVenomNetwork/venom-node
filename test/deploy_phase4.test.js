const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("hardhat");
const { getProfile } = require("../scripts/pilot/profiles");
const { buildDeploymentArtifact } = require("../scripts/pilot/build-artifact");
const { validateDeploymentArtifact } = require("../scripts/pilot/make-operator-envs");

describe("Regression: deployment bind finality", function () {
  it("waits for public-network confirmations and reads the bind back with retry", function () {
    // Regression: MAIN-FIX-4
    const text = fs.readFileSync(path.resolve(__dirname, "../scripts/deploy_phase4.js"), "utf8");

    expect(text).to.match(/const\s+bindConfirmations\s*=\s*hre\.network\.name\s*===\s*"hardhat"\s*\?\s*1\s*:\s*3\s*;/);
    expect(text).to.match(/await\s+bindTx\.wait\(\s*bindConfirmations\s*\)/);
    expect(text).to.include("readWithRetry(");
    expect(text).to.include('"Registry PilotEscrow bind"');
  });

  it("uses the shared deployment profiles module", function () {
    const text = fs.readFileSync(path.resolve(__dirname, "../scripts/deploy_phase4.js"), "utf8");

    expect(text).to.match(/require\(['"]\.\/pilot\/profiles['"]\)/);
    expect(text).to.match(/const\s+profile\s*=\s*getProfile\(/);
    expect(text).to.not.match(/const\s+DEPLOY_PROFILES\s*=\s*Object\.freeze\(\{/);
  });

  it("builds deployment artifacts from the shared canary-03 profile", function () {
    const rawProfile = getProfile("canary-03");
    const profile = {
      name: "canary-03",
      ...rawProfile,
      minStake: ethers.parseEther(rawProfile.minStakeEth),
    };
    const deployer = ethers.getAddress("0x1111111111111111111111111111111111111111");
    const registry = ethers.getAddress("0x2222222222222222222222222222222222222222");
    const escrow = ethers.getAddress("0x3333333333333333333333333333333333333333");
    const txHash = `0x${"a".repeat(64)}`;

    const artifact = buildDeploymentArtifact({
      networkName: "base-sepolia",
      chainId: 84532,
      gitCommit: "abcdef1",
      deployedAt: "2026-05-10T12:00:00.000Z",
      deployerAddress: deployer,
      profile,
      registryOwner: deployer,
      escrowOwner: deployer,
      venomRegistryAddress: registry,
      registryArtifactArguments: [profile.minStake.toString(), 5, 25],
      venomRegistryTxHash: txHash,
      pilotEscrowAddress: escrow,
      escrowConstructorArguments: [registry, 4, 50, 67, 3600],
      pilotEscrowTxHash: txHash,
      bindTxHash: txHash,
      bindBlockNumber: 12345,
      boundEscrow: escrow,
      pendingEscrow: ethers.ZeroAddress,
      escrowRegistry: registry,
    });

    expect(artifact).to.deep.include({
      schemaVersion: 1,
      network: "base-sepolia",
      chainId: 84532,
      gitCommit: "abcdef1",
      deployedAt: "2026-05-10T12:00:00.000Z",
      deployer,
    });
    expect(artifact.profile.name).to.equal("canary-03");
    expect(artifact.profile.constants).to.deep.equal({
      REQUIRED_ORACLES: 4,
      SCORE_QUORUM_PCT: 50,
      PARTICIPATION_FLOOR_PCT: 67,
      CAMPAIGN_TIMEOUT_BLOCKS: 3600,
      MIN_STAKE: "250000000000000000",
      SLASH_PERCENT: 5,
      MAX_DEVIATION: 25,
    });
    expect(artifact.contracts.VenomRegistry.address).to.equal(registry);
    expect(artifact.contracts.PilotEscrow.address).to.equal(escrow);
    expect(artifact.binding.registryPilotEscrow).to.equal(escrow);
    expect(artifact.binding.pendingPilotEscrow).to.equal(ethers.ZeroAddress);

    const validated = validateDeploymentArtifact(artifact, "canary-03");
    expect(validated.profile).to.equal("canary-03");
    expect(validated.constants.REQUIRED_ORACLES).to.equal(4);
  });
});
