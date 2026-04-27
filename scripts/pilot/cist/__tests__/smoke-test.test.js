'use strict';

const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  makeSkeletonPhaseResult,
  makeSkippedPhaseResult,
  runCistPhases,
} = require('../../smoke-test');

const { STATE, PHASES, validatePhaseResult } = require('../phases');
const { SELECTORS } = require('../phases/chain-binding');
const { writeReports } = require('../report');

const ESCROW_ADDRESS = '0x1234567890123456789012345678901234567890';
  const REGISTRY_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const ESCROW_BYTECODE_WITH_OPERATOR_PAYOUT =
    `0x608060405234801561001057600080fd5b5063${SELECTORS.OPERATOR_PAYOUT.slice(2)}600052`;
  const REGISTRY_BYTECODE_WITH_UNSTAKE =
    `0x608060405234801561001057600080fd5b5063${SELECTORS.UNSTAKE.slice(2)}600052`;

describe('CIST smoke-test orchestrator skeleton', function () {
  let root;
  let runDir;

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cist-smoke-test-'));
    runDir = path.join(root, 'run');
    fs.mkdirSync(runDir, { recursive: true });
  });

  afterEach(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function makeContext(overrides = {}) {
    return {
      runId: 'cist-20260427-143012-a83f9c1e',
      runDir,
      baseDir: root,
      mode: 'fixture',
      scenario: 'all-agree',
      safety: {
        line: 'fixture mode uses local/synthetic inputs; no live funds or live state are touched.',
      },
      ...overrides,
    };
  }

  function makeMockProvider(options = {}) {
    const {
      chainId = 31337,
      name = chainId === 31337 ? 'hardhat' : 'unknown',
      escrowCode = ESCROW_BYTECODE_WITH_OPERATOR_PAYOUT,
      registryCode = REGISTRY_BYTECODE_WITH_UNSTAKE,
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

  it('runCistPhases returns exactly 8 valid phase results', async function () {
    const { phases, releaseReadiness } = await runCistPhases(makeContext(), {
      env: {},
      provider: makeMockProvider(),
      escrowAddress: ESCROW_ADDRESS,
      registryAddress: REGISTRY_ADDRESS,
    });

    expect(phases).to.have.length(8);

    for (const result of phases) {
      expect(validatePhaseResult(result)).to.equal(true);
    }

    expect(phases.map((result) => result.index)).to.deep.equal([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(releaseReadiness).to.deep.equal({ unresolved: [] });
  });

  it('phase 1 is the real config preflight result', async function () {
    const { phases } = await runCistPhases(makeContext(), {
      env: {},
      provider: makeMockProvider(),
      escrowAddress: ESCROW_ADDRESS,
      registryAddress: REGISTRY_ADDRESS,
    });
    const phase1 = phases[0];

    expect(phase1.index).to.equal(1);
    expect(phase1.key).to.equal('config');
    expect(phase1.name).to.equal('Config and redaction preflight');
    expect(phase1.state).to.equal(STATE.PASS);
    expect(phase1.codes).to.deep.equal([]);

    expect(phase1).to.have.property('envSummary');
    expect(phase1.envSummary).to.have.property('useTestPayload');
    expect(phase1.envSummary).to.have.property('operatorPrivateKeySet');

    expect(phase1.notes).to.include('Environment summary built without storing raw secret values.');
    expect(phase1.notes).to.include('Redaction scanner self-test passed.');
    expect(phase1.notes).to.include('Run directory is writable.');
  });

  it('phases 3, 4, 5, and 6 warn when Redis, ML, payload, and worker are not configured and phase 7 is a skeleton placeholder while phase 8 still runs', async function () {
    const { phases } = await runCistPhases(makeContext(), {
      env: {},
      provider: makeMockProvider(),
      escrowAddress: ESCROW_ADDRESS,
      registryAddress: REGISTRY_ADDRESS,
    });

    expect(phases).to.have.length(8);

    expect(phases[2].state).to.equal(STATE.WARN);
    expect(phases[2].codes).to.deep.equal(['REDIS_NOT_CONFIGURED']);
    expect(phases[2].notes).to.deep.equal([
      'Redis client was not configured; Redis and queue probes were not run.',
      'Run with a Redis-backed CIST invocation for full queue checks.',
    ]);
    expect(phases[3].state).to.equal(STATE.WARN);
    expect(phases[3].codes).to.deep.equal(['ML_NOT_CONFIGURED']);
    expect(phases[3].notes).to.deep.equal([
      'ML service client was not configured; ML health probe was not run.',
      'Run with an ML-backed CIST invocation for full ML service checks.',
    ]);
    expect(phases[4].state).to.equal(STATE.WARN);
    expect(phases[4].codes).to.deep.equal(['PAYLOAD_NOT_CONFIGURED']);
    expect(phases[4].notes).to.deep.equal([
      'No payload source was supplied; payload resolution was not performed.',
      'Provide a fixture path, IPFS URI, or async loader function for full payload checks.',
    ]);
    expect(phases[5].state).to.equal(STATE.WARN);
    expect(phases[5].codes).to.deep.equal(['WORKER_NOT_CONFIGURED']);
    expect(phases[5].notes).to.deep.equal([
      'No worker was configured; worker decision probe was not run.',
      'Provide a worker with a process() method for full decision checks.',
    ]);

    const placeholders = phases.slice(6, 7);
    expect(placeholders).to.have.length(1);

    for (const result of placeholders) {
      expect(result.state).to.equal(STATE.SKIP);
      expect(result.codes).to.deep.equal([]);
      expect(result.notes).to.deep.equal([
        'CLI skeleton placeholder; component behavior is implemented in later CIST phases.',
      ]);
      expect(result.durationMs).to.equal(0);
      expect(result).to.not.have.property('envSummary');
    }

    expect(placeholders.map((result) => result.index)).to.deep.equal([7]);
    expect(phases[7].state).to.equal(STATE.PASS);
    expect(phases[7].notes).to.deep.equal([
      'Teardown verified report writability. Open-handle and force-close detection deferred to v1.2.',
    ]);
  });

  it('runCistPhases marks phases 5 through 7 as SKIP and still runs Phase 8 when Phase 4 FAILs', async function () {
    const failingMlClient = {
      health: async () => { throw new Error('service unavailable'); },
    };

    const { phases } = await runCistPhases(makeContext(), {
      env: {},
      provider: makeMockProvider(),
      escrowAddress: ESCROW_ADDRESS,
      registryAddress: REGISTRY_ADDRESS,
      mlClient: failingMlClient,
    });

    expect(phases[3].state).to.equal(STATE.FAIL);
    expect(phases[3].codes).to.include('ML_HEALTH_FAILED');

    for (const result of phases.slice(4, 7)) {
      expect(result.state).to.equal(STATE.SKIP);
      expect(result.notes).to.deep.equal([
        'Skipped because ML service failed.',
      ]);
    }
    expect(phases[7].state).to.equal(STATE.PASS);
    expect(phases[7].notes).to.deep.equal([
      'Teardown verified report writability. Open-handle and force-close detection deferred to v1.2.',
    ]);
  });

  it('runCistPhases marks phases 6 through 7 as SKIP and still runs Phase 8 when Phase 5 FAILs', async function () {
    const invalidPayload = { title: 'Missing campaignUid' };

    const { phases } = await runCistPhases(makeContext(), {
      env: {},
      provider: makeMockProvider(),
      escrowAddress: ESCROW_ADDRESS,
      registryAddress: REGISTRY_ADDRESS,
      payloadSource: async () => invalidPayload,
    });

    expect(phases[4].state).to.equal(STATE.FAIL);
    expect(phases[4].codes).to.include('PAYLOAD_SCHEMA_INVALID');

    for (const result of phases.slice(5, 7)) {
      expect(result.state).to.equal(STATE.SKIP);
      expect(result.notes).to.deep.equal([
        'Skipped because Payload resolution failed.',
      ]);
    }
    expect(phases[7].state).to.equal(STATE.PASS);
  });

  it('runCistPhases warns at Phase 6 when a worker is supplied but no payload is available', async function () {
    const worker = {
      process: async () => ({
        campaignUid: 'campaign-abc123',
        decision: 'approve',
        score: 0.9,
        reason: 'fixture decision',
      }),
    };

    const { phases } = await runCistPhases(makeContext(), {
      env: {},
      provider: makeMockProvider(),
      escrowAddress: ESCROW_ADDRESS,
      registryAddress: REGISTRY_ADDRESS,
      worker,
    });

    expect(phases[4].state).to.equal(STATE.WARN);
    expect(phases[5].state).to.equal(STATE.WARN);
    expect(phases[5].codes).to.deep.equal(['WORKER_NO_PAYLOAD']);
    expect(phases[5].notes).to.deep.equal([
      'No job was available; worker decision probe was not run.',
      'Provide a payload via Phase 5 success before running worker decision.',
    ]);

    for (const result of phases.slice(6, 7)) {
      expect(result.state).to.equal(STATE.SKIP);
      expect(result.codes).to.deep.equal([]);
      expect(result.notes).to.deep.equal([
        'CLI skeleton placeholder; component behavior is implemented in later CIST phases.',
      ]);
    }
    expect(phases[7].state).to.equal(STATE.PASS);
    expect(phases[7].notes).to.deep.equal([
      'Teardown verified report writability. Open-handle and force-close detection deferred to v1.2.',
    ]);
  });

  it('runCistPhases marks phase 7 as SKIP and still runs Phase 8 when Phase 6 FAILs', async function () {
    const failingWorker = {
      process: async () => { throw new Error('worker exploded'); },
    };

    const { phases } = await runCistPhases(makeContext(), {
      env: {},
      provider: makeMockProvider(),
      escrowAddress: ESCROW_ADDRESS,
      registryAddress: REGISTRY_ADDRESS,
      payloadSource: async () => ({
        campaignUid: 'campaign-abc123',
        title: 'Test Campaign',
        budget: 1000,
      }),
      worker: failingWorker,
    });

    expect(phases[5].state).to.equal(STATE.FAIL);
    expect(phases[5].codes).to.include('WORKER_THREW');

    for (const result of phases.slice(6, 7)) {
      expect(result.state).to.equal(STATE.SKIP);
      expect(result.notes).to.deep.equal([
        'Skipped because Worker decision failed.',
      ]);
    }
    expect(phases[7].state).to.equal(STATE.PASS);
  });

  it('runCistPhases warns at Phase 7 when oracle factory is not configured and Phase 8 still runs', async function () {
    const { phases } = await runCistPhases(makeContext(), {
      env: {},
      provider: makeMockProvider(),
      escrowAddress: ESCROW_ADDRESS,
      registryAddress: REGISTRY_ADDRESS,
      payloadSource: async () => ({
        campaignUid: 'campaign-abc123',
        title: 'Test Campaign',
        budget: 1000,
      }),
      worker: {
        process: async () => ({
          campaignUid: 'campaign-abc123',
          decision: 'approve',
          score: 0.92,
          reason: 'fixture decision',
        }),
      },
    });

    expect(phases[6].state).to.equal(STATE.WARN);
    expect(phases[6].codes).to.deep.equal(['P2P_NOT_CONFIGURED']);
    expect(phases[6].notes).to.deep.equal([
      'No oracle factory was configured; P2P/signature aggregation probe was not run.',
      'Provide an oracleFactory with createOracles() for full P2P checks.',
    ]);

    expect(phases[7].state).to.equal(STATE.PASS);
    expect(phases[7].codes).to.deep.equal([]);
    expect(phases[7].notes).to.deep.equal([
      'Teardown verified report writability. Open-handle and force-close detection deferred to v1.2.',
    ]);
  });

  it('runCistPhases still runs Phase 8 when Phase 7 FAILs', async function () {
    const failingOracleFactory = {
      createOracles: async () => { throw new Error('oracle factory exploded'); },
    };

    const { phases } = await runCistPhases(makeContext(), {
      env: {},
      provider: makeMockProvider(),
      escrowAddress: ESCROW_ADDRESS,
      registryAddress: REGISTRY_ADDRESS,
      payloadSource: async () => ({
        campaignUid: 'campaign-abc123',
        title: 'Test Campaign',
        budget: 1000,
      }),
      worker: {
        process: async () => ({
          campaignUid: 'campaign-abc123',
          decision: 'approve',
          score: 0.92,
          reason: 'fixture decision',
        }),
      },
      oracleFactory: failingOracleFactory,
    });

    expect(phases[6].state).to.equal(STATE.FAIL);
    expect(phases[6].codes).to.include('P2P_ORACLE_THREW');

    expect(phases[7].state).to.equal(STATE.PASS);
    expect(phases[7].notes).to.deep.equal([
      'Teardown verified report writability. Open-handle and force-close detection deferred to v1.2.',
    ]);
  });

  it('runCistPhases keeps phase 7 as a placeholder and still runs Phase 8 when Phase 2 only WARNs for missing provider', async function () {
    const { phases, releaseReadiness } = await runCistPhases(makeContext(), {
      env: {},
    });

    expect(phases).to.have.length(8);
    expect(phases[0].state).to.equal(STATE.PASS);
    expect(phases[1].state).to.equal(STATE.WARN);
    expect(phases[1].codes).to.deep.equal(['CHAIN_PROVIDER_NOT_CONFIGURED']);
    expect(phases[1].notes).to.deep.equal([
      'Chain provider was not configured; chain and contract binding probes were not run.',
      'Run with a Hardhat/provider-backed CIST invocation for full chain binding checks.',
    ]);
    expect(phases[2].state).to.equal(STATE.WARN);
    expect(phases[2].codes).to.deep.equal(['REDIS_NOT_CONFIGURED']);
    expect(phases[2].notes).to.deep.equal([
      'Redis client was not configured; Redis and queue probes were not run.',
      'Run with a Redis-backed CIST invocation for full queue checks.',
    ]);
    expect(phases[3].state).to.equal(STATE.WARN);
    expect(phases[3].codes).to.deep.equal(['ML_NOT_CONFIGURED']);
    expect(phases[3].notes).to.deep.equal([
      'ML service client was not configured; ML health probe was not run.',
      'Run with an ML-backed CIST invocation for full ML service checks.',
    ]);
    expect(phases[4].state).to.equal(STATE.WARN);
    expect(phases[4].codes).to.deep.equal(['PAYLOAD_NOT_CONFIGURED']);
    expect(phases[4].notes).to.deep.equal([
      'No payload source was supplied; payload resolution was not performed.',
      'Provide a fixture path, IPFS URI, or async loader function for full payload checks.',
    ]);
    expect(phases[5].state).to.equal(STATE.WARN);
    expect(phases[5].codes).to.deep.equal(['WORKER_NOT_CONFIGURED']);
    expect(phases[5].notes).to.deep.equal([
      'No worker was configured; worker decision probe was not run.',
      'Provide a worker with a process() method for full decision checks.',
    ]);
    expect(releaseReadiness).to.deep.equal({ unresolved: [] });

    for (const result of phases.slice(6, 7)) {
      expect(result.state).to.equal(STATE.SKIP);
      expect(result.codes).to.deep.equal([]);
      expect(result.durationMs).to.equal(0);
      expect(result.notes).to.deep.equal([
        'CLI skeleton placeholder; component behavior is implemented in later CIST phases.',
      ]);
      expect(validatePhaseResult(result)).to.equal(true);
    }

    expect(phases[7].state).to.equal(STATE.PASS);
    expect(phases[7].notes).to.deep.equal([
      'Teardown verified report writability. Open-handle and force-close detection deferred to v1.2.',
    ]);
    expect(phases.slice(6).map((result) => result.index)).to.deep.equal([7, 8]);
  });

  it('runCistPhases marks phases 4 through 7 as SKIP and still runs Phase 8 when Phase 3 FAILs', async function () {
    const failingClient = {
      ping: async () => { throw new Error('connection refused'); },
      keys: async () => [],
    };

    const { phases } = await runCistPhases(makeContext(), {
      env: {},
      provider: makeMockProvider(),
      escrowAddress: ESCROW_ADDRESS,
      registryAddress: REGISTRY_ADDRESS,
      redisClient: failingClient,
    });

    expect(phases[2].state).to.equal(STATE.FAIL);
    expect(phases[2].codes).to.include('REDIS_UNREACHABLE');

    for (const result of phases.slice(3, 7)) {
      expect(result.state).to.equal(STATE.SKIP);
      expect(result.notes).to.deep.equal([
        'Skipped because Redis and queue failed.',
      ]);
    }
    expect(phases[7].state).to.equal(STATE.PASS);
  });

  it('makeSkeletonPhaseResult creates a valid placeholder for a phase', function () {
    const result = makeSkeletonPhaseResult(PHASES[1]);

    expect(result.index).to.equal(2);
    expect(result.key).to.equal('chain');
    expect(result.name).to.equal('Chain and contract binding');
    expect(result.state).to.equal(STATE.SKIP);
    expect(result.durationMs).to.equal(0);
    expect(result.codes).to.deep.equal([]);
    expect(result.notes).to.deep.equal([
      'CLI skeleton placeholder; component behavior is implemented in later CIST phases.',
    ]);
    expect(validatePhaseResult(result)).to.equal(true);
  });

  it('makeSkippedPhaseResult creates a valid skipped phase result', function () {
    const result = makeSkippedPhaseResult(PHASES[1], PHASES[0]);

    expect(result.index).to.equal(2);
    expect(result.key).to.equal('chain');
    expect(result.name).to.equal('Chain and contract binding');
    expect(result.state).to.equal(STATE.SKIP);
    expect(result.durationMs).to.equal(0);
    expect(result.codes).to.deep.equal([]);
    expect(result.notes).to.deep.equal([
      'Skipped because Config and redaction preflight failed.',
    ]);
    expect(validatePhaseResult(result)).to.equal(true);
  });

  it('makeSkippedPhaseResult can name a phase-2 failure trigger', function () {
    const result = makeSkippedPhaseResult(PHASES[2], PHASES[1]);

    expect(result.index).to.equal(3);
    expect(result.state).to.equal(STATE.SKIP);
    expect(result.notes).to.deep.equal([
      'Skipped because Chain and contract binding failed.',
    ]);
    expect(validatePhaseResult(result)).to.equal(true);
  });

  it('runCistPhases marks phases 2 through 7 as SKIP and still runs Phase 8 when Phase 1 fails', async function () {
    const { phases, releaseReadiness } = await runCistPhases(makeContext({ mode: 'live-testnet' }), {
      env: {},
    });

    expect(phases).to.have.length(8);

    expect(phases[0].state).to.equal(STATE.FAIL);
    expect(phases[0].codes).to.include('CONFIG_ENV_MISSING');
    expect(releaseReadiness).to.deep.equal({ unresolved: [] });

    for (const result of phases.slice(1, 7)) {
      expect(result.state).to.equal(STATE.SKIP);
      expect(result.codes).to.deep.equal([]);
      expect(result.durationMs).to.equal(0);
      expect(result.notes).to.deep.equal([
        'Skipped because Config and redaction preflight failed.',
      ]);
      expect(validatePhaseResult(result)).to.equal(true);
    }

    expect(phases[7].state).to.equal(STATE.PASS);
    expect(phases[7].notes).to.deep.equal([
      'Teardown verified report writability. Open-handle and force-close detection deferred to v1.2.',
    ]);
    expect(phases.slice(1).map((result) => result.index)).to.deep.equal([2, 3, 4, 5, 6, 7, 8]);
  });

  it('hoists Phase 2 releaseReadiness into the written report.json', async function () {
    const context = makeContext();
    const noSelectorBytecode = '0x608060405234801561001057600080fd5b5060005260206000f3';

    const { phases, releaseReadiness } = await runCistPhases(context, {
      env: {},
      provider: makeMockProvider({
        escrowCode: noSelectorBytecode,
        registryCode: noSelectorBytecode,
      }),
      escrowAddress: ESCROW_ADDRESS,
      registryAddress: REGISTRY_ADDRESS,
    });

    const paths = writeReports({
      runContext: context,
      phases,
      releaseReadiness,
      mode: 'fixture',
      scenario: 'all-agree',
      startedAt: new Date('2026-04-27T14:30:12Z'),
      finishedAt: new Date('2026-04-27T14:30:13Z'),
    });

    const written = JSON.parse(fs.readFileSync(paths.jsonPath, 'utf8'));

    expect(written.releaseReadiness.unresolved).to.include.members([
      'PROD_BLOCKER_OPERATOR_PAYOUT_MISSING',
      'PROD_BLOCKER_UNSTAKE_MISSING',
    ]);
    expect(written.result).to.equal('FAIL');
  });
});
