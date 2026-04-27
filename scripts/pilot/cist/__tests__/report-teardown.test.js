'use strict';

const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PHASE_INDEX,
  runReportTeardown,
} = require('../phases/report-teardown');

const { STATE, PHASE_BY_INDEX, validatePhaseResult } = require('../phases');

describe('CIST Phase 8: Report and teardown integrity', function () {
  let root;
  let runDir;

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cist-report-teardown-'));
    runDir = path.join(root, 'cist-run-12345678-123456-abcdef12');
    fs.mkdirSync(runDir, { recursive: true });
  });

  afterEach(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function makeContext(overrides = {}) {
    return {
      runId: 'cist-20260427-143012-a83f9c1e',
      runDir,
      mode: 'fixture',
      scenario: 'all-agree',
      ...overrides,
    };
  }

  it('declares PHASE_INDEX as 8 and aligns with the phases registry', function () {
    expect(PHASE_INDEX).to.equal(8);
    expect(PHASE_BY_INDEX[PHASE_INDEX].key).to.equal('report');
  });

  it('PASSes when run directory exists and is writable', async function () {
    const result = await runReportTeardown(makeContext());

    expect(result.state).to.equal(STATE.PASS);
    expect(result.codes).to.deep.equal([]);
    expect(result.notes).to.include(
      'Teardown verified report writability. Open-handle and force-close detection deferred to v1.2.'
    );
    expect(result.teardown).to.deep.equal({ reportWillWrite: true });
    expect(validatePhaseResult(result)).to.equal(true);
  });

  it('FAILs with REPORT_WRITE_FAILED when run directory is missing', async function () {
    const missingContext = makeContext({ runDir: path.join(root, 'nonexistent') });

    const result = await runReportTeardown(missingContext);

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('REPORT_WRITE_FAILED');
    expect(result.notes.join(' ')).to.include('Run directory is missing');
    expect(validatePhaseResult(result)).to.equal(true);
  });

  it('stores only serializable primitives', async function () {
    const result = await runReportTeardown(makeContext());

    expect(() => JSON.stringify(result)).to.not.throw();
    expect(result).to.not.have.property('fs');
    expect(result.teardown).to.deep.equal({ reportWillWrite: true });
  });
});
