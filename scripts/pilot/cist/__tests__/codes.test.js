'use strict';

const { expect } = require('chai');
const { CODES, SEVERITY, getCode, requireCode, listCodes } = require('../codes');

describe('CIST codes registry', function () {
  it('keeps object keys aligned with entry.code', function () {
    for (const [key, entry] of Object.entries(CODES)) {
      expect(entry.code).to.equal(key);
    }
  });

  it('uses only valid severities and numeric phases', function () {
    const severities = new Set(Object.values(SEVERITY));
    for (const entry of listCodes()) {
      expect(severities.has(entry.severity)).to.equal(true);
      expect(entry.phase).to.be.a('number');
    }
  });

  it('has unique code values', function () {
    const values = listCodes().map((entry) => entry.code);
    expect(new Set(values).size).to.equal(values.length);
  });

  it('returns entries through getCode', function () {
    expect(getCode('CONFIG_ENV_MISSING')).to.equal(CODES.CONFIG_ENV_MISSING);
    expect(getCode('NO_SUCH_CODE')).to.equal(null);
  });

  it('throws for unknown required codes', function () {
    expect(requireCode('REDIS_UNREACHABLE')).to.equal(CODES.REDIS_UNREACHABLE);
    expect(() => requireCode('NO_SUCH_CODE')).to.throw('Unknown CIST code');
  });
});
