'use strict';

const { expect } = require('chai');
const readiness = require('../src/observability/readiness');

function fakeP2P({ peerId = '12D3KooWFakePeerId', peers = 3 } = {}) {
  return {
    peerId: { toString: () => peerId },
    getPeers: () => new Array(peers),
  };
}

function fakeWorker({ name = 'venom-campaigns-op1', running = true } = {}) {
  return {
    name,
    isRunning: () => running,
  };
}

function fakeProducer() {
  return { stop: () => {} };
}

function fakeQueueModule({ pingResolves = true, pingDelayMs = 0, status = 'ready' } = {}) {
  return {
    getConnection: () => ({
      status,
      ping: () => new Promise((resolve, reject) => {
        setTimeout(() => {
          if (pingResolves) resolve('PONG');
          else reject(new Error('ECONNREFUSED'));
        }, pingDelayMs);
      }),
    }),
  };
}

describe('observability/readiness', function () {
  it('returns ok=true when all synchronous subsystems are present', function () {
    const result = readiness.compute({
      p2pNode: fakeP2P(),
      workerHandle: fakeWorker(),
      producerHandle: fakeProducer(),
      version: '1.0.1',
    });

    expect(result.ok).to.equal(true);
    expect(result.version).to.equal('1.0.1');
    expect(result.checks.libp2p.peerId).to.equal('12D3KooWFakePeerId');
    expect(result.checks.libp2p.peers).to.equal(3);
    expect(result.checks.worker.name).to.equal('venom-campaigns-op1');
  });

  it('returns ok=false when p2p node is missing', function () {
    const result = readiness.compute({
      p2pNode: null,
      workerHandle: fakeWorker(),
      producerHandle: fakeProducer(),
    });

    expect(result.ok).to.equal(false);
    expect(result.checks.libp2p.ok).to.equal(false);
    expect(result.checks.libp2p.reason).to.match(/not started/);
  });

  it('returns ok=false when p2p status reports quorum constants are not loaded', function () {
    const result = readiness.compute({
      p2pNode: fakeP2P(),
      p2pStatus: {
        started: true,
        peerId: '12D3KooWFakePeerId',
        peerCount: 3,
        quorumConstantsLoaded: false,
        activeOracleCount: 4,
        pendingCampaignCount: 0,
      },
      workerHandle: fakeWorker(),
      producerHandle: fakeProducer(),
    });

    expect(result.ok).to.equal(false);
    expect(result.checks.libp2p.ok).to.equal(false);
    expect(result.checks.libp2p.reason).to.match(/quorum constants/);
    expect(result.checks.libp2p.activeOracleCount).to.equal(4);
  });

  it('returns ok=false when worker is not running', function () {
    const result = readiness.compute({
      p2pNode: fakeP2P(),
      workerHandle: fakeWorker({ running: false }),
      producerHandle: fakeProducer(),
    });

    expect(result.ok).to.equal(false);
    expect(result.checks.worker.ok).to.equal(false);
  });

  it('does not throw when libp2p getters throw', function () {
    const broken = {
      peerId: { toString: () => { throw new Error('boom'); } },
      getPeers: () => { throw new Error('also boom'); },
    };

    const result = readiness.compute({
      p2pNode: broken,
      workerHandle: fakeWorker(),
      producerHandle: fakeProducer(),
    });

    expect(result.ok).to.equal(false);
    expect(result.checks.libp2p.peers).to.equal(0);
  });

  it('uses provided now() function for deterministic timestamps', function () {
    const fixedTs = 1700000000000;
    const result = readiness.compute({
      p2pNode: fakeP2P(),
      workerHandle: fakeWorker(),
      producerHandle: fakeProducer(),
      now: () => fixedTs,
    });

    expect(result.timestamp).to.equal(new Date(fixedTs).toISOString());
  });

  it('probeRedis returns ok=true on successful ping', async function () {
    const result = await readiness.probeRedis(fakeQueueModule());

    expect(result.ok).to.equal(true);
    expect(result.status).to.equal('ready');
  });

  it('probeRedis returns ok=false when ping rejects', async function () {
    const result = await readiness.probeRedis(fakeQueueModule({ pingResolves: false }));

    expect(result.ok).to.equal(false);
    expect(result.reason).to.match(/ECONNREFUSED/);
  });

  it('probeRedis returns ok=false when ping exceeds timeout', async function () {
    const result = await readiness.probeRedis(fakeQueueModule({ pingDelayMs: 200 }), 50);

    expect(result.ok).to.equal(false);
    expect(result.reason).to.match(/timeout/i);
  });

  it('probeRedis returns ok=false when queueModule is missing', async function () {
    const result = await readiness.probeRedis(undefined);

    expect(result.ok).to.equal(false);
    expect(result.reason).to.match(/not provided/);
  });

  it('probeRedis returns ok=false when getConnection throws', async function () {
    const result = await readiness.probeRedis({
      getConnection: () => { throw new Error('redis unavailable'); },
    });

    expect(result.ok).to.equal(false);
    expect(result.reason).to.match(/getConnection threw/);
  });

  it('computeAsync combines sync checks with redis probe', async function () {
    const result = await readiness.computeAsync({
      p2pNode: fakeP2P(),
      workerHandle: fakeWorker(),
      producerHandle: fakeProducer(),
      queueModule: fakeQueueModule(),
      version: '1.0.1',
    });

    expect(result.ok).to.equal(true);
    expect(result.checks).to.have.all.keys('libp2p', 'worker', 'producer', 'redis');
  });

  it('computeAsync returns ok=false when redis fails', async function () {
    const result = await readiness.computeAsync({
      p2pNode: fakeP2P(),
      workerHandle: fakeWorker(),
      producerHandle: fakeProducer(),
      queueModule: fakeQueueModule({ pingResolves: false }),
    });

    expect(result.ok).to.equal(false);
    expect(result.checks.redis.ok).to.equal(false);
    expect(result.checks.libp2p.ok).to.equal(true);
  });

  it('includes producer status details when provided', function () {
    const result = readiness.compute({
      p2pNode: fakeP2P(),
      workerHandle: fakeWorker(),
      producerHandle: fakeProducer(),
      producerStatus: {
        running: false,
        lastScannedBlock: 123,
        lastScanAt: '2026-05-10T12:00:00.000Z',
        lastScanError: 'RPC failed',
      },
    });

    expect(result.ok).to.equal(false);
    expect(result.checks.producer.ok).to.equal(false);
    expect(result.checks.producer.lastScannedBlock).to.equal(123);
    expect(result.checks.producer.lastScanError).to.equal('RPC failed');
  });

  it('reports producer ok=false when lastScanError is set even though running=true', function () {
    // Signature test for the silent-scan-failure bug. Pre-patch this
    // would have failed: ok was driven only by `running`, so a producer
    // whose interval keeps firing while every scan throws (RPC down)
    // reported ok=true indefinitely.
    const result = readiness.compute({
      p2pNode: fakeP2P(),
      workerHandle: fakeWorker(),
      producerHandle: fakeProducer(),
      producerStatus: {
        running: true,
        lastScannedBlock: 12345,
        lastScanAt: '2026-05-11T10:00:00.000Z',
        lastScanError: 'ECONNREFUSED at https://base-sepolia-rpc.publicnode.com',
      },
    });

    expect(result.ok).to.equal(false);
    expect(result.checks.producer.ok).to.equal(false);
    expect(result.checks.producer.lastScanError).to.match(/ECONNREFUSED/);
    expect(result.checks.producer.reason).to.match(/scan failing/);
  });

  it('reports producer ok=true when running=true and no lastScanError', function () {
    // Sanity: the new condition does not over-flip a healthy producer.
    const result = readiness.compute({
      p2pNode: fakeP2P(),
      workerHandle: fakeWorker(),
      producerHandle: fakeProducer(),
      producerStatus: {
        running: true,
        lastScannedBlock: 12345,
        lastScanAt: '2026-05-11T10:00:00.000Z',
        lastScanError: null,
      },
    });

    expect(result.ok).to.equal(true);
    expect(result.checks.producer.ok).to.equal(true);
    expect(result.checks.producer).to.not.have.property('reason');
  });
});
