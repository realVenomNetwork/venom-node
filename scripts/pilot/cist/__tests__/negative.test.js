'use strict';

const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCistPhases } = require('../../smoke-test');
const { STATE } = require('../phases');
const { SELECTORS } = require('../phases/chain-binding');

const ESCROW_ADDRESS = '0x1234567890123456789012345678901234567890';
const REGISTRY_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

const ESCROW_BYTECODE_WITH_SELECTORS =
  `0x608060405234801561001057600080fd5b5063${SELECTORS.OPERATOR_PAYOUT.slice(2)}600052`;
const REGISTRY_BYTECODE_WITH_SELECTORS =
  `0x608060405234801561001057600080fd5b5063${SELECTORS.UNSTAKE.slice(2)}600052`;

const tmpRoots = [];

function makeContext(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cist-negative-'));
  tmpRoots.push(root);
  const runDir = path.join(root, 'run');
  fs.mkdirSync(runDir, { recursive: true });

  return {
    runId: 'cist-negative-test',
    runDir,
    baseDir: root,
    mode: 'fixture',
    scenario: 'all-agree',
    safety: { line: 'test' },
    ...overrides,
  };
}

function cleanupRoots() {
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function makeMockProvider(options = {}) {
  const {
    chainId = 31337,
    name = 'hardhat',
    escrowCode = ESCROW_BYTECODE_WITH_SELECTORS,
    registryCode = REGISTRY_BYTECODE_WITH_SELECTORS,
  } = options;

  return {
    getNetwork: async () => ({ chainId, name }),
    getCode: async (address) => {
      if (address === ESCROW_ADDRESS) return escrowCode;
      if (address === REGISTRY_ADDRESS) return registryCode;
      return '0x';
    },
  };
}

describe('CIST Negative Tests (Diagnostic Value)', function () {
  afterEach(function () {
    cleanupRoots();
  });

  it('Phase 1 fails with CONFIG_ENV_MISSING on live-testnet without required env', async function () {
    const context = makeContext({ mode: 'live-testnet' });
    const { phases } = await runCistPhases(context, { env: {} });

    expect(phases[0].state).to.equal(STATE.FAIL);
    expect(phases[0].codes).to.include('CONFIG_ENV_MISSING');
    expect(phases[7].state).to.equal(STATE.PASS);
  });

  it('Phase 1 fails with CONFIG_RUNDIR_NOT_WRITABLE when runDir is not writable', async function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cist-negative-'));
    tmpRoots.push(root);
    const blocker = path.join(root, 'blocker');
    fs.writeFileSync(blocker, 'not a directory\n');

    const context = makeContext({ runDir: path.join(blocker, 'inner') });
    const { phases } = await runCistPhases(context, { env: {} });

    expect(phases[0].state).to.equal(STATE.FAIL);
    expect(phases[0].codes).to.include('CONFIG_RUNDIR_NOT_WRITABLE');
    expect(phases[0].codes).to.not.include('CONFIG_ENV_MISSING');
  });

  it('Phase 2 fails with CHAIN_ID_MISMATCH on wrong chain for fixture mode', async function () {
    const context = makeContext();
    const { phases } = await runCistPhases(context, {
      env: {},
      provider: makeMockProvider({ chainId: 84532 }),
      escrowAddress: ESCROW_ADDRESS,
      registryAddress: REGISTRY_ADDRESS,
    });

    expect(phases[1].state).to.equal(STATE.FAIL);
    expect(phases[1].codes).to.include('CHAIN_ID_MISMATCH');
    expect(phases[7].state).to.equal(STATE.PASS);
  });

  it('Phase 3 fails with REDIS_UNREACHABLE when Redis client throws', async function () {
    const failingRedis = {
      ping: async () => { throw new Error('connection refused'); },
      keys: async () => [],
    };

    const context = makeContext();
    const { phases } = await runCistPhases(context, {
      env: {},
      provider: makeMockProvider(),
      escrowAddress: ESCROW_ADDRESS,
      registryAddress: REGISTRY_ADDRESS,
      redisClient: failingRedis,
    });

    expect(phases[2].state).to.equal(STATE.FAIL);
    expect(phases[2].codes).to.include('REDIS_UNREACHABLE');
    expect(phases[7].state).to.equal(STATE.PASS);
  });

  it('Phase 6 fails with WORKER_THREW when worker throws during processing', async function () {
    const context = makeContext();
    const { phases } = await runCistPhases(context, {
      env: {},
      provider: makeMockProvider(),
      escrowAddress: ESCROW_ADDRESS,
      registryAddress: REGISTRY_ADDRESS,
      payloadSource: async () => ({ campaignUid: 'test-campaign' }),
      worker: {
        process: async () => { throw new Error('worker exploded during decision'); },
      },
    });

    expect(phases[5].state).to.equal(STATE.FAIL);
    expect(phases[5].codes).to.include('WORKER_THREW');
    expect(phases[6].state).to.equal(STATE.SKIP);
    expect(phases[7].state).to.equal(STATE.PASS);
  });

  it('Phase 7 fails with P2P_ORACLE_FACTORY_INVALID when factory is malformed', async function () {
    const context = makeContext();
    const { phases } = await runCistPhases(context, {
      env: {},
      provider: makeMockProvider(),
      escrowAddress: ESCROW_ADDRESS,
      registryAddress: REGISTRY_ADDRESS,
      payloadSource: async () => ({ campaignUid: 'test-campaign' }),
      worker: {
        process: async () => ({
          campaignUid: 'test-campaign',
          decision: 'approve',
          score: 0.92,
          reason: 'all oracles agree',
        }),
      },
      oracleFactory: {},
    });

    expect(phases[6].state).to.equal(STATE.FAIL);
    expect(phases[6].codes).to.include('P2P_ORACLE_FACTORY_INVALID');
    expect(phases[7].state).to.equal(STATE.PASS);
  });
});
