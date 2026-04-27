'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { STATE, createPhaseResult } = require('../phases');
const { buildSafeEnvSummary } = require('../config');
const {
  scanContentForSecrets,
  assertContentIsSafe,
  REASON,
} = require('../redaction');

const PHASE_INDEX = 1;

const REQUIRED_ENV_BY_MODE = Object.freeze({
  fixture: [],
  'live-testnet': [
    'RPC_URL',
    'OPERATOR_PRIVATE_KEY',
    'PILOT_ESCROW_ADDRESS',
    'VENOM_REGISTRY_ADDRESS',
  ],
});

/**
 * Phase 1: Config and redaction preflight.
 *
 * Verifies:
 * - required environment variables for the selected mode
 * - redaction scanner self-test behavior
 * - run directory writability
 *
 * This phase intentionally reads only a safe environment summary for reporting.
 * It checks raw env only for presence/absence and never stores raw secret values
 * in notes or result metadata.
 *
 * @param {object} context RunContext from cist/config.js
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env=process.env]
 * @returns {Promise<object>} PhaseResult
 */
async function runConfigPreflight(context, options = {}) {
  const started = performance.now();
  const env = options.env || process.env;
  const notes = [];
  const codes = [];

  try {
    validateContextShape(context);

    const envSummary = buildSafeEnvSummary(env);
    const missing = findMissingRequiredEnv(context.mode, env);

    if (missing.length > 0) {
      codes.push('CONFIG_ENV_MISSING');
      notes.push(
        `Missing required environment variables for mode ${context.mode}: ${missing.join(', ')}`
      );

      return phaseResult(STATE.FAIL, started, codes, notes, {
        envSummary,
      });
    }

    const redactionSelfTest = runRedactionSelfTest();
    if (!redactionSelfTest.ok) {
      codes.push('CONFIG_SECRET_LEAK_DETECTED');
      notes.push(redactionSelfTest.note);

      return phaseResult(STATE.FAIL, started, codes, notes, {
        envSummary,
      });
    }

    const writable = verifyRunDirectoryWritable(context.runDir);
    if (!writable.ok) {
      codes.push('CONFIG_RUNDIR_NOT_WRITABLE');
      notes.push(writable.note);

      return phaseResult(STATE.FAIL, started, codes, notes, {
        envSummary,
      });
    }

    notes.push('Environment summary built without storing raw secret values.');
    notes.push('Redaction scanner self-test passed.');
    notes.push('Run directory is writable.');

    return phaseResult(STATE.PASS, started, codes, notes, {
      envSummary,
    });
  } catch (error) {
    codes.push('CIST_UNEXPECTED_ERROR');
    notes.push(`Config preflight failed unexpectedly: ${safeErrorMessage(error)}`);

    return phaseResult(STATE.FAIL, started, codes, notes);
  }
}

function findMissingRequiredEnv(mode, env) {
  const required = REQUIRED_ENV_BY_MODE[mode] || [];
  return required.filter((name) => !env[name]);
}

function runRedactionSelfTest() {
  const syntheticPrivateKey =
    '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  const unsafeScan = scanContentForSecrets(`self-test=${syntheticPrivateKey}`, {
    source: 'redaction-self-test',
  });

  if (unsafeScan.safe || unsafeScan.reason !== REASON.MATCH_FOUND) {
    return {
      ok: false,
      note: 'Redaction scanner self-test failed: private-key-shaped content was not detected.',
    };
  }

  try {
    assertContentIsSafe('ordinary CIST self-test output', {
      source: 'redaction-self-test',
    });
  } catch {
    return {
      ok: false,
      note: 'Redaction scanner self-test failed: safe content was blocked.',
    };
  }

  return { ok: true };
}

function verifyRunDirectoryWritable(runDir) {
  if (!runDir || typeof runDir !== 'string') {
    return {
      ok: false,
      note: 'Run directory is missing or invalid.',
    };
  }

  try {
    fs.mkdirSync(runDir, { recursive: true });

    const probePath = path.join(
      runDir,
      `.config-preflight-write-test.${process.pid}.${Date.now()}.tmp`
    );

    fs.writeFileSync(probePath, 'ok\n', { encoding: 'utf8', flag: 'wx' });
    fs.rmSync(probePath, { force: true });

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      note: `Run directory is not writable: ${safeErrorMessage(error)}`,
    };
  }
}

function validateContextShape(context) {
  if (!context || typeof context !== 'object') {
    throw new Error('RunContext is required');
  }

  if (!context.mode || typeof context.mode !== 'string') {
    throw new Error('RunContext.mode is required');
  }

  if (!context.runDir || typeof context.runDir !== 'string') {
    throw new Error('RunContext.runDir is required');
  }
}

function phaseResult(state, started, codes, notes, extra = {}) {
  return createPhaseResult(PHASE_INDEX, state, {
    durationMs: Math.max(0, Math.round(performance.now() - started)),
    codes,
    notes,
    ...extra,
  });
}

function safeErrorMessage(error) {
  if (!error || !error.message) return 'unknown error';

  // Keep this deliberately conservative: never include stack traces or raw objects
  // in phase notes, because notes are report-bound.
  return String(error.message);
}

module.exports = {
  PHASE_INDEX,
  REQUIRED_ENV_BY_MODE,
  runConfigPreflight,
  findMissingRequiredEnv,
  runRedactionSelfTest,
  verifyRunDirectoryWritable,
};
