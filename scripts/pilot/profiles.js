'use strict';

const { ethers } = require('ethers');

const QUEUE_SUFFIX_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

const PROFILES = Object.freeze({
  production: Object.freeze({
    requiredOracles: 5,
    scoreQuorumPct: 50,
    participationFloorPct: 67,
    campaignTimeoutBlocks: 7200,
    minStakeEth: '1.0',
    slashPercent: 5,
    maxDeviation: 25,
    bootstrapDiscovery: false,
  }),
  'canary-01-5': Object.freeze({
    requiredOracles: 3,
    scoreQuorumPct: 50,
    participationFloorPct: 67,
    campaignTimeoutBlocks: 3600,
    minStakeEth: '0.1',
    slashPercent: 5,
    maxDeviation: 25,
    bootstrapDiscovery: true,
  }),
  'canary-03': Object.freeze({
    requiredOracles: 4,
    scoreQuorumPct: 50,
    participationFloorPct: 67,
    campaignTimeoutBlocks: 3600,
    minStakeEth: '0.25',
    slashPercent: 5,
    maxDeviation: 25,
    bootstrapDiscovery: false,
  }),
  solo: Object.freeze({
    requiredOracles: 1,
    scoreQuorumPct: 50,
    participationFloorPct: 67,
    campaignTimeoutBlocks: 1800,
    minStakeEth: '0.05',
    slashPercent: 5,
    maxDeviation: 25,
    bootstrapDiscovery: false,
  }),
});

function getProfile(name) {
  const profile = PROFILES[name];
  if (!profile) {
    throw new Error(`Unknown deploy profile: ${name}. Valid profiles: ${Object.keys(PROFILES).join(', ')}`);
  }
  return profile;
}

function getProfileConstants(name) {
  const profile = getProfile(name);
  return Object.freeze({
    REQUIRED_ORACLES: profile.requiredOracles,
    SCORE_QUORUM_PCT: profile.scoreQuorumPct,
    PARTICIPATION_FLOOR_PCT: profile.participationFloorPct,
    CAMPAIGN_TIMEOUT_BLOCKS: profile.campaignTimeoutBlocks,
    MIN_STAKE: ethers.parseEther(profile.minStakeEth).toString(),
    SLASH_PERCENT: profile.slashPercent,
    MAX_DEVIATION: profile.maxDeviation,
  });
}

const PROFILE_CONSTANTS = Object.freeze(
  Object.fromEntries(Object.keys(PROFILES).map((name) => [name, getProfileConstants(name)]))
);

function shouldUseBootstrapDiscoveryForProfile(profileName) {
  return getProfile(profileName).bootstrapDiscovery === true;
}

module.exports = {
  PROFILES,
  PROFILE_CONSTANTS,
  QUEUE_SUFFIX_PATTERN,
  getProfile,
  getProfileConstants,
  shouldUseBootstrapDiscoveryForProfile,
};
