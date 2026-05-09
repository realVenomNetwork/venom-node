'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { ethers } = require('ethers');

const { STATE, createPhaseResult } = require('../phases');

const PHASE_INDEX = 9;
const DEFAULT_CANARY_BALANCE_FLOOR_ETH = '0.16';
const PRIVATE_KEY_PATTERN = /0x[0-9a-fA-F]{64}/;
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

const ESCROW_CONSTANTS = Object.freeze([
  'REQUIRED_ORACLES',
  'SCORE_QUORUM_PCT',
  'PARTICIPATION_FLOOR_PCT',
  'CAMPAIGN_TIMEOUT_BLOCKS',
]);

const REGISTRY_CONSTANTS = Object.freeze([
  'MIN_STAKE',
  'SLASH_PERCENT',
  'MAX_DEVIATION',
]);

function addCode(codes, code) {
  if (!codes.includes(code)) codes.push(code);
}

function normalizeAddress(value, label) {
  try {
    return ethers.getAddress(value);
  } catch {
    throw new Error(`${label} must be a valid EVM address`);
  }
}

function normalizeQueueSuffix(input) {
  const suffix = String(input || '').trim();
  if (!suffix || !QUEUE_SUFFIX_PATTERN.test(suffix)) {
    throw new Error('queue suffix must be 1-64 characters using only letters, numbers, dot, underscore, or dash');
  }
  return suffix;
}

function readManifest(manifestPath, fsImpl = fs) {
  try {
    return JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read manifest.json: ${error.message}`);
  }
}

function validateManifestShape(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('manifest.json must contain a JSON object');
  }
  if (manifest.schemaVersion !== 1) {
    throw new Error('manifest.schemaVersion must equal 1');
  }
  if (!PROFILE_CONSTANTS[manifest.profile]) {
    throw new Error(`Unsupported canary profile: ${manifest.profile}`);
  }
  if (!manifest.deployment || typeof manifest.deployment !== 'object') {
    throw new Error('manifest.deployment is required');
  }
  normalizeAddress(manifest.deployment.registry, 'manifest.deployment.registry');
  normalizeAddress(manifest.deployment.escrow, 'manifest.deployment.escrow');
  if (!Number.isSafeInteger(Number(manifest.deployment.chainId))) {
    throw new Error('manifest.deployment.chainId is required');
  }
  if (!Array.isArray(manifest.operators) || manifest.operators.length === 0) {
    throw new Error('manifest.operators must be a non-empty array');
  }

  for (const [index, operator] of manifest.operators.entries()) {
    if (!operator || typeof operator !== 'object') {
      throw new Error(`manifest.operators[${index}] must be an object`);
    }
    if (typeof operator.id !== 'string' || !operator.id) {
      throw new Error(`manifest.operators[${index}].id is required`);
    }
    normalizeAddress(operator.address, `manifest.operators[${index}].address`);
    if (typeof operator.envPath !== 'string' || !operator.envPath) {
      throw new Error(`manifest.operators[${index}].envPath is required`);
    }
    if (typeof operator.queueSuffix !== 'string' || !operator.queueSuffix) {
      throw new Error(`manifest.operators[${index}].queueSuffix is required`);
    }
  }
}

function parseOperatorEnvFlags(envPath, fsImpl = fs) {
  let text;
  try {
    text = fsImpl.readFileSync(envPath, 'utf8');
  } catch (error) {
    const wrapped = new Error(`Could not read operator env ${envPath}: ${error.message}`);
    wrapped.code = 'CANARY_OPERATOR_ENV_UNREADABLE';
    throw wrapped;
  }

  const flags = {
    privateMultiaddr: false,
    queueSuffix: null,
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (key === 'VENOM_ALLOW_PRIVATE_MULTIADDR') {
      flags.privateMultiaddr = line.slice(eq + 1).trim().toLowerCase() === 'true';
    } else if (key === 'OPERATOR_QUEUE_SUFFIX') {
      flags.queueSuffix = line.slice(eq + 1).trim();
    }
  }

  return flags;
}

async function readContractConstants(escrow, registry) {
  const constants = {};
  for (const key of ESCROW_CONSTANTS) {
    if (!escrow || typeof escrow[key] !== 'function') {
      throw new Error(`Escrow contract missing ${key}()`);
    }
    constants[key] = await escrow[key]();
  }
  for (const key of REGISTRY_CONSTANTS) {
    if (!registry || typeof registry[key] !== 'function') {
      throw new Error(`Registry contract missing ${key}()`);
    }
    constants[key] = await registry[key]();
  }
  return constants;
}

function expectedProfileConstants(profile) {
  const constants = PROFILE_CONSTANTS[profile];
  if (!constants) throw new Error(`Unsupported canary profile: ${profile}`);
  return constants;
}

function compareConstants(actual, expected, notes) {
  let ok = true;
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (String(actual[key]) !== String(expectedValue)) {
      notes.push(`${key} mismatch: expected ${expectedValue}, got ${actual[key]}`);
      ok = false;
    }
  }
  return ok;
}

function resolveBalanceFloor(profile, minStake, env = {}) {
  if (env.PREFLIGHT_OPERATOR_BALANCE_FLOOR) {
    return ethers.parseEther(env.PREFLIGHT_OPERATOR_BALANCE_FLOOR);
  }
  if (profile === 'canary-01-5' && !env.PREFLIGHT_BALANCE_BUFFER_ETH) {
    return ethers.parseEther(DEFAULT_CANARY_BALANCE_FLOOR_ETH);
  }
  return minStake + ethers.parseEther(env.PREFLIGHT_BALANCE_BUFFER_ETH || '0.02');
}

function redactSecrets(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return !PRIVATE_KEY_PATTERN.test(text);
}

async function runCanaryReadiness(context, options = {}) {
  const start = performance.now();
  const codes = [];
  const notes = [];
  const env = options.env || process.env;
  const canaryEnvsDir = options.canaryEnvsDir || context.canaryEnvsDir || null;
  const localOnly = options.localOnly === true || context.localOnly === true;

  if (!canaryEnvsDir) {
    return createPhaseResult(PHASE_INDEX, STATE.SKIP, {
      durationMs: Math.round(performance.now() - start),
      notes: ['--canary-envs not supplied; canary readiness gates skipped.'],
    });
  }

  let manifest;
  const manifestPath = path.resolve(canaryEnvsDir, 'manifest.json');

  try {
    manifest = readManifest(manifestPath, options.fs || fs);
    validateManifestShape(manifest);
  } catch (error) {
    addCode(codes, 'CANARY_MANIFEST_INVALID');
    notes.push(error.message);
    return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
      durationMs: Math.round(performance.now() - start),
      codes,
      notes,
    });
  }

  const manifestSummary = {
    profile: manifest.profile,
    operatorCount: manifest.operators.length,
    manifestPath,
  };

  const targetRegistry = options.registryAddress || env.VENOM_REGISTRY_ADDRESS;
  const targetEscrow = options.escrowAddress || env.PILOT_ESCROW_ADDRESS;

  try {
    if (normalizeAddress(manifest.deployment.registry, 'manifest registry') !== normalizeAddress(targetRegistry, 'VENOM_REGISTRY_ADDRESS')) {
      addCode(codes, 'CANARY_DEPLOYMENT_MISMATCH');
      notes.push('Manifest registry address does not match VENOM_REGISTRY_ADDRESS.');
    }
    if (normalizeAddress(manifest.deployment.escrow, 'manifest escrow') !== normalizeAddress(targetEscrow, 'PILOT_ESCROW_ADDRESS')) {
      addCode(codes, 'CANARY_DEPLOYMENT_MISMATCH');
      notes.push('Manifest escrow address does not match PILOT_ESCROW_ADDRESS.');
    }
  } catch (error) {
    addCode(codes, 'CANARY_DEPLOYMENT_MISMATCH');
    notes.push(error.message);
  }

  let minStake = 0n;
  try {
    const actualConstants = await readContractConstants(options.escrow, options.registry);
    minStake = BigInt(actualConstants.MIN_STAKE);
    if (!compareConstants(actualConstants, expectedProfileConstants(manifest.profile), notes)) {
      addCode(codes, 'CANARY_PROFILE_MISMATCH');
    }
  } catch (error) {
    addCode(codes, 'CANARY_PROFILE_MISMATCH');
    notes.push(`Could not verify deployed profile constants: ${error.message}`);
  }

  const suffixes = new Set();
  for (const operator of manifest.operators) {
    try {
      const normalizedSuffix = normalizeQueueSuffix(operator.queueSuffix);
      if (suffixes.has(normalizedSuffix)) {
        addCode(codes, 'CANARY_QUEUE_SUFFIX_INVALID');
        notes.push(`${operator.id} duplicates queue suffix ${normalizedSuffix}.`);
      }
      suffixes.add(normalizedSuffix);
    } catch (error) {
      addCode(codes, 'CANARY_QUEUE_SUFFIX_INVALID');
      notes.push(`${operator.id} has invalid queue suffix: ${error.message}`);
    }
  }

  if (env.DEPLOYER_PRIVATE_KEY) {
    try {
      const deployerAddress = normalizeAddress(new ethers.Wallet(env.DEPLOYER_PRIVATE_KEY).address, 'deployer address');
      for (const operator of manifest.operators) {
        if (normalizeAddress(operator.address, `${operator.id} address`) === deployerAddress) {
          addCode(codes, 'CANARY_OPERATOR_IS_DEPLOYER');
          notes.push(`${operator.id} address matches DEPLOYER_PRIVATE_KEY address.`);
        }
      }
    } catch (error) {
      addCode(codes, 'CANARY_OPERATOR_IS_DEPLOYER');
      notes.push(`Could not derive DEPLOYER_PRIVATE_KEY address: ${error.message}`);
    }
  }

  if (options.provider && minStake > 0n) {
    let anyWarnBalance = false;
    const balanceFloor = resolveBalanceFloor(manifest.profile, minStake, env);
    const warnFloor = (balanceFloor * 110n) / 100n;
    for (const operator of manifest.operators) {
      try {
        const balance = await options.provider.getBalance(operator.address);
        if (balance < balanceFloor) {
          addCode(codes, 'CANARY_OPERATOR_BALANCE_LOW');
          notes.push(`${operator.id} balance ${ethers.formatEther(balance)} ETH below floor ${ethers.formatEther(balanceFloor)} ETH.`);
        } else if (balance < warnFloor) {
          anyWarnBalance = true;
          notes.push(`${operator.id} balance ${ethers.formatEther(balance)} ETH is within 10% of the floor ${ethers.formatEther(balanceFloor)} ETH.`);
        }
      } catch (error) {
        addCode(codes, 'CANARY_OPERATOR_BALANCE_LOW');
        notes.push(`Could not read balance for ${operator.id}: ${error.message}`);
      }
    }
    if (anyWarnBalance && !codes.includes('CANARY_OPERATOR_BALANCE_LOW')) {
      notes.push('One or more operator balances are close to the configured floor.');
    }
  }

  for (const operator of manifest.operators) {
    const envPath = path.resolve(canaryEnvsDir, operator.envPath);
    try {
      const flags = parseOperatorEnvFlags(envPath, options.fs || fs);
      if (flags.queueSuffix && flags.queueSuffix !== operator.queueSuffix) {
        addCode(codes, 'CANARY_QUEUE_SUFFIX_INVALID');
        notes.push(`${operator.id} env queue suffix ${flags.queueSuffix} does not match manifest ${operator.queueSuffix}.`);
      }
      if (!localOnly && flags.privateMultiaddr) {
        addCode(codes, 'CANARY_PRIVATE_MULTIADDR');
        notes.push(`${operator.id} enables VENOM_ALLOW_PRIVATE_MULTIADDR outside --local-only.`);
      }
    } catch (error) {
      addCode(codes, error.code === 'CANARY_OPERATOR_ENV_UNREADABLE' ? error.code : 'CANARY_OPERATOR_ENV_UNREADABLE');
      notes.push(error.message);
    }
  }

  const state = codes.length > 0
    ? STATE.FAIL
    : notes.some((note) => note.includes('within 10%') || note.includes('close to the configured floor'))
      ? STATE.WARN
      : STATE.PASS;

  const result = createPhaseResult(PHASE_INDEX, state, {
    durationMs: Math.round(performance.now() - start),
    codes,
    notes,
    manifest: manifestSummary,
  });

  if (!redactSecrets(result)) {
    return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
      durationMs: Math.round(performance.now() - start),
      codes: ['CANARY_MANIFEST_INVALID'],
      notes: ['Canary readiness result contained secret-shaped material and was suppressed.'],
    });
  }

  return result;
}

module.exports = {
  PHASE_INDEX,
  parseOperatorEnvFlags,
  resolveBalanceFloor,
  validateManifestShape,
  runCanaryReadiness,
};
