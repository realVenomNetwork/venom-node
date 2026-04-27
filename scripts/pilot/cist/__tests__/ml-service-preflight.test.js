'use strict';

const { expect } = require('chai');

const {
  PHASE_INDEX,
  assertMlClientShape,
  runMlServicePreflight,
} = require('../phases/ml-service-preflight');

const { STATE, PHASE_BY_INDEX, validatePhaseResult } = require('../phases');

describe('CIST Phase 4: ML service', function () {
  function makeContext(overrides = {}) {
    return {
      runId: 'cist-20260427-143012-a83f9c1e',
      runDir: '/tmp/test-run',
      mode: 'fixture',
      scenario: 'all-agree',
      ...overrides,
    };
  }

  function makeMlClient({ healthResponse = { status: 'healthy' } } = {}) {
    return {
      health: async () => healthResponse,
    };
  }

  function makeFailingMlClient() {
    return {
      health: async () => { throw new Error('service unavailable'); },
    };
  }

  function makeSchemaInvalidCases() {
    return [
      {
        label: 'missing status field',
        response: { ok: true },
      },
      {
        label: 'unhealthy status',
        response: { status: 'degraded' },
      },
      {
        label: 'non-object response',
        response: null,
      },
    ];
  }

  it('declares PHASE_INDEX as 4 and aligns with the phases registry', function () {
    expect(PHASE_INDEX).to.equal(4);
    expect(PHASE_BY_INDEX[PHASE_INDEX].key).to.equal('ml');
  });

  it('assertMlClientShape requires a health() method', function () {
    expect(assertMlClientShape(makeMlClient())).to.equal(true);
    expect(() => assertMlClientShape(null)).to.throw('ML client must have a health() method');
    expect(() => assertMlClientShape({})).to.throw('ML client must have a health() method');
  });

  it('WARNs with ML_NOT_CONFIGURED when no ML client is supplied', async function () {
    const result = await runMlServicePreflight(makeContext(), {});

    expect(result.state).to.equal(STATE.WARN);
    expect(result.codes).to.deep.equal(['ML_NOT_CONFIGURED']);
    expect(result.ml).to.deep.equal({ configured: false });
    expect(validatePhaseResult(result)).to.equal(true);
  });

  it('FAILs with ML_HEALTH_FAILED when health throws', async function () {
    const result = await runMlServicePreflight(makeContext(), {
      mlClient: makeFailingMlClient(),
    });

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('ML_HEALTH_FAILED');
    expect(result.notes.join(' ')).to.match(/service unavailable|health/i);
    expect(validatePhaseResult(result)).to.equal(true);
  });

  for (const { label, response } of makeSchemaInvalidCases()) {
    it(`FAILs with ML_HEALTH_SCHEMA_INVALID when ${label}`, async function () {
      const result = await runMlServicePreflight(makeContext(), {
        mlClient: makeMlClient({ healthResponse: response }),
      });

      expect(result.state).to.equal(STATE.FAIL);
      expect(result.codes).to.include('ML_HEALTH_SCHEMA_INVALID');
      expect(result.ml.response).to.deep.equal(response);
      expect(validatePhaseResult(result)).to.equal(true);
    });
  }

  it('PASSes when health returns the expected minimal schema', async function () {
    const result = await runMlServicePreflight(makeContext(), {
      mlClient: makeMlClient(),
    });

    expect(result.state).to.equal(STATE.PASS);
    expect(result.codes).to.deep.equal([]);
    expect(result.ml).to.deep.include({
      configured: true,
      status: 'healthy',
    });
    expect(result.ml.response).to.deep.equal({ status: 'healthy' });
    expect(validatePhaseResult(result)).to.equal(true);
  });

  it('stores only serializable primitives in result metadata', async function () {
    const result = await runMlServicePreflight(makeContext(), {
      mlClient: makeMlClient(),
    });

    expect(() => JSON.stringify(result)).to.not.throw();
    expect(result).to.not.have.property('mlClient');
  });
});
