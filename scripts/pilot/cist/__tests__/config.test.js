'use strict';

const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MODES,
  SCENARIOS,
  parseArgs,
  buildRunContext,
  buildSafeEnvSummary,
  buildSafetySummary,
  validateRunContext,
  summarizeRunContextForCli,
  makeConfigError,
  configErrorToText
} = require('../config');

describe('CIST config / RunContext', function () {
  let root;

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cist-config-'));
  });

  afterEach(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('parseArgs returns fixture/all-agree defaults', function () {
    const options = parseArgs([]);

    expect(options).to.deep.equal({
      mode: MODES.FIXTURE,
      scenario: SCENARIOS.ALL_AGREE,
      explain: false,
      json: false,
      confirmLiveTestnet: false
    });
  });

  it('parseArgs accepts supported flags', function () {
    const options = parseArgs([
      '--mode=fixture',
      '--scenario=mixed',
      '--json',
      '--explain'
    ]);

    expect(options.mode).to.equal(MODES.FIXTURE);
    expect(options.scenario).to.equal(SCENARIOS.MIXED);
    expect(options.json).to.equal(true);
    expect(options.explain).to.equal(true);
  });

  it('parseArgs accepts live-testnet only with explicit confirmation', function () {
    const options = parseArgs([
      '--mode=live-testnet',
      '--confirm-live-testnet',
      '--scenario=with-abstain'
    ]);

    expect(options.mode).to.equal(MODES.LIVE_TESTNET);
    expect(options.confirmLiveTestnet).to.equal(true);
    expect(options.scenario).to.equal(SCENARIOS.WITH_ABSTAIN);
  });

  it('parseArgs rejects unsupported arguments, modes, and scenarios', function () {
    expect(() => parseArgs(['--unknown'])).to.throw('Unsupported CIST argument: --unknown')
      .with.property('code', 'CONFIG_UNSUPPORTED_ARGUMENT');

    expect(() => parseArgs(['--mode=mainnet'])).to.throw('Unsupported CIST mode: mainnet')
      .with.property('code', 'CONFIG_UNSUPPORTED_MODE');

    expect(() => parseArgs(['--scenario=chaos'])).to.throw('Unsupported CIST scenario: chaos')
      .with.property('code', 'CONFIG_UNSUPPORTED_SCENARIO');
  });

  it('parseArgs rejects live-testnet without confirmation', function () {
    expect(() => parseArgs(['--mode=live-testnet']))
      .to.throw('live-testnet mode requires --confirm-live-testnet')
      .with.property('code', 'CONFIG_LIVE_TESTNET_CONFIRMATION_MISSING');
  });

  it('buildSafeEnvSummary stores booleans and safe values, not raw secrets', function () {
    const secret = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const summary = buildSafeEnvSummary({
      NODE_ENV: 'test',
      USE_TEST_PAYLOAD: 'true',
      REDIS_HOST: 'redis',
      REDIS_PORT: '6380',
      CIST_REDIS_DB: '14',
      ML_SERVICE_URL: 'http://127.0.0.1:8000/evaluate',
      RPC_URL: 'https://example.invalid/rpc-token',
      OPERATOR_PRIVATE_KEY: secret,
      PILOT_ESCROW_ADDRESS: '0x0000000000000000000000000000000000000001',
      VENOM_REGISTRY_ADDRESS: '0x0000000000000000000000000000000000000002'
    });

    expect(summary).to.deep.equal({
      nodeEnv: 'test',
      useTestPayload: true,
      redisHost: 'redis',
      redisPort: 6380,
      cistRedisDb: 14,
      mlServiceUrl: 'http://127.0.0.1:8000/evaluate',
      rpcUrlSet: true,
      operatorPrivateKeySet: true,
      pilotEscrowAddressSet: true,
      venomRegistryAddressSet: true
    });

    expect(JSON.stringify(summary)).to.not.include(secret);
    expect(JSON.stringify(summary)).to.not.include('rpc-token');
  });

  it('buildSafetySummary describes fixture and live-testnet modes', function () {
    expect(buildSafetySummary(MODES.FIXTURE)).to.deep.equal({
      touchesLiveState: false,
      maySpendTestnetEth: false,
      fixtureKeysAllowed: true,
      line: 'fixture mode uses local/synthetic inputs; no live funds or live state are touched.'
    });

    expect(buildSafetySummary(MODES.LIVE_TESTNET)).to.deep.equal({
      touchesLiveState: true,
      maySpendTestnetEth: true,
      fixtureKeysAllowed: false,
      line: 'live-testnet may submit transactions and spend testnet ETH.'
    });
  });

  it('buildRunContext creates a valid context and report paths', function () {
    const context = buildRunContext({
      argv: ['--scenario=mixed'],
      env: {
        REDIS_HOST: 'redis',
        REDIS_PORT: '6379'
      },
      baseDir: root,
      runId: 'cist-20260427-143012-a83f9c1e',
      startedAt: new Date('2026-04-27T14:30:12Z')
    });

    expect(context.runId).to.equal('cist-20260427-143012-a83f9c1e');
    expect(context.runDir).to.equal(path.join(root, context.runId));
    expect(fs.existsSync(context.runDir)).to.equal(true);

    expect(context.baseDir).to.equal(root);
    expect(context.command).to.equal('npm run pilot:smoke-test');
    expect(context.argv).to.deep.equal(['--scenario=mixed']);

    expect(context.mode).to.equal(MODES.FIXTURE);
    expect(context.scenario).to.equal(SCENARIOS.MIXED);
    expect(context.startedAt.toISOString()).to.equal('2026-04-27T14:30:12.000Z');

    expect(context.paths).to.deep.equal({
      reportJson: path.join(context.runDir, 'report.json'),
      reportMarkdown: path.join(context.runDir, 'report.md')
    });

    expect(validateRunContext(context)).to.equal(true);
  });

  it('buildRunContext does not store raw secret values', function () {
    const secret = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

    const context = buildRunContext({
      argv: [],
      env: {
        OPERATOR_PRIVATE_KEY: secret,
        RPC_URL: 'https://example.invalid/super-secret-token'
      },
      baseDir: root,
      runId: 'cist-20260427-143012-a83f9c1e'
    });

    const serialized = JSON.stringify(context);

    expect(serialized).to.not.include(secret);
    expect(serialized).to.not.include('super-secret-token');
    expect(context.env.operatorPrivateKeySet).to.equal(true);
    expect(context.env.rpcUrlSet).to.equal(true);
  });

  it('summarizeRunContextForCli returns display-safe fields', function () {
    const context = buildRunContext({
      argv: [],
      env: {},
      baseDir: root,
      runId: 'cist-20260427-143012-a83f9c1e'
    });

    expect(summarizeRunContextForCli(context)).to.deep.equal({
      mode: MODES.FIXTURE,
      scenario: SCENARIOS.ALL_AGREE,
      safety: 'fixture mode uses local/synthetic inputs; no live funds or live state are touched.',
      runId: 'cist-20260427-143012-a83f9c1e',
      evidence: context.runDir
    });
  });

  it('validateRunContext rejects malformed contexts', function () {
    expect(() => validateRunContext(null)).to.throw('Invalid RunContext: expected object');

    expect(() => validateRunContext({
      runDir: root,
      mode: MODES.FIXTURE,
      scenario: SCENARIOS.ALL_AGREE,
      paths: {
        reportJson: path.join(root, 'report.json'),
        reportMarkdown: path.join(root, 'report.md')
      }
    })).to.throw('Invalid RunContext: runId must be a string');

    expect(() => validateRunContext({
      runId: 'cist-example',
      runDir: 'relative/path',
      mode: MODES.FIXTURE,
      scenario: SCENARIOS.ALL_AGREE,
      paths: {
        reportJson: 'relative/report.json',
        reportMarkdown: 'relative/report.md'
      }
    })).to.throw('Invalid RunContext: runDir must be an absolute path');
  });

  it('configErrorToText renders message and details', function () {
    const error = makeConfigError('CONFIG_EXAMPLE', 'Example config error', [
      'Detail one',
      'Detail two'
    ]);

    expect(configErrorToText(error)).to.equal(
      'Example config error\n\nDetail one\nDetail two\n'
    );
  });
});
