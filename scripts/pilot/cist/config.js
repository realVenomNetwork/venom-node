'use strict';

const path = require('node:path');
const { createRunContext } = require('./run-id');

const MODES = Object.freeze({
  FIXTURE: 'fixture',
  LIVE_TESTNET: 'live-testnet'
});

const SCENARIOS = Object.freeze({
  ALL_AGREE: 'all-agree',
  MIXED: 'mixed',
  WITH_ABSTAIN: 'with-abstain'
});

const SUPPORTED_MODES = Object.freeze(new Set(Object.values(MODES)));
const SUPPORTED_SCENARIOS = Object.freeze(new Set(Object.values(SCENARIOS)));

function parseArgs(argv = []) {
  const options = {
    mode: MODES.FIXTURE,
    scenario: SCENARIOS.ALL_AGREE,
    explain: false,
    json: false,
    confirmLiveTestnet: false
  };

  for (const arg of argv) {
    if (arg === '--explain') {
      options.explain = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--confirm-live-testnet') {
      options.confirmLiveTestnet = true;
    } else if (arg.startsWith('--mode=')) {
      options.mode = arg.slice('--mode='.length);
    } else if (arg.startsWith('--scenario=')) {
      options.scenario = arg.slice('--scenario='.length);
    } else {
      throw makeConfigError(
        'CONFIG_UNSUPPORTED_ARGUMENT',
        `Unsupported CIST argument: ${arg}`,
        [
          'Supported examples:',
          '  npm run pilot:smoke-test',
          '  npm run pilot:smoke-test -- --scenario=mixed',
          '  npm run pilot:smoke-test -- --json'
        ]
      );
    }
  }

  if (!SUPPORTED_MODES.has(options.mode)) {
    throw makeConfigError(
      'CONFIG_UNSUPPORTED_MODE',
      `Unsupported CIST mode: ${options.mode}`,
      [
        'Supported modes:',
        `  ${MODES.FIXTURE}`,
        `  ${MODES.LIVE_TESTNET}`
      ]
    );
  }

  if (!SUPPORTED_SCENARIOS.has(options.scenario)) {
    throw makeConfigError(
      'CONFIG_UNSUPPORTED_SCENARIO',
      `Unsupported CIST scenario: ${options.scenario}`,
      [
        'Supported scenarios:',
        `  ${SCENARIOS.ALL_AGREE}`,
        `  ${SCENARIOS.MIXED}`,
        `  ${SCENARIOS.WITH_ABSTAIN}`
      ]
    );
  }

  if (options.mode === MODES.LIVE_TESTNET && !options.confirmLiveTestnet) {
    throw makeConfigError(
      'CONFIG_LIVE_TESTNET_CONFIRMATION_MISSING',
      'live-testnet mode requires --confirm-live-testnet',
      [
        'This mode may submit transactions and spend testnet ETH.',
        'Rerun only if that is intentional:',
        '  npm run pilot:smoke-test -- --mode=live-testnet --confirm-live-testnet'
      ]
    );
  }

  return options;
}

function buildRunContext(input = {}) {
  const {
    argv = [],
    env = process.env,
    cwd = process.cwd(),
    startedAt = new Date(),
    baseDir,
    runId
  } = input;

  const options = parseArgs(argv);
  const run = createRunContext({
    baseDir: baseDir || path.join(cwd, 'tmp', 'smoke-test'),
    runId
  });

  const context = {
    runId: run.runId,
    runDir: run.runDir,
    baseDir: path.dirname(run.runDir),

    command: 'npm run pilot:smoke-test',
    argv: [...argv],

    mode: options.mode,
    scenario: options.scenario,
    explain: options.explain,
    json: options.json,
    confirmLiveTestnet: options.confirmLiveTestnet,

    startedAt,

    env: buildSafeEnvSummary(env),

    network: {
      chainId: null,
      name: null,
      rpcRedacted: true
    },

    paths: {
      reportJson: path.join(run.runDir, 'report.json'),
      reportMarkdown: path.join(run.runDir, 'report.md')
    },

    safety: buildSafetySummary(options.mode)
  };

  validateRunContext(context);
  return context;
}

function buildSafeEnvSummary(env = {}) {
  return {
    nodeEnv: env.NODE_ENV || null,
    useTestPayload: env.USE_TEST_PAYLOAD === 'true',

    redisHost: env.REDIS_HOST || '127.0.0.1',
    redisPort: Number(env.REDIS_PORT || 6379),
    cistRedisDb: Number(env.CIST_REDIS_DB || 14),

    mlServiceUrl: env.ML_SERVICE_URL || null,

    rpcUrlSet: Boolean(env.RPC_URL || env.RPC_URLS),
    operatorPrivateKeySet: Boolean(
      env.OPERATOR_PRIVATE_KEY ||
      env.BROADCASTER_PRIVATE_KEY ||
      env.DEPLOYER_PRIVATE_KEY
    ),

    pilotEscrowAddressSet: Boolean(env.PILOT_ESCROW_ADDRESS),
    venomRegistryAddressSet: Boolean(env.VENOM_REGISTRY_ADDRESS)
  };
}

function buildSafetySummary(mode) {
  if (mode === MODES.FIXTURE) {
    return {
      touchesLiveState: false,
      maySpendTestnetEth: false,
      fixtureKeysAllowed: true,
      line: 'fixture mode uses local/synthetic inputs; no live funds or live state are touched.'
    };
  }

  return {
    touchesLiveState: true,
    maySpendTestnetEth: true,
    fixtureKeysAllowed: false,
    line: 'live-testnet may submit transactions and spend testnet ETH.'
  };
}

function validateRunContext(context) {
  if (!context || typeof context !== 'object') {
    throw new Error('Invalid RunContext: expected object');
  }

  if (!context.runId || typeof context.runId !== 'string') {
    throw new Error('Invalid RunContext: runId must be a string');
  }

  if (!context.runDir || typeof context.runDir !== 'string' || !path.isAbsolute(context.runDir)) {
    throw new Error('Invalid RunContext: runDir must be an absolute path');
  }

  if (!SUPPORTED_MODES.has(context.mode)) {
    throw new Error(`Invalid RunContext: unsupported mode ${context.mode}`);
  }

  if (!SUPPORTED_SCENARIOS.has(context.scenario)) {
    throw new Error(`Invalid RunContext: unsupported scenario ${context.scenario}`);
  }

  if (!context.paths || typeof context.paths.reportJson !== 'string' || typeof context.paths.reportMarkdown !== 'string') {
    throw new Error('Invalid RunContext: report paths are required');
  }

  return true;
}

function summarizeRunContextForCli(context) {
  return {
    mode: context.mode,
    scenario: context.scenario,
    safety: context.safety.line,
    runId: context.runId,
    evidence: context.runDir
  };
}

function makeConfigError(code, message, details = []) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function configErrorToText(error) {
  const lines = [error.message];

  if (Array.isArray(error.details) && error.details.length > 0) {
    lines.push('', ...error.details);
  }

  return `${lines.join('\n')}\n`;
}

module.exports = {
  MODES,
  SCENARIOS,
  SUPPORTED_MODES,
  SUPPORTED_SCENARIOS,
  parseArgs,
  buildRunContext,
  buildSafeEnvSummary,
  buildSafetySummary,
  validateRunContext,
  summarizeRunContextForCli,
  makeConfigError,
  configErrorToText
};
