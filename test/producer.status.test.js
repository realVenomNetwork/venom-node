'use strict';

const { expect } = require('chai');
const producer = require('../aggregator/producer');

describe('producer runtime status', function () {
  it('reports an idle producer before startup', function () {
    const status = producer.getProducerStatus();

    expect(status.running).to.equal(false);
    expect(status.lastScannedBlock).to.equal(null);
    expect(status.lastScanAt).to.equal(null);
    expect(status.lastScanError).to.equal(null);
  });
});
