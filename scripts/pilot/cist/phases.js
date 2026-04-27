'use strict';

const STATE = Object.freeze({
  PASS: 'PASS',
  WARN: 'WARN',
  FAIL: 'FAIL',
  SKIP: 'SKIP'
});

const PHASES = Object.freeze([
  { index: 1, key: 'config', name: 'Config and redaction preflight' },
  { index: 2, key: 'chain', name: 'Chain and contract binding' },
  { index: 3, key: 'redis', name: 'Redis and queue' },
  { index: 4, key: 'ml', name: 'ML service' },
  { index: 5, key: 'payload', name: 'Payload resolution' },
  { index: 6, key: 'worker', name: 'Worker decision' },
  { index: 7, key: 'p2p', name: 'P2P / signature aggregation' },
  { index: 8, key: 'report', name: 'Report and teardown integrity' }
]);

const PHASE_BY_INDEX = Object.freeze(Object.fromEntries(PHASES.map((phase) => [phase.index, phase])));
const PHASE_BY_KEY = Object.freeze(Object.fromEntries(PHASES.map((phase) => [phase.key, phase])));

function isValidState(state) {
  return Object.values(STATE).includes(state);
}

function validatePhaseResult(result) {
  if (!result || typeof result !== 'object') {
    throw new Error('Phase result must be an object');
  }

  const phase = PHASE_BY_INDEX[result.index];
  if (!phase) {
    throw new Error(`Unknown phase index: ${result.index}`);
  }
  if (result.key !== undefined && result.key !== phase.key) {
    throw new Error(`Phase key mismatch for phase ${result.index}`);
  }
  if (result.name !== phase.name) {
    throw new Error(`Phase name mismatch for phase ${result.index}`);
  }
  if (!isValidState(result.state)) {
    throw new Error(`Unsupported phase state: ${result.state}`);
  }
  if (!Number.isFinite(result.durationMs) || result.durationMs < 0) {
    throw new Error('Phase durationMs must be a non-negative finite number');
  }
  if (!Array.isArray(result.codes)) {
    throw new Error('Phase codes must be an array');
  }
  if (!Array.isArray(result.notes)) {
    throw new Error('Phase notes must be an array');
  }

  return true;
}

function createPhaseResult(index, state, overrides = {}) {
  const phase = PHASE_BY_INDEX[index];
  if (!phase) {
    throw new Error(`Unknown phase index: ${index}`);
  }

  const result = {
    index: phase.index,
    key: phase.key,
    name: phase.name,
    state,
    durationMs: overrides.durationMs ?? 0,
    codes: overrides.codes ?? [],
    notes: overrides.notes ?? []
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in result)) {
      result[key] = value;
    }
  }

  validatePhaseResult(result);
  return result;
}

module.exports = {
  STATE,
  PHASES,
  PHASE_BY_INDEX,
  PHASE_BY_KEY,
  isValidState,
  validatePhaseResult,
  createPhaseResult
};
