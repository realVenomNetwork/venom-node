'use strict';

const { expect } = require('chai');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const workerPath = path.join(repoRoot, 'aggregator', 'worker.js');
const queuePath = path.join(repoRoot, 'aggregator', 'queue.js');
const p2pPath = path.join(repoRoot, 'aggregator', 'p2p.js');

const ENV_KEYS = [
  'OPERATOR_PRIVATE_KEY',
  'PILOT_ESCROW_ADDRESS',
  'RPC_URL',
  'RPC_URLS',
  'NODE_ENV',
  'VENOM_RUNTIME_MODE',
  'USE_TEST_PAYLOAD',
];

function createMockConnection() {
  const data = new Map();
  const setCalls = [];
  return {
    data,
    setCalls,
    async get(key) {
      return data.has(key) ? data.get(key) : null;
    },
    async set(key, value, ...args) {
      setCalls.push([key, value, ...args]);
      data.set(key, value);
      return 'OK';
    },
    async del(key) {
      return data.delete(key) ? 1 : 0;
    },
    async scan(_cursor, _matchToken, pattern) {
      const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
      return ['0', Array.from(data.keys()).filter((key) => key.startsWith(prefix))];
    },
  };
}

function clearRuntimeModules() {
  for (const modulePath of [workerPath, queuePath, p2pPath]) {
    delete require.cache[require.resolve(modulePath)];
  }
}

function loadWorker({ connection = createMockConnection(), published = [], publishFails = false } = {}) {
  clearRuntimeModules();

  require.cache[require.resolve(queuePath)] = {
    id: queuePath,
    filename: queuePath,
    loaded: true,
    exports: {
      getConnection: () => connection,
      QUEUE_NAME: 'venom-campaigns-test',
      OPERATOR_QUEUE_SUFFIX: '',
    },
  };

  require.cache[require.resolve(p2pPath)] = {
    id: p2pPath,
    filename: p2pPath,
    loaded: true,
    exports: {
      publishSignature: async (campaignUid, score, signature) => {
        if (publishFails) throw new Error('p2p unavailable');
        published.push({ type: 'score', campaignUid, score, signature });
      },
      publishAbstain: async (campaignUid, reasonCode, signature, reasonLabel) => {
        if (publishFails) throw new Error('p2p unavailable');
        published.push({ type: 'abstain', campaignUid, reasonCode, signature, reasonLabel });
      },
    },
  };

  return {
    worker: require(workerPath),
    connection,
    published,
  };
}

describe('worker pending delivery outbox', function () {
  const previousEnv = {};

  beforeEach(function () {
    for (const key of ENV_KEYS) {
      previousEnv[key] = process.env[key];
    }
    process.env.NODE_ENV = 'test';
    process.env.VENOM_RUNTIME_MODE = 'demo';
    process.env.USE_TEST_PAYLOAD = 'true';
    process.env.OPERATOR_PRIVATE_KEY = '0x1111111111111111111111111111111111111111111111111111111111111111';
    process.env.PILOT_ESCROW_ADDRESS = '0x2000000000000000000000000000000000000002';
    process.env.RPC_URL = 'http://127.0.0.1:8545';
    delete process.env.RPC_URLS;
  });

  afterEach(function () {
    clearRuntimeModules();
    for (const key of ENV_KEYS) {
      if (previousEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousEnv[key];
      }
    }
  });

  it('stores and deletes pending delivery data with a TTL', async function () {
    const { worker, connection } = loadWorker();
    const campaignUid = '0xscore';

    await worker.setPendingDelivery(campaignUid, { type: 'score', score: 77, signature: '0xsig' });

    const key = worker.getPendingDeliveryKey(campaignUid);
    expect(key).to.include('venom:worker:pending:');
    expect(connection.setCalls[0][2]).to.equal('EX');
    expect(connection.setCalls[0][3]).to.equal(3600);

    const pending = await worker.getPendingDelivery(campaignUid);
    expect(pending).to.include({ type: 'score', score: 77, signature: '0xsig', campaignUid });
    expect(pending.timestamp).to.be.a('number');

    await worker.deletePendingDelivery(campaignUid);
    expect(await worker.getPendingDelivery(campaignUid)).to.equal(null);
  });

  it('re-publishes and clears a pending score delivery', async function () {
    const { worker, published, connection } = loadWorker();
    const campaignUid = '0xpending-score';

    await worker.setPendingDelivery(campaignUid, { type: 'score', score: 88, signature: '0xsig' });
    await worker.retryPendingDeliveries();

    expect(published).to.deep.equal([{ type: 'score', campaignUid, score: 88, signature: '0xsig' }]);
    expect(await worker.getPendingDelivery(campaignUid)).to.equal(null);
    expect(await connection.get(worker.getProcessedCampaignKey(campaignUid))).to.equal('1');
  });

  it('re-publishes and clears a pending abstain delivery', async function () {
    const { worker, published, connection } = loadWorker();
    const campaignUid = '0xpending-abstain';

    await worker.setPendingDelivery(campaignUid, {
      type: 'abstain',
      reasonCode: 3,
      reasonLabel: 'FetchFailed',
      signature: '0xabstain',
    });
    await worker.retryPendingDeliveries();

    expect(published).to.deep.equal([{
      type: 'abstain',
      campaignUid,
      reasonCode: 3,
      signature: '0xabstain',
      reasonLabel: 'FetchFailed',
    }]);
    expect(await worker.getPendingDelivery(campaignUid)).to.equal(null);
    expect(await connection.get(worker.getProcessedCampaignKey(campaignUid))).to.equal('1');
  });

  it('keeps pending delivery data when retry publish fails', async function () {
    const { worker } = loadWorker({ publishFails: true });
    const campaignUid = '0xpublish-fails';

    await worker.setPendingDelivery(campaignUid, { type: 'score', score: 50, signature: '0xfail' });
    await worker.retryPendingDeliveries();

    expect(await worker.getPendingDelivery(campaignUid)).to.include({
      type: 'score',
      score: 50,
      signature: '0xfail',
    });
  });
});
