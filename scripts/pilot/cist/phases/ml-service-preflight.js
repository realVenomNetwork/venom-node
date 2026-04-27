'use strict';

const { performance } = require('node:perf_hooks');

const { STATE, createPhaseResult } = require('../phases');

const PHASE_INDEX = 4;

function assertMlClientShape(client) {
  if (!client || typeof client.health !== 'function') {
    throw new Error('ML client must have a health() method');
  }
  return true;
}

async function runMlServicePreflight(context, options = {}) {
  const started = performance.now();
  const codes = [];
  const notes = [];
  const ml = { configured: false };

  try {
    if (!options.mlClient) {
      return createPhaseResult(PHASE_INDEX, STATE.WARN, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes: ['ML_NOT_CONFIGURED'],
        notes: [
          'ML service client was not configured; ML health probe was not run.',
          'Run with an ML-backed CIST invocation for full ML service checks.',
        ],
        ml,
      });
    }

    assertMlClientShape(options.mlClient);
    ml.configured = true;

    let healthResponse;
    try {
      healthResponse = await options.mlClient.health();
    } catch (error) {
      codes.push('ML_HEALTH_FAILED');
      notes.push(`ML service health check failed: ${error.message}`);
      return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes,
        notes,
        ml,
      });
    }

    if (!healthResponse || typeof healthResponse !== 'object' || healthResponse.status !== 'healthy') {
      codes.push('ML_HEALTH_SCHEMA_INVALID');
      notes.push('ML service health response did not match expected schema { status: "healthy" }');
      return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes,
        notes,
        ml: {
          ...ml,
          response: healthResponse,
        },
      });
    }

    ml.status = healthResponse.status;
    ml.response = healthResponse;

    return createPhaseResult(PHASE_INDEX, STATE.PASS, {
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      codes,
      notes,
      ml,
    });
  } catch (error) {
    codes.push('CIST_UNEXPECTED_ERROR');
    notes.push(`ML service preflight failed: ${error.message}`);
    return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      codes,
      notes,
      ml,
    });
  }
}

module.exports = {
  PHASE_INDEX,
  runMlServicePreflight,
  assertMlClientShape,
};
