'use strict';

const { expect } = require('chai');
const canaryEvents = require('../src/observability/canary-events');

function makeFakeDeps() {
  return {
    p2pNode: {
      peerId: { toString: () => '12D3KooWFake' },
      getPeers: () => [1, 2, 3],
    },
    workerHandle: {
      name: 'venom-campaigns',
      isRunning: () => true,
    },
    producerHandle: { stop: () => {} },
    queueModule: {
      getConnection: () => ({
        status: 'ready',
        ping: async () => 'PONG',
      }),
    },
    version: '1.0.1',
  };
}

describe('observability/canary-events', function () {
  it('returns null when intervalMs is 0 or negative', function () {
    expect(canaryEvents.start({ getDeps: () => ({}), intervalMs: 0 })).to.equal(null);
    expect(canaryEvents.start({ getDeps: () => ({}), intervalMs: -100 })).to.equal(null);
  });

  it('throws when getDeps is not a function', function () {
    expect(() => canaryEvents.start({ intervalMs: 1000 }))
      .to.throw(/getDeps to be a function/);
  });

  it('emits one JSON line per manual tick', async function () {
    const lines = [];
    const handle = canaryEvents.start({
      getDeps: () => makeFakeDeps(),
      intervalMs: 60000,
      logger: (line) => lines.push(line),
    });

    try {
      await handle._tickForTesting();
      await handle._tickForTesting();

      expect(lines).to.have.length(2);
      for (const line of lines) {
        const parsed = JSON.parse(line);
        expect(parsed.kind).to.equal('canary.metrics');
        expect(parsed.ok).to.equal(true);
        expect(parsed.checks).to.have.all.keys('libp2p', 'worker', 'producer', 'redis');
      }
    } finally {
      handle.stop();
    }
  });

  it('stop prevents further manual ticks from emitting', async function () {
    const lines = [];
    const handle = canaryEvents.start({
      getDeps: () => makeFakeDeps(),
      intervalMs: 60000,
      logger: (line) => lines.push(line),
    });

    handle.stop();
    await handle._tickForTesting();

    expect(lines).to.have.length(0);
  });

  it('warns instead of throwing when snapshot generation fails', async function () {
    const lines = [];
    const warnings = [];
    const handle = canaryEvents.start({
      getDeps: () => { throw new Error('deps blew up'); },
      intervalMs: 60000,
      logger: (line) => lines.push(line),
      warn: (line) => warnings.push(line),
    });

    try {
      await handle._tickForTesting();

      expect(lines).to.have.length(0);
      expect(warnings.join(' ')).to.match(/Failed to emit metrics.*deps blew up/);
    } finally {
      handle.stop();
    }
  });

  it('startFromEnv returns null when env var is unset or zero', function () {
    expect(canaryEvents.startFromEnv({ getDeps: () => ({}), env: {} })).to.equal(null);
    expect(canaryEvents.startFromEnv({
      getDeps: () => ({}),
      env: { CANARY_METRICS_INTERVAL_MS: '0' },
    })).to.equal(null);
  });

  it('startFromEnv warns and returns null when env var is invalid', function () {
    const warnings = [];

    const handle = canaryEvents.startFromEnv({
      getDeps: () => ({}),
      env: { CANARY_METRICS_INTERVAL_MS: '500' },
      warn: (line) => warnings.push(line),
    });

    expect(handle).to.equal(null);
    expect(warnings.join(' ')).to.match(/must be an integer >= 1000/);
  });

  it('startFromEnv returns a handle when env var is valid', function () {
    const handle = canaryEvents.startFromEnv({
      getDeps: () => makeFakeDeps(),
      env: { CANARY_METRICS_INTERVAL_MS: '5000' },
      logger: () => {},
    });

    expect(handle).to.not.equal(null);
    expect(typeof handle.stop).to.equal('function');
    handle.stop();
  });
});
