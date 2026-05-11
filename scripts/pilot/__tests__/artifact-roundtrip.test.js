'use strict';

const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ethers } = require('ethers');

const { buildDeploymentArtifact } = require('../build-artifact');
const { getProfile } = require('../profiles');
const { generateOperatorFiles } = require('../make-operator-envs');
const { runCanaryReadiness } = require('../cist/phases/canary-readiness');
const { STATE } = require('../cist/phases');

function buildProfileArtifact(profileName, addressSeed) {
  const rawProfile = getProfile(profileName);
  const profile = {
    name: profileName,
    ...rawProfile,
    minStake: ethers.parseEther(rawProfile.minStakeEth),
  };
  const deployer = ethers.getAddress('0x1111111111111111111111111111111111111111');
  const registry = ethers.getAddress(`0x${String(addressSeed).repeat(40).slice(0, 40)}`);
  const escrow = ethers.getAddress(`0x${String(addressSeed + 1).repeat(40).slice(0, 40)}`);
  const txHash = `0x${'a'.repeat(64)}`;

  return buildDeploymentArtifact({
    networkName: 'base-sepolia',
    chainId: 84532,
    gitCommit: 'abcdef1',
    deployedAt: '2026-05-10T12:00:00.000Z',
    deployerAddress: deployer,
    profile,
    registryOwner: deployer,
    escrowOwner: deployer,
    venomRegistryAddress: registry,
    registryArtifactArguments: [profile.minStake.toString(), 5, 25],
    venomRegistryTxHash: txHash,
    pilotEscrowAddress: escrow,
    escrowConstructorArguments: [
      registry,
      profile.requiredOracles,
      profile.scoreQuorumPct,
      profile.participationFloorPct,
      profile.campaignTimeoutBlocks,
    ],
    pilotEscrowTxHash: txHash,
    bindTxHash: txHash,
    bindBlockNumber: 12345,
    boundEscrow: escrow,
    pendingEscrow: ethers.ZeroAddress,
    escrowRegistry: registry,
  });
}

function constantsContract(constants) {
  return Object.fromEntries(
    Object.entries(constants).map(([key, value]) => [key, async () => value])
  );
}

function walletFactory(index) {
  return new ethers.Wallet(`0x${String(index).padStart(64, '0')}`);
}

describe('deployment artifact to canary readiness round trip', function () {
  let tmpdir;

  beforeEach(function () {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-canary-roundtrip-'));
  });

  afterEach(function () {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  it('generates canary-03 operator files that pass local CIST readiness checks', async function () {
    const artifact = buildProfileArtifact('canary-03', 2);
    const deploymentPath = path.join(tmpdir, 'base-sepolia.json');
    const outDir = path.join(tmpdir, 'operators');
    const composeOut = path.join(tmpdir, 'docker-compose.canary-03.yml');
    fs.writeFileSync(deploymentPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

    generateOperatorFiles({
      count: 4,
      deployment: deploymentPath,
      out: outDir,
      composeOut,
      profile: 'canary-03',
      force: false,
    }, {
      cwd: tmpdir,
      now: () => new Date('2026-05-10T13:00:00.000Z'),
      walletFactory,
      env: {},
    });

    const result = await runCanaryReadiness({
      canaryEnvsDir: outDir,
      localOnly: true,
    }, {
      registryAddress: artifact.contracts.VenomRegistry.address,
      escrowAddress: artifact.contracts.PilotEscrow.address,
      registry: constantsContract(artifact.profile.constants),
      escrow: constantsContract(artifact.profile.constants),
      env: {
        VENOM_REGISTRY_ADDRESS: artifact.contracts.VenomRegistry.address,
        PILOT_ESCROW_ADDRESS: artifact.contracts.PilotEscrow.address,
      },
    });

    expect(result.state).to.equal(STATE.PASS);
    expect(result.codes).to.deep.equal([]);
    expect(result.manifest.profile).to.equal('canary-03');
    expect(result.manifest.operatorCount).to.equal(4);
  });

  it('generates canary-01-5 operator files that pass local CIST readiness checks', async function () {
    const artifact = buildProfileArtifact('canary-01-5', 4);
    const deploymentPath = path.join(tmpdir, 'base-sepolia-canary-01-5.json');
    const outDir = path.join(tmpdir, 'operators-canary-01-5');
    const composeOut = path.join(tmpdir, 'docker-compose.canary-01-5.yml');
    fs.writeFileSync(deploymentPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

    generateOperatorFiles({
      count: 3,
      deployment: deploymentPath,
      out: outDir,
      composeOut,
      profile: 'canary-01-5',
      force: false,
    }, {
      cwd: tmpdir,
      now: () => new Date('2026-05-10T13:00:00.000Z'),
      walletFactory,
      env: {},
    });

    const envText = fs.readFileSync(path.join(outDir, 'operator-1', '.env'), 'utf8');
    expect(envText).to.include('VENOM_SKIP_REGISTRY_DIAL=true');
    expect(envText).to.include('P2P_BOOTSTRAP_PEERS=venom-node-canary-2:42002,venom-node-canary-3:42003');

    const result = await runCanaryReadiness({
      canaryEnvsDir: outDir,
      localOnly: true,
    }, {
      registryAddress: artifact.contracts.VenomRegistry.address,
      escrowAddress: artifact.contracts.PilotEscrow.address,
      registry: constantsContract(artifact.profile.constants),
      escrow: constantsContract(artifact.profile.constants),
      env: {
        VENOM_REGISTRY_ADDRESS: artifact.contracts.VenomRegistry.address,
        PILOT_ESCROW_ADDRESS: artifact.contracts.PilotEscrow.address,
      },
    });

    expect(result.state).to.equal(STATE.PASS);
    expect(result.codes).to.deep.equal([]);
    expect(result.manifest.profile).to.equal('canary-01-5');
    expect(result.manifest.operatorCount).to.equal(3);
  });
});
