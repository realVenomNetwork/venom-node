'use strict';

const { expect } = require('chai');
const p2p = require('../aggregator/p2p');

describe('p2p runtime status', function () {
  beforeEach(function () {
    p2p.__resetForTesting();
  });

  it('reports a stopped node before startup', function () {
    const status = p2p.getNodeStatus();

    expect(status.started).to.equal(false);
    expect(status.peerId).to.equal(null);
    expect(status.peerCount).to.equal(0);
    expect(status.requiredOracles).to.equal(5);
    expect(status.quorumConstantsLoaded).to.equal(false);
    expect(status.pendingCampaignCount).to.equal(0);
  });

  it('reports active oracle count from the runtime cache', function () {
    p2p.__setActiveOracleCountForTesting(4);

    const status = p2p.getNodeStatus();
    expect(status.activeOracleCount).to.equal(4);
  });
});
