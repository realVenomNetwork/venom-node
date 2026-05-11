'use strict';

const { expect } = require('chai');
const { ethers } = require('ethers');
const {
  PROFILES,
  getProfile,
  getProfileConstants,
  shouldUseBootstrapDiscoveryForProfile,
} = require('../profiles');

describe('profiles', function () {
  it('exports the known deployment profiles', function () {
    expect(Object.keys(PROFILES)).to.include.members(['production', 'canary-01-5', 'canary-03', 'solo']);
  });

  it('returns the canary-03 profile constants', function () {
    const profile = getProfile('canary-03');
    expect(profile.requiredOracles).to.equal(4);
    expect(profile.minStakeEth).to.equal('0.25');
    expect(profile.bootstrapDiscovery).to.equal(false);

    const constants = getProfileConstants('canary-03');
    expect(constants.REQUIRED_ORACLES).to.equal(4);
    expect(constants.MIN_STAKE).to.equal(ethers.parseEther('0.25').toString());
  });

  it('rejects unknown profiles', function () {
    expect(() => getProfile('unknown-profile')).to.throw(/Unknown deploy profile: unknown-profile/);
  });

  it('only enables bootstrap discovery for the canary-01-5 profile', function () {
    expect(shouldUseBootstrapDiscoveryForProfile('canary-01-5')).to.equal(true);
    expect(shouldUseBootstrapDiscoveryForProfile('canary-03')).to.equal(false);
    expect(shouldUseBootstrapDiscoveryForProfile('production')).to.equal(false);
  });
});
