'use strict';

const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  formatUtcTimestamp,
  shortUuid,
  createRunId,
  createRunContext
} = require('../run-id');

describe('CIST run-id', function () {
  it('formats timestamps in UTC', function () {
    const date = new Date('2026-04-27T01:02:03.000Z');
    expect(formatUtcTimestamp(date)).to.equal('20260427-010203');
  });

  it('uses UTC rather than local offset interpretation', function () {
    const date = new Date('2026-04-27T03:02:03+02:00');
    expect(formatUtcTimestamp(date)).to.equal('20260427-010203');
  });

  it('extracts an 8-character UUID suffix', function () {
    expect(shortUuid('12345678-90ab-cdef-1234-567890abcdef')).to.equal('12345678');
  });

  it('creates a run id with the expected shape', function () {
    expect(createRunId(new Date('2026-04-27T01:02:03Z'))).to.match(/^cist-20260427-010203-[a-f0-9]{8}$/);
  });

  it('creates unique run contexts and directories', function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cist-run-id-'));
    try {
      const first = createRunContext({ baseDir: root });
      const second = createRunContext({ baseDir: root });

      expect(first.runId).to.match(/^cist-\d{8}-\d{6}-[a-f0-9]{8}$/);
      expect(path.isAbsolute(first.runDir)).to.equal(true);
      expect(fs.existsSync(first.runDir)).to.equal(true);
      expect(first.runId).to.not.equal(second.runId);
      expect(first.runDir).to.not.equal(second.runDir);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
