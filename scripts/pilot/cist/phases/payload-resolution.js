'use strict';

const { performance } = require('node:perf_hooks');
const fs = require('node:fs');

const { STATE, createPhaseResult } = require('../phases');

const PHASE_INDEX = 5;

function isValidPayload(payload) {
  return Boolean(
    payload &&
    typeof payload === 'object' &&
    typeof payload.campaignUid === 'string' &&
    payload.campaignUid.length > 0
  );
}

async function runPayloadResolution(context, options = {}) {
  const started = performance.now();
  const codes = [];
  const notes = [];
  const payload = { configured: false };

  try {
    if (!options.payloadSource) {
      return createPhaseResult(PHASE_INDEX, STATE.WARN, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes: ['PAYLOAD_NOT_CONFIGURED'],
        notes: [
          'No payload source was supplied; payload resolution was not performed.',
          'Provide a fixture path, IPFS URI, or async loader function for full payload checks.',
        ],
        payload,
      });
    }

    payload.configured = true;

    let loadedPayload;
    try {
      if (typeof options.payloadSource === 'function') {
        loadedPayload = await options.payloadSource();
      } else if (typeof options.payloadSource === 'string') {
        loadedPayload = JSON.parse(fs.readFileSync(options.payloadSource, 'utf8'));
      } else {
        throw new Error('payloadSource must be a function or file path string');
      }
    } catch (error) {
      codes.push('PAYLOAD_LOAD_FAILED');
      notes.push(`Failed to load payload: ${error.message}`);
      return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes,
        notes,
        payload,
      });
    }

    if (!isValidPayload(loadedPayload)) {
      codes.push('PAYLOAD_SCHEMA_INVALID');
      notes.push('Payload does not match expected schema (requires campaignUid)');
      return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes,
        notes,
        payload: {
          ...payload,
          loaded: loadedPayload,
        },
      });
    }

    payload.campaignUid = loadedPayload.campaignUid;
    payload.loaded = loadedPayload;

    return createPhaseResult(PHASE_INDEX, STATE.PASS, {
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      codes,
      notes,
      payload,
    });
  } catch (error) {
    codes.push('CIST_UNEXPECTED_ERROR');
    notes.push(`Payload resolution failed: ${error.message}`);
    return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      codes,
      notes,
      payload,
    });
  }
}

module.exports = {
  PHASE_INDEX,
  runPayloadResolution,
  isValidPayload,
};
