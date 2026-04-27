'use strict';

const { expect } = require('chai');
const {
  STATE,
  PHASES,
  PHASE_BY_INDEX,
  PHASE_BY_KEY,
  isValidState,
  validatePhaseResult,
  createPhaseResult
} = require('../phases');

describe('CIST phases', function () {
  it('locks down the 8-phase order', function () {
    expect(PHASES.map((phase) => phase.name)).to.deep.equal([
      'Config and redaction preflight',
      'Chain and contract binding',
      'Redis and queue',
      'ML service',
      'Payload resolution',
      'Worker decision',
      'P2P / signature aggregation',
      'Report and teardown integrity'
    ]);
  });

  it('indexes phases by index and key', function () {
    expect(PHASE_BY_INDEX[1].key).to.equal('config');
    expect(PHASE_BY_KEY.report.index).to.equal(8);
  });

  it('validates known states', function () {
    expect(isValidState(STATE.PASS)).to.equal(true);
    expect(isValidState('INCONCLUSIVE')).to.equal(false);
  });

  it('creates valid phase results', function () {
    const result = createPhaseResult(1, STATE.PASS, {
      durationMs: 12,
      codes: [],
      notes: ['ok'],
      extra: 'kept'
    });

    expect(result.name).to.equal('Config and redaction preflight');
    expect(result.durationMs).to.equal(12);
    expect(result.extra).to.equal('kept');
    expect(validatePhaseResult(result)).to.equal(true);
  });

  it('rejects invalid phase result input', function () {
    expect(() => createPhaseResult(99, STATE.PASS)).to.throw('Unknown phase index');
    expect(() => createPhaseResult(1, 'BAD')).to.throw('Unsupported phase state');
    expect(() => validatePhaseResult({ index: 1, key: 'config', name: 'Wrong', state: STATE.PASS, durationMs: 0, codes: [], notes: [] }))
      .to.throw('Phase name mismatch');
    expect(() => validatePhaseResult({ index: 1, key: 'config', name: PHASE_BY_INDEX[1].name, state: STATE.PASS, durationMs: -1, codes: [], notes: [] }))
      .to.throw('durationMs');
    expect(() => validatePhaseResult({ index: 1, key: 'config', name: PHASE_BY_INDEX[1].name, state: STATE.PASS, durationMs: 0, codes: 'x', notes: [] }))
      .to.throw('codes');
    expect(() => validatePhaseResult({ index: 1, key: 'config', name: PHASE_BY_INDEX[1].name, state: STATE.PASS, durationMs: 0, codes: [], notes: 'x' }))
      .to.throw('notes');
  });
});
