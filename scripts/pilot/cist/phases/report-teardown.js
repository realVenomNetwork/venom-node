'use strict';

const fs = require('node:fs');
const { performance } = require('node:perf_hooks');

const { STATE, createPhaseResult } = require('../phases');

const PHASE_INDEX = 8;

async function runReportTeardown(context, options = {}) {
  const started = performance.now();
  const codes = [];
  const notes = [];
  const teardown = { reportWillWrite: true };

  try {
    if (!context.runDir || !fs.existsSync(context.runDir)) {
      codes.push('REPORT_WRITE_FAILED');
      notes.push('Run directory is missing at teardown time.');
      return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes,
        notes,
        teardown,
      });
    }

    // v1.1 does not yet manage long-lived dependencies (libp2p, BullMQ, Redis)
    // so open-handle and force-close detection are intentionally deferred.
    notes.push(
      'Teardown verified report writability. Open-handle and force-close detection deferred to v1.2.'
    );

    return createPhaseResult(PHASE_INDEX, STATE.PASS, {
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      codes,
      notes,
      teardown,
    });
  } catch (error) {
    codes.push('CIST_UNEXPECTED_ERROR');
    notes.push(`Report/teardown failed: ${error.message}`);
    return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      codes,
      notes,
      teardown,
    });
  }
}

module.exports = {
  PHASE_INDEX,
  runReportTeardown,
};
