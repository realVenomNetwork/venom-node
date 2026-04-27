'use strict';

const { expect } = require('chai');

const {
  PHASE_INDEX,
  DEFAULT_WORKER_DECISION_TIMEOUT_MS,
  assertWorkerShape,
  normalizeWorkerDecision,
  runWorkerDecision,
} = require('../phases/worker-decision');

const { STATE, PHASE_BY_INDEX, validatePhaseResult } = require('../phases');

describe('CIST Phase 6: Worker decision', function () {
  function makeContext(overrides = {}) {
    return {
      runId: 'cist-20260427-143012-a83f9c1e',
      runDir: '/tmp/test-run',
      mode: 'fixture',
      scenario: 'all-agree',
      ...overrides,
    };
  }

  function makeJob(overrides = {}) {
    return {
      id: 'job-1',
      payload: {
        campaignUid: 'campaign-abc123',
        title: 'Test Campaign',
        budget: 1000,
      },
      ...overrides,
    };
  }

  function makeWorker(decision = {
    campaignUid: 'campaign-abc123',
    decision: 'approve',
    score: 0.92,
    reason: 'fixture decision',
  }) {
    return {
      process: async () => decision,
    };
  }

  it('declares PHASE_INDEX as 6 and aligns with the phases registry', function () {
    expect(PHASE_INDEX).to.equal(6);
    expect(PHASE_BY_INDEX[PHASE_INDEX].key).to.equal('worker');
  });

  it('declares the default timeout as 10000ms', function () {
    expect(DEFAULT_WORKER_DECISION_TIMEOUT_MS).to.equal(10000);
  });

  it('assertWorkerShape accepts worker with process()', function () {
    expect(assertWorkerShape(makeWorker())).to.equal(true);
  });

  it('assertWorkerShape rejects missing process()', function () {
    expect(() => assertWorkerShape(null)).to.throw('Worker must have a process() method');
    expect(() => assertWorkerShape({})).to.throw('Worker must have a process() method');
  });

  it('normalizeWorkerDecision accepts valid decisions including abstain', function () {
    for (const decisionType of ['approve', 'reject', 'abstain']) {
      const result = normalizeWorkerDecision({
        campaignUid: 'campaign-abc123',
        decision: decisionType,
        score: 0.5,
        reason: 'ok',
      });
      expect(result.decision).to.equal(decisionType);
    }
  });

  it('normalizeWorkerDecision rejects invalid decision output', function () {
    expect(() => normalizeWorkerDecision(null)).to.throw('Worker decision is invalid');
    expect(() => normalizeWorkerDecision({ decision: 'maybe', score: 0.5, reason: 'x' }))
      .to.throw('Worker decision is invalid');
    expect(() => normalizeWorkerDecision({ decision: 'approve', score: 2, reason: 'x' }))
      .to.throw('Worker decision is invalid');
    expect(() => normalizeWorkerDecision({ decision: 'approve', score: 0.5, reason: '' }))
      .to.throw('Worker decision is invalid');
    expect(() => normalizeWorkerDecision({ decision: 'approve', score: 0.5, reason: 'ok' }))
      .to.throw('Worker decision is invalid');
  });

  it('WARNs with WORKER_NOT_CONFIGURED when no worker is supplied', async function () {
    const result = await runWorkerDecision(makeContext(), {
      job: makeJob(),
    });

    expect(result.state).to.equal(STATE.WARN);
    expect(result.codes).to.deep.equal(['WORKER_NOT_CONFIGURED']);
    expect(result.worker).to.deep.equal({ configured: false });
    expect(validatePhaseResult(result)).to.equal(true);
  });

  it('WARNs with WORKER_NO_PAYLOAD when job is missing', async function () {
    const result = await runWorkerDecision(makeContext(), {
      worker: makeWorker(),
    });

    expect(result.state).to.equal(STATE.WARN);
    expect(result.codes).to.deep.equal(['WORKER_NO_PAYLOAD']);
    expect(result.notes).to.deep.equal([
      'No job was available; worker decision probe was not run.',
      'Provide a payload via Phase 5 success before running worker decision.',
    ]);
    expect(validatePhaseResult(result)).to.equal(true);
  });

  it('FAILs with WORKER_DECISION_INVALID when job payload is malformed', async function () {
    const result = await runWorkerDecision(makeContext(), {
      worker: makeWorker(),
      job: { id: 'job-1', payload: null },
    });

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('WORKER_DECISION_INVALID');
    expect(validatePhaseResult(result)).to.equal(true);
  });

  it('FAILs with WORKER_THREW when worker throws', async function () {
    const worker = {
      process: async () => { throw new Error('worker exploded'); },
    };
    const result = await runWorkerDecision(makeContext(), {
      worker,
      job: makeJob(),
    });

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('WORKER_THREW');
    expect(result.notes.join(' ')).to.match(/worker exploded/i);
    expect(validatePhaseResult(result)).to.equal(true);
  });

  it('FAILs with WORKER_DECISION_TIMEOUT when worker exceeds timeout', async function () {
    const worker = {
      process: async () => new Promise(() => {}),
    };
    const result = await runWorkerDecision(makeContext(), {
      worker,
      job: makeJob(),
      timeoutMs: 1,
    });

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('WORKER_DECISION_TIMEOUT');
    expect(result.notes.join(' ')).to.include('1ms');
    expect(validatePhaseResult(result)).to.equal(true);
  });

  it('FAILs with WORKER_DECISION_INVALID when worker returns malformed decision', async function () {
    const worker = {
      process: async () => ({ decision: 'maybe', score: 0.5, reason: 'bad' }),
    };
    const result = await runWorkerDecision(makeContext(), {
      worker,
      job: makeJob(),
    });

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('WORKER_DECISION_INVALID');
    expect(validatePhaseResult(result)).to.equal(true);
  });

  it('FAILs with WORKER_DECISION_INVALID when campaignUid does not match', async function () {
    const worker = {
      process: async () => ({
        campaignUid: 'wrong-campaign',
        decision: 'approve',
        score: 0.9,
        reason: 'mismatch',
      }),
    };
    const result = await runWorkerDecision(makeContext(), {
      worker,
      job: makeJob(),
    });

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('WORKER_DECISION_INVALID');
    expect(validatePhaseResult(result)).to.equal(true);
  });

  it('PASSes with a valid worker decision', async function () {
    const result = await runWorkerDecision(makeContext(), {
      worker: makeWorker(),
      job: makeJob(),
    });

    expect(result.state).to.equal(STATE.PASS);
    expect(result.codes).to.deep.equal([]);
    expect(result.worker).to.deep.include({
      configured: true,
      campaignUid: 'campaign-abc123',
      decision: 'approve',
      score: 0.92,
      reason: 'fixture decision',
    });
    expect(validatePhaseResult(result)).to.equal(true);
  });

  it('stores only serializable primitives in result metadata', async function () {
    const result = await runWorkerDecision(makeContext(), {
      worker: makeWorker(),
      job: makeJob(),
    });

    expect(() => JSON.stringify(result)).to.not.throw();
    expect(result.worker).to.deep.include({
      configured: true,
      campaignUid: 'campaign-abc123',
      decision: 'approve',
    });
    expect(JSON.stringify(result)).to.not.include('function');
  });
});
