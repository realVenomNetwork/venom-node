'use strict';

const { performance } = require('node:perf_hooks');

const { STATE, createPhaseResult } = require('../phases');

const PHASE_INDEX = 6;
const DEFAULT_WORKER_DECISION_TIMEOUT_MS = 10000;

function assertWorkerShape(worker) {
  if (!worker || typeof worker.process !== 'function') {
    throw new Error('Worker must have a process() method');
  }
  return true;
}

function normalizeWorkerDecision(decision) {
  if (!decision || typeof decision !== 'object') {
    throw new Error('Worker decision is invalid');
  }

  const { campaignUid, decision: decisionType, score, reason } = decision;

  if (!['approve', 'reject', 'abstain'].includes(decisionType)) {
    throw new Error('Worker decision is invalid');
  }
  if (typeof score !== 'number' || score < 0 || score > 1) {
    throw new Error('Worker decision is invalid');
  }
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new Error('Worker decision is invalid');
  }
  if (typeof campaignUid !== 'string' || campaignUid.length === 0) {
    throw new Error('Worker decision is invalid');
  }

  return { campaignUid, decision: decisionType, score, reason };
}

async function runWorkerDecision(context, options = {}) {
  const started = performance.now();
  const codes = [];
  const notes = [];
  const workerResult = { configured: false };

  try {
    if (!options.worker) {
      return createPhaseResult(PHASE_INDEX, STATE.WARN, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes: ['WORKER_NOT_CONFIGURED'],
        notes: [
          'No worker was configured; worker decision probe was not run.',
          'Provide a worker with a process() method for full decision checks.',
        ],
        worker: workerResult,
      });
    }

    assertWorkerShape(options.worker);
    workerResult.configured = true;

    if (!options.job) {
      codes.push('WORKER_NO_PAYLOAD');
      notes.push('No job was available; worker decision probe was not run.');
      notes.push('Provide a payload via Phase 5 success before running worker decision.');
      return createPhaseResult(PHASE_INDEX, STATE.WARN, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes,
        notes,
        worker: workerResult,
      });
    }

    if (
      !options.job ||
      typeof options.job !== 'object' ||
      typeof options.job.id !== 'string' ||
      options.job.id.length === 0 ||
      !options.job.payload ||
      typeof options.job.payload !== 'object'
    ) {
      codes.push('WORKER_DECISION_INVALID');
      notes.push('Worker job must include id and payload');
      return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes,
        notes,
        worker: workerResult,
      });
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_WORKER_DECISION_TIMEOUT_MS;
    let timeoutHandle;
    const decisionPromise = options.worker.process(options.job);
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      if (typeof timeoutHandle.unref === 'function') {
        timeoutHandle.unref();
      }
    });

    let rawDecision;
    try {
      rawDecision = await Promise.race([decisionPromise, timeoutPromise]);
    } catch (error) {
      if (error.message === 'timeout') {
        codes.push('WORKER_DECISION_TIMEOUT');
        notes.push(`Worker decision did not complete within ${timeoutMs}ms`);
      } else {
        codes.push('WORKER_THREW');
        notes.push(`Worker threw: ${error.message}`);
      }
      return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes,
        notes,
        worker: workerResult,
      });
    } finally {
      clearTimeout(timeoutHandle);
    }

    let normalized;
    try {
      normalized = normalizeWorkerDecision(rawDecision);
    } catch {
      codes.push('WORKER_DECISION_INVALID');
      notes.push('Worker returned malformed decision');
      return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes,
        notes,
        worker: workerResult,
      });
    }

    if (normalized.campaignUid !== options.job.payload.campaignUid) {
      codes.push('WORKER_DECISION_INVALID');
      notes.push('Worker decision campaignUid does not match job payload');
      return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes,
        notes,
        worker: workerResult,
      });
    }

    workerResult.decision = normalized.decision;
    workerResult.score = normalized.score;
    workerResult.reason = normalized.reason;
    workerResult.campaignUid = normalized.campaignUid;

    return createPhaseResult(PHASE_INDEX, STATE.PASS, {
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      codes,
      notes,
      worker: workerResult,
    });
  } catch (error) {
    codes.push('CIST_UNEXPECTED_ERROR');
    notes.push(`Worker decision failed: ${error.message}`);
    return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      codes,
      notes,
      worker: workerResult,
    });
  }
}

module.exports = {
  PHASE_INDEX,
  DEFAULT_WORKER_DECISION_TIMEOUT_MS,
  assertWorkerShape,
  normalizeWorkerDecision,
  runWorkerDecision,
};
