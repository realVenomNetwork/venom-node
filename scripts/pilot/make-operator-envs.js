#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');

const DEFAULT_PROFILE = 'canary-01-5';
const DEFAULT_HEALTH_PORT_BASE = 3000;
const QUEUE_SUFFIX_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

const PROFILE_CONSTANTS = Object.freeze({
  'canary-01-5': Object.freeze({
    REQUIRED_ORACLES: 3,
    SCORE_QUORUM_PCT: 50,
    PARTICIPATION_FLOOR_PCT: 67,
    CAMPAIGN_TIMEOUT_BLOCKS: 3600,
    MIN_STAKE: '100000000000000000',
    SLASH_PERCENT: 5,
    MAX_DEVIATION: 25,
  }),
});

class MakeEnvsError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'MakeEnvsError';
    this.code = code;
    this.messageText = message;
  }
}

function makeError(code, message) {
  return new MakeEnvsError(code, message);
}

function renderHelp() {
  return [
    'Usage:',
    '  node scripts/pilot/make-operator-envs.js --count=5 --deployment=deployments/base-sepolia.json --out=.venom-canary [options]',
    '',
    'Options:',
    '  --count=<n>              Number of operator envs to generate, 2-20.',
    '  --deployment=<path>      Deployment artifact from scripts/deploy_phase4.js.',
    '  --out=<dir>              Output directory for generated operator envs.',
    '  --profile=<name>         Expected deployment profile. Default: canary-01-5.',
    '  --health-port-base=<n>   First operator health port. Default: 3000.',
    '  --compose-out=<path>     Compose file path. Default: docker-compose.<profile>.yml.',
    '  --force                  Replace existing output and compose file.',
    '  --json                   Print JSON result.',
    '  --help, -h               Show this help.',
    '',
  ].join('\n');
}

function parseIntegerFlag(name, value, min, max) {
  if (!/^\d+$/.test(String(value || ''))) {
    throw makeError('MAKE_ENVS_BAD_ARG', `${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw makeError('MAKE_ENVS_BAD_ARG', `${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

function parseArgs(argv = []) {
  const options = {
    count: null,
    deployment: null,
    out: null,
    profile: DEFAULT_PROFILE,
    healthPortBase: DEFAULT_HEALTH_PORT_BASE,
    composeOut: null,
    force: false,
    json: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg.startsWith('--count=')) {
      options.count = parseIntegerFlag('--count', arg.slice('--count='.length), 2, 20);
    } else if (arg.startsWith('--deployment=')) {
      options.deployment = arg.slice('--deployment='.length);
    } else if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length);
    } else if (arg.startsWith('--profile=')) {
      options.profile = arg.slice('--profile='.length);
    } else if (arg.startsWith('--health-port-base=')) {
      options.healthPortBase = parseIntegerFlag('--health-port-base', arg.slice('--health-port-base='.length), 1024, 65515);
    } else if (arg.startsWith('--compose-out=')) {
      options.composeOut = arg.slice('--compose-out='.length);
    } else {
      throw makeError('MAKE_ENVS_BAD_ARG', `Unsupported argument: ${arg}`);
    }
  }

  if (options.help) return options;
  if (!options.count) throw makeError('MAKE_ENVS_BAD_ARG', '--count is required');
  if (!options.deployment) throw makeError('MAKE_ENVS_BAD_ARG', '--deployment is required');
  if (!options.out) throw makeError('MAKE_ENVS_BAD_ARG', '--out is required');
  if (!PROFILE_CONSTANTS[options.profile]) {
    throw makeError('MAKE_ENVS_BAD_ARG', `Unsupported profile: ${options.profile}`);
  }
  if (options.healthPortBase + options.count - 1 > 65535) {
    throw makeError('MAKE_ENVS_BAD_ARG', 'health port range exceeds 65535');
  }

  return options;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw makeError('MAKE_ENVS_DEPLOYMENT_INVALID', `Cannot read deployment artifact: ${error.message}`);
  }
}

function normalizeAddress(value, fieldName) {
  try {
    return ethers.getAddress(value);
  } catch {
    throw makeError('MAKE_ENVS_DEPLOYMENT_INVALID', `${fieldName} must be a valid EVM address`);
  }
}

function assertProfileConstants(actual, expected) {
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (!Object.prototype.hasOwnProperty.call(actual, key)) {
      throw makeError('MAKE_ENVS_DEPLOYMENT_INVALID', `Deployment profile.constants.${key} is missing`);
    }
    if (String(actual[key]) !== String(expectedValue)) {
      throw makeError(
        'MAKE_ENVS_PROFILE_MISMATCH',
        `Deployment profile.constants.${key} expected ${expectedValue}, got ${actual[key]}`
      );
    }
  }
}

function validateDeploymentArtifact(artifact, expectedProfile) {
  if (!artifact || typeof artifact !== 'object') {
    throw makeError('MAKE_ENVS_DEPLOYMENT_INVALID', 'Deployment artifact must be a JSON object');
  }
  const profile = artifact.profile;
  if (!profile || profile.name !== expectedProfile) {
    throw makeError(
      'MAKE_ENVS_PROFILE_MISMATCH',
      `Deployment profile must be ${expectedProfile}; got ${profile && profile.name ? profile.name : 'missing'}`
    );
  }
  if (!profile.constants || typeof profile.constants !== 'object') {
    throw makeError('MAKE_ENVS_DEPLOYMENT_INVALID', 'Deployment profile.constants is missing');
  }
  assertProfileConstants(profile.constants, PROFILE_CONSTANTS[expectedProfile]);

  const registry = normalizeAddress(artifact.contracts?.VenomRegistry?.address, 'contracts.VenomRegistry.address');
  const escrow = normalizeAddress(artifact.contracts?.PilotEscrow?.address, 'contracts.PilotEscrow.address');
  if (typeof artifact.network !== 'string' || !artifact.network.trim()) {
    throw makeError('MAKE_ENVS_DEPLOYMENT_INVALID', 'network is required');
  }
  if (!Number.isSafeInteger(Number(artifact.chainId))) {
    throw makeError('MAKE_ENVS_DEPLOYMENT_INVALID', 'chainId is required');
  }

  return {
    network: artifact.network,
    chainId: Number(artifact.chainId),
    registry,
    escrow,
    profile: expectedProfile,
    constants: { ...profile.constants },
  };
}

function listOperatorDirs(outDir) {
  if (!fs.existsSync(outDir)) return [];
  return fs.readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^operator-\d+$/.test(entry.name))
    .map((entry) => Number(entry.name.slice('operator-'.length)))
    .sort((a, b) => a - b);
}

function assertOutputCanBeWritten(outDir, composeOut, count, force) {
  if (!force && fs.existsSync(composeOut)) {
    throw makeError('MAKE_ENVS_OUTPUT_EXISTS', `Compose output already exists: ${composeOut}`);
  }

  const existingOperators = listOperatorDirs(outDir);
  const stray = existingOperators.find((index) => index > count);
  if (!force && stray) {
    throw makeError('MAKE_ENVS_STRAY_OPERATOR', `Found existing operator-${stray} outside requested count`);
  }
  const overlapping = existingOperators.find((index) => index <= count);
  if (!force && overlapping) {
    throw makeError('MAKE_ENVS_OUTPUT_EXISTS', `Found existing operator-${overlapping}; rerun with --force to replace`);
  }
}

function assertQueueSuffix(suffix) {
  if (!QUEUE_SUFFIX_PATTERN.test(suffix)) {
    throw makeError('MAKE_ENVS_INTERNAL', `Generated invalid OPERATOR_QUEUE_SUFFIX: ${suffix}`);
  }
}

function writePrivateEnv(filePath, body) {
  fs.writeFileSync(filePath, body, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    if (process.platform !== 'win32') {
      throw makeError('MAKE_ENVS_PERM', `Could not set 0600 permissions on ${filePath}: ${error.message}`);
    }
  }
  if (process.platform !== 'win32') {
    const mode = fs.statSync(filePath).mode & 0o777;
    if (mode !== 0o600) {
      throw makeError('MAKE_ENVS_PERM', `Expected 0600 permissions on ${filePath}, got ${mode.toString(8)}`);
    }
  }
}

function buildOperatorEnv({ operatorIndex, count, deployment, healthPort, privateKey, queueSuffix }) {
  return [
    '# Generated by scripts/pilot/make-operator-envs.js. Do not commit this file.',
    `# Operator ${operatorIndex} of ${count} for ${deployment.profile}.`,
    '',
    `OPERATOR_PRIVATE_KEY=${privateKey}`,
    `OPERATOR_QUEUE_SUFFIX=${queueSuffix}`,
    '',
    `VENOM_REGISTRY_ADDRESS=${deployment.registry}`,
    `PILOT_ESCROW_ADDRESS=${deployment.escrow}`,
    `DEPLOY_PROFILE=${deployment.profile}`,
    '',
    'VENOM_RUNTIME_MODE=testnet',
    'USE_TEST_PAYLOAD=false',
    '',
    `HEALTH_PORT=${healthPort}`,
    'HEALTH_HOST=127.0.0.1',
    '',
    'VENOM_ALLOW_PRIVATE_MULTIADDR=false',
    '',
  ].join('\n');
}

function toComposePath(filePath, composeDir) {
  let relative = path.relative(composeDir, filePath);
  if (!relative.startsWith('.') && !path.isAbsolute(relative)) {
    relative = `.${path.sep}${relative}`;
  }
  return relative.split(path.sep).join('/');
}

function buildCompose({ profile, operators, outDir, composeOut }) {
  const composeDir = path.dirname(composeOut);
  const lines = [
    'services:',
    '  redis-canary:',
    '    image: redis:7-alpine',
    '    container_name: venom-redis-canary',
    '    ports:',
    '      - "127.0.0.1:6380:6379"',
    '    environment:',
    '      - REDIS_PASSWORD=${REDIS_PASSWORD:-}',
    '    env_file:',
    '      - path: .env',
    '        required: false',
    '    volumes:',
    '      - redis_canary_data:/data',
    '    command:',
    '      - sh',
    '      - -c',
    '      - |',
    '        cat > /tmp/users.acl <<EOF',
    '        user default off',
    '        user venom_dash on >${REDIS_PASSWORD:-venom_dash_dev_password} ~* &* -@all +ping +info +client +get +mget +scan +ttl +type +subscribe +psubscribe +unsubscribe +punsubscribe',
    '        user venom_node on >${REDIS_PASSWORD:-venom_dash_dev_password} ~* &* +@all',
    '        EOF',
    '        redis-server --appendonly yes --aclfile /tmp/users.acl',
    '    restart: unless-stopped',
    '    healthcheck:',
    '      test: ["CMD-SHELL", "redis-cli --user venom_node --pass \\"$${REDIS_PASSWORD:-venom_dash_dev_password}\\" ping"]',
    '      interval: 10s',
    '      timeout: 3s',
    '      retries: 5',
    '',
    '  ml-service-canary:',
    '    build:',
    '      context: .',
    '      dockerfile: ml_service/Dockerfile',
    '    container_name: venom-ml-service-canary',
    '    ports:',
    '      - "127.0.0.1:8001:8000"',
    '    environment:',
    '      - TF_ENABLE_ONEDNN_OPTS=0',
    '      - VENOM_RUNTIME_MODE=testnet',
    '      - ML_SERVICE_API_KEY=${ML_SERVICE_API_KEY:-}',
    '    depends_on:',
    '      redis-canary:',
    '        condition: service_healthy',
    '    restart: unless-stopped',
    '    healthcheck:',
      '      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen(\'http://127.0.0.1:8000/health\', timeout=5)"]',
    '      interval: 30s',
    '      timeout: 10s',
    '      retries: 5',
    '      start_period: 60s',
  ];

  for (const operator of operators) {
    const envPath = path.join(outDir, operator.envPath);
    lines.push(
      '',
      `  venom-node-canary-${operator.index}:`,
      '    build:',
      '      context: .',
      '      dockerfile: Dockerfile',
      `    container_name: venom-node-canary-${operator.index}`,
      '    env_file:',
      '      - path: .env',
      '        required: false',
      `      - path: ${toComposePath(envPath, composeDir)}`,
      '        required: true',
      '    environment:',
      '      - NODE_ENV=production',
      '      - VENOM_RUNTIME_MODE=testnet',
      '      - USE_TEST_PAYLOAD=false',
      `      - HEALTH_PORT=${operator.healthPort}`,
      '      - REDIS_HOST=redis-canary',
      '      - REDIS_PORT=6379',
      '      - REDIS_USERNAME=venom_node',
      '      - REDIS_PASSWORD=${REDIS_PASSWORD:-venom_dash_dev_password}',
      '      - ML_SERVICE_URL=http://ml-service-canary:8000/evaluate',
      '      - ML_SERVICE_API_KEY=${ML_SERVICE_API_KEY:-}',
      '    depends_on:',
      '      redis-canary:',
      '        condition: service_healthy',
      '      ml-service-canary:',
      '        condition: service_healthy',
      '    restart: unless-stopped',
      '    command: ["node", "register_and_start.js"]'
    );
  }

  lines.push('', 'volumes:', '  redis_canary_data:', '');
  return `# Generated for ${profile}. Run with: docker compose --project-name canary -f ${path.basename(composeOut)} up -d --build\n${lines.join('\n')}`;
}

function buildFundingTargets(operators, generatedAt) {
  return [
    '# Canary 01.5 funding targets - addresses derived from generated keys.',
    '# Recommended balance: 0.16-0.20 ETH per address on Base Sepolia.',
    `# Generated ${generatedAt}.`,
    ...operators.map((operator) => `${operator.id} ${operator.address}`),
    '',
  ].join('\n');
}

function buildManifest({ deployment, operators, generatedAt }) {
  return {
    schemaVersion: 1,
    profile: deployment.profile,
    deployment: {
      network: deployment.network,
      chainId: deployment.chainId,
      registry: deployment.registry,
      escrow: deployment.escrow,
    },
    operators: operators.map((operator) => ({
      id: operator.id,
      address: operator.address,
      envPath: operator.envPath,
      healthPort: operator.healthPort,
      queueSuffix: operator.queueSuffix,
    })),
    generatedAt,
  };
}

function generateOperatorFiles(options, deps = {}) {
  const cwd = deps.cwd || process.cwd();
  const now = deps.now || (() => new Date());
  const walletFactory = deps.walletFactory || (() => ethers.Wallet.createRandom());
  const env = deps.env || process.env;
  const deploymentPath = path.resolve(cwd, options.deployment);
  const outDir = path.resolve(cwd, options.out);
  const composeOut = path.resolve(cwd, options.composeOut || `docker-compose.${options.profile}.yml`);
  const deployment = validateDeploymentArtifact(readJsonFile(deploymentPath), options.profile);

  assertOutputCanBeWritten(outDir, composeOut, options.count, options.force);

  const generatedAt = now().toISOString();
  const warnings = [];
  if (env.DEPLOYER_PRIVATE_KEY) {
    warnings.push('DEPLOYER_PRIVATE_KEY is set in the calling environment and was intentionally not propagated.');
  }

  const tmpDir = `${outDir}.tmp-${process.pid}-${Date.now()}`;
  const tmpCompose = `${composeOut}.tmp-${process.pid}-${Date.now()}`;

  if (fs.existsSync(tmpDir) || fs.existsSync(tmpCompose)) {
    throw makeError('MAKE_ENVS_OUTPUT_EXISTS', 'Temporary output path already exists; retry the command');
  }

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const operators = [];

    for (let index = 1; index <= options.count; index++) {
      const id = `op${index}`;
      const queueSuffix = id;
      assertQueueSuffix(queueSuffix);
      const wallet = walletFactory(index);
      let privateKey = wallet.privateKey;
      const address = ethers.getAddress(wallet.address);
      const healthPort = options.healthPortBase + index - 1;
      const envPath = `operator-${index}/.env`;
      const operatorDir = path.join(tmpDir, `operator-${index}`);
      fs.mkdirSync(operatorDir, { recursive: true });

      writePrivateEnv(path.join(tmpDir, envPath), buildOperatorEnv({
        operatorIndex: index,
        count: options.count,
        deployment,
        healthPort,
        privateKey,
        queueSuffix,
      }));
      privateKey = null;

      operators.push({ index, id, address, envPath, healthPort, queueSuffix });
    }

    const manifest = buildManifest({ deployment, operators, generatedAt });
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'funding-targets.txt'), buildFundingTargets(operators, generatedAt), 'utf8');
    fs.writeFileSync(tmpCompose, buildCompose({ profile: options.profile, operators, outDir, composeOut }), 'utf8');

    if (options.force) {
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.rmSync(composeOut, { force: true });
    }
    fs.renameSync(tmpDir, outDir);
    fs.renameSync(tmpCompose, composeOut);

    return {
      ok: true,
      manifest,
      manifestPath: path.join(outDir, 'manifest.json'),
      fundingTargetsPath: path.join(outDir, 'funding-targets.txt'),
      composePath: composeOut,
      warnings,
    };
  } catch (error) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpCompose, { force: true });
    if (error instanceof MakeEnvsError) throw error;
    throw makeError('MAKE_ENVS_INTERNAL', error.message);
  }
}

function printSuccess(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  console.log('Canary operator envs generated.');
  console.log(`Manifest: ${result.manifestPath}`);
  console.log(`Funding targets: ${result.fundingTargetsPath}`);
  console.log(`Compose file: ${result.composePath}`);
  for (const operator of result.manifest.operators) {
    console.log(`${operator.id}: ${operator.address} queue=${operator.queueSuffix} health=${operator.healthPort}`);
  }
  for (const warning of result.warnings) {
    console.warn(`[WARN] ${warning}`);
  }
}

function printFailure(error, json) {
  const code = error instanceof MakeEnvsError ? error.code : 'MAKE_ENVS_INTERNAL';
  const message = error instanceof MakeEnvsError ? error.messageText : error.message;
  if (json) {
    process.stderr.write(`${JSON.stringify({ ok: false, code, message })}\n`);
  } else {
    process.stderr.write(`[${code}] ${message}\n`);
  }
}

async function main(argv = process.argv.slice(2)) {
  let parsed = { json: false };
  try {
    parsed = parseArgs(argv);
    if (parsed.help) {
      process.stdout.write(renderHelp());
      return;
    }
    const result = generateOperatorFiles(parsed);
    printSuccess(result, parsed.json);
  } catch (error) {
    printFailure(error, Boolean(parsed.json));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  PROFILE_CONSTANTS,
  MakeEnvsError,
  parseArgs,
  renderHelp,
  validateDeploymentArtifact,
  buildOperatorEnv,
  buildCompose,
  generateOperatorFiles,
  main,
};
