'use strict';

const { expect } = require('chai');
const { Wallet } = require('ethers');

const {
  PHASE_INDEX,
  HARDHAT_CHAIN_ID,
  DEFAULT_QUORUM,
  assertFixtureChain,
  assertOracleFactoryShape,
  assertWorkerDecisionShape,
  buildAggregationMessage,
  normalizeOracleSignature,
  runP2pAggregation,
} = require('../phases/p2p-aggregation');

const { STATE, PHASE_BY_INDEX, validatePhaseResult } = require('../phases');

describe('CIST Phase 7: P2P / signature aggregation', function () {
  function makeContext(overrides = {}) {
    return {
      runId: 'cist-20260427-143012-a83f9c1e',
      runDir: '/tmp/test-run',
      mode: 'fixture',
      scenario: 'all-agree',
      ...overrides,
    };
  }

  function makeWorkerDecision(overrides = {}) {
    return {
      decision: 'approve',
      score: 0.92,
      reason: 'fixture decision',
      ...overrides,
    };
  }

  function makeOracleFactory(wallets, overrides = {}) {
    return {
      createOracles: async ({ message }) => wallets.map((wallet, index) => ({
        id: `oracle-${index + 1}`,
        address: wallet.address,
        sign: async () => ({
          oracleId: `oracle-${index + 1}`,
          address: wallet.address,
          signature: await wallet.signMessage(message),
        }),
        stop: async () => undefined,
      })),
      ...overrides,
    };
  }

  function makeWallets(count) {
    return Array.from({ length: count }, () => Wallet.createRandom());
  }

  it('declares PHASE_INDEX as 7 and aligns with the phases registry', function () {
    expect(PHASE_INDEX).to.equal(7);
    expect(PHASE_BY_INDEX[PHASE_INDEX].key).to.equal('p2p');
    expect(DEFAULT_QUORUM).to.equal(3);
  });

  it('assertFixtureChain accepts only the Hardhat fixture chain', function () {
    expect(assertFixtureChain(HARDHAT_CHAIN_ID)).to.equal(true);
    expect(() => assertFixtureChain(84532))
      .to.throw('FIXTURE_KEY_MISUSE')
      .with.property('code', 'FIXTURE_KEY_MISUSE');
  });

  it('assertOracleFactoryShape validates createOracles()', function () {
    expect(assertOracleFactoryShape(makeOracleFactory([]))).to.equal(true);
    expect(() => assertOracleFactoryShape(null)).to.throw('Oracle factory must have a createOracles() method');
    expect(() => assertOracleFactoryShape({})).to.throw('Oracle factory must have a createOracles() method');
  });

  it('assertWorkerDecisionShape accepts normalized decisions', function () {
    expect(assertWorkerDecisionShape(makeWorkerDecision())).to.equal(true);
  });

  it('assertWorkerDecisionShape rejects invalid decisions', function () {
    expect(() => assertWorkerDecisionShape(null)).to.throw('Worker decision is required');
    expect(() => assertWorkerDecisionShape({ decision: 'maybe', score: 0.5, reason: 'x' }))
      .to.throw('Worker decision is invalid');
  });

  it('buildAggregationMessage is deterministic and includes core fields', function () {
    const message = buildAggregationMessage(makeContext(), {
      chainId: HARDHAT_CHAIN_ID,
      workerDecision: makeWorkerDecision(),
    });

    expect(message).to.equal(buildAggregationMessage(makeContext(), {
      chainId: HARDHAT_CHAIN_ID,
      workerDecision: makeWorkerDecision(),
    }));
    expect(message).to.include('cist-20260427-143012-a83f9c1e');
    expect(message).to.include(String(HARDHAT_CHAIN_ID));
    expect(message).to.include('approve');
    expect(message).to.include('0.92');
  });

  it('normalizeOracleSignature accepts valid signature-shaped output', async function () {
    const wallet = Wallet.createRandom();
    const message = buildAggregationMessage(makeContext(), {
      chainId: HARDHAT_CHAIN_ID,
      workerDecision: makeWorkerDecision(),
    });
    const signature = await wallet.signMessage(message);
    const normalized = normalizeOracleSignature({
      oracleId: 'oracle-1',
      address: wallet.address,
      signature,
    });

    expect(normalized.address).to.equal(wallet.address);
    expect(normalized.signature).to.equal(signature);
  });

  it('normalizeOracleSignature rejects invalid signature-shaped output', function () {
    expect(() => normalizeOracleSignature(null)).to.throw('Oracle signature is invalid');
    expect(() => normalizeOracleSignature({
      oracleId: 'oracle-1',
      address: 'bad',
      signature: '0x1234',
    })).to.throw('Oracle signature is invalid');
  });

  it('WARNs with P2P_NOT_CONFIGURED when no oracle factory is supplied', async function () {
    const result = await runP2pAggregation(makeContext(), {
      chainId: HARDHAT_CHAIN_ID,
      workerDecision: makeWorkerDecision(),
    });

    expect(result.state).to.equal(STATE.WARN);
    expect(result.codes).to.deep.equal(['P2P_NOT_CONFIGURED']);
    expect(result.p2p).to.deep.equal({ configured: false });
    expect(validatePhaseResult(result)).to.equal(true);
  });

  it('FAILs with P2P_ORACLE_FACTORY_INVALID when the oracle factory is malformed', async function () {
    const result = await runP2pAggregation(makeContext(), {
      chainId: HARDHAT_CHAIN_ID,
      workerDecision: makeWorkerDecision(),
      oracleFactory: {},
    });

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('P2P_ORACLE_FACTORY_INVALID');
  });

  it('FAILs when chainId is missing', async function () {
    const result = await runP2pAggregation(makeContext(), {
      oracleFactory: makeOracleFactory([]),
      workerDecision: makeWorkerDecision(),
    });

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('P2P_CHAIN_ID_MISSING');
  });

  it('FAILs when worker decision is missing', async function () {
    const result = await runP2pAggregation(makeContext(), {
      chainId: HARDHAT_CHAIN_ID,
      oracleFactory: makeOracleFactory([]),
    });

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('P2P_WORKER_DECISION_MISSING');
  });

  it('FAILs with P2P_WORKER_DECISION_INVALID when worker decision is malformed', async function () {
    const result = await runP2pAggregation(makeContext(), {
      chainId: HARDHAT_CHAIN_ID,
      workerDecision: {
        decision: 'maybe',
        score: 0.5,
        reason: 'invalid',
      },
      oracleFactory: makeOracleFactory([]),
    });

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('P2P_WORKER_DECISION_INVALID');
  });

  it('FAILs with FIXTURE_KEY_MISUSE when fixture factory is used on non-fixture chain', async function () {
    const wallets = makeWallets(3);
    const result = await runP2pAggregation(makeContext(), {
      chainId: 84532,
      workerDecision: makeWorkerDecision(),
      oracleFactory: makeOracleFactory(wallets),
      usesFixtureKeys: true,
    });

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('FIXTURE_KEY_MISUSE');
  });

  it('FAILs when oracle factory throws', async function () {
    const factory = {
      createOracles: async () => {
        throw new Error('factory exploded');
      },
    };
    const result = await runP2pAggregation(makeContext(), {
      chainId: HARDHAT_CHAIN_ID,
      workerDecision: makeWorkerDecision(),
      oracleFactory: factory,
    });

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('P2P_ORACLE_THREW');
    expect(result.notes.join(' ')).to.match(/factory exploded/i);
  });

  it('FAILs when a signature is malformed', async function () {
    const wallets = makeWallets(3);
    const factory = {
      createOracles: async ({ message }) => wallets.map((wallet, index) => ({
        id: `oracle-${index + 1}`,
        address: wallet.address,
        sign: async () => ({
          oracleId: `oracle-${index + 1}`,
          address: wallet.address,
          signature: index === 1 ? '0x1234' : await wallet.signMessage(message),
        }),
        stop: async () => undefined,
      })),
    };

    const result = await runP2pAggregation(makeContext(), {
      chainId: HARDHAT_CHAIN_ID,
      workerDecision: makeWorkerDecision(),
      oracleFactory: factory,
    });

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('P2P_ORACLE_SIGNATURE_INVALID');
  });

  it('FAILs when quorum is not reached', async function () {
    const wallets = makeWallets(2);
    const result = await runP2pAggregation(makeContext(), {
      chainId: HARDHAT_CHAIN_ID,
      workerDecision: makeWorkerDecision(),
      oracleFactory: makeOracleFactory(wallets),
      quorum: 3,
    });

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('P2P_QUORUM_NOT_REACHED');
    expect(result.p2p.validSignatures).to.equal(2);
    expect(result.p2p.quorum).to.equal(3);
  });

  it('counts duplicate oracle addresses only once', async function () {
    const wallet = Wallet.createRandom();
    const wallets = [wallet, wallet, Wallet.createRandom()];

    const result = await runP2pAggregation(makeContext(), {
      chainId: HARDHAT_CHAIN_ID,
      workerDecision: makeWorkerDecision(),
      oracleFactory: makeOracleFactory(wallets),
      quorum: 3,
    });

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('P2P_QUORUM_NOT_REACHED');
    expect(result.p2p.validSignatures).to.equal(2);
  });

  it('PASSes when quorum signatures are collected', async function () {
    const wallets = makeWallets(3);
    const result = await runP2pAggregation(makeContext(), {
      chainId: HARDHAT_CHAIN_ID,
      workerDecision: makeWorkerDecision(),
      oracleFactory: makeOracleFactory(wallets),
      quorum: 3,
    });

    expect(result.state).to.equal(STATE.PASS);
    expect(result.codes).to.deep.equal([]);
    expect(result.p2p).to.deep.include({
      configured: true,
      quorum: 3,
      validSignatures: 3,
    });
    expect(result.signatures).to.have.length(3);
    expect(validatePhaseResult(result)).to.equal(true);
  });

  it('stores only serializable primitives and no oracle instances', async function () {
    const wallets = makeWallets(3);
    const result = await runP2pAggregation(makeContext(), {
      chainId: HARDHAT_CHAIN_ID,
      workerDecision: makeWorkerDecision(),
      oracleFactory: makeOracleFactory(wallets),
    });

    expect(() => JSON.stringify(result)).to.not.throw();
    const serialized = JSON.stringify(result);
    expect(serialized).to.not.include('function');
    expect(result).to.not.have.property('oracleFactory');
    expect(result).to.not.have.property('oracles');
  });
});
