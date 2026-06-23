'use strict';

function buildDeploymentArtifact(params) {
  return {
    schemaVersion: 1,
    network: params.networkName,
    chainId: params.chainId,
    gitCommit: params.gitCommit,
    deployedAt: params.deployedAt || new Date().toISOString(),
    deployer: params.deployerAddress,
    profile: {
      name: params.profile.name,
      constants: {
        REQUIRED_ORACLES: params.profile.requiredOracles,
        SCORE_QUORUM_PCT: params.profile.scoreQuorumPct,
        PARTICIPATION_FLOOR_PCT: params.profile.participationFloorPct,
        CAMPAIGN_TIMEOUT_BLOCKS: params.profile.campaignTimeoutBlocks,
        MIN_STAKE: params.profile.minStake.toString(),
        SLASH_PERCENT: params.profile.slashPercent,
        MAX_DEVIATION: params.profile.maxDeviation,
      },
    },
    owners: {
      VenomRegistry: params.registryOwner,
      PilotEscrow: params.escrowOwner,
    },
    contracts: {
      VenomRegistry: {
        address: params.venomRegistryAddress,
        constructorArguments: params.registryArtifactArguments,
        deploymentTxHash: params.venomRegistryTxHash,
      },
      ConsentManager: {
        address: params.consentManagerAddress,
      },
      TitheManager: {
        address: params.titheManagerAddress,
      },
      PilotEscrow: {
        address: params.pilotEscrowAddress,
        constructorArguments: params.escrowConstructorArguments,
        deploymentTxHash: params.pilotEscrowTxHash,
      },
    },
    binding: {
      txHash: params.bindTxHash,
      blockNumber: params.bindBlockNumber,
      registryPilotEscrow: params.boundEscrow,
      pendingPilotEscrow: params.pendingEscrow,
      escrowRegistry: params.escrowRegistry,
    },
  };
}

module.exports = { buildDeploymentArtifact };
