'use strict';

const { expect } = require('chai');

const {
  REDACTION_TIMEOUT_MS,
  REASON,
  PATTERNS,
  scanContentForSecrets,
  assertContentIsSafe,
  scanForSecrets,
  assertNoSecrets,
  maskSample
} = require('../redaction');

describe('CIST redaction scanner (v1.1)', function () {
  const privateKey = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const mnemonic12 = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  const mnemonic24 = 'abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual';
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const awsKey = 'AKIAIOSFODNN7EXAMPLE';
  const bearer = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdef123456';

  it('exports constants and backward-compatible aliases', function () {
    expect(REDACTION_TIMEOUT_MS).to.equal(5000);
    expect(REASON).to.deep.equal({
      MATCH_FOUND: 'match_found',
      SCAN_TIMEOUT: 'scan_timeout',
      SCANNER_ERROR: 'scanner_error'
    });
    expect(scanForSecrets).to.equal(scanContentForSecrets);
    expect(assertNoSecrets).to.equal(assertContentIsSafe);
  });

  it('detects 0x-prefixed 64-hex private-key-shaped content', function () {
    const result = scanContentForSecrets(`key: ${privateKey}`);

    expect(result.safe).to.equal(false);
    expect(result.reason).to.equal(REASON.MATCH_FOUND);
    expect(result.matches).to.have.length(1);
    expect(result.matches[0].patternId).to.equal('hex_private_key_64');
    expect(result.matches[0].label).to.equal('0x-prefixed 32-byte hex string');
    expect(result.matches[0].sample).to.equal('0x0123…cdef');
  });

  it('detects 12-word and 24-word mnemonic-shaped phrases', function () {
    const result12 = scanContentForSecrets(mnemonic12);
    expect(result12.safe).to.equal(false);
    expect(result12.matches[0].patternId).to.equal('bip39_mnemonic_12');

    const result24 = scanContentForSecrets(mnemonic24);
    expect(result24.safe).to.equal(false);
    expect(result24.matches[0].patternId).to.equal('bip39_mnemonic_24');
  });

  it('detects JWT compact token', function () {
    const result = scanContentForSecrets(jwt);

    expect(result.safe).to.equal(false);
    expect(result.matches[0].patternId).to.equal('jwt_compact');
  });

  it('detects AWS Access Key ID', function () {
    const result = scanContentForSecrets(awsKey);

    expect(result.safe).to.equal(false);
    expect(result.matches[0].patternId).to.equal('aws_access_key_id');
  });

  it('detects Bearer authorization header', function () {
    const result = scanContentForSecrets(bearer);

    expect(result.safe).to.equal(false);
    expect(result.matches[0].patternId).to.equal('bearer_authorization_header');
  });

  it('keeps high_entropy_string disabled by default', function () {
    const highEntropy = 'N0pQ7rT9vW2xY4zA6bC8dE1fG3hJ5kL7mN9pQ2rT4vW6xY8zA';
    const result = scanContentForSecrets(highEntropy);

    expect(result.safe).to.equal(true);
  });

  it('can enable high_entropy_string via option', function () {
    const highEntropy = 'N0pQ7rT9vW2xY4zA6bC8dE1fG3hJ5kL7mN9pQ2rT4vW6xY8zA';
    const result = scanContentForSecrets(highEntropy, { enableHighEntropy: true });

    expect(result.safe).to.equal(false);
    expect(result.matches[0].patternId).to.equal('high_entropy_string');
  });

  it('includes source and index metadata in matches', function () {
    const result = scanContentForSecrets(`value=${privateKey}`, { source: 'report.json' });

    expect(result.matches[0].source).to.equal('report.json');
    expect(result.matches[0].index).to.equal('value='.length);
  });

  it('assertContentIsSafe throws a structured redaction error on match', function () {
    expect(() => assertContentIsSafe(privateKey))
      .to.throw('REPORT_REDACTION_FAILED')
      .with.property('code', 'REPORT_REDACTION_FAILED');

    try {
      assertContentIsSafe(privateKey);
      throw new Error('expected assertContentIsSafe to throw');
    } catch (error) {
      expect(error.redaction).to.deep.include({
        blocked: true,
        reason: REASON.MATCH_FOUND
      });
      expect(error.redaction.matches[0].patternId).to.equal('hex_private_key_64');
    }
  });

  it('assertContentIsSafe returns true for safe content', function () {
    expect(assertContentIsSafe('ordinary CIST output')).to.equal(true);
  });

  it('returns scan_timeout when timeout budget is already exhausted', function () {
    const result = scanContentForSecrets(`safe prefix ${privateKey}`, { timeoutMs: 0 });

    expect(result.safe).to.equal(false);
    expect(result.reason).to.equal(REASON.SCAN_TIMEOUT);
  });

  it('maskSample masks long values and fully redacts short values', function () {
    expect(maskSample(privateKey)).to.equal('0x0123…cdef');
    expect(maskSample('short')).to.equal('[REDACTED]');
  });

  it('defines the full v1.1 pattern set', function () {
    expect(PATTERNS.map((pattern) => pattern.patternId)).to.deep.equal([
      'hex_private_key_64',
      'bip39_mnemonic_12',
      'bip39_mnemonic_24',
      'jwt_compact',
      'aws_access_key_id',
      'bearer_authorization_header',
      'high_entropy_string'
    ]);

    for (const pattern of PATTERNS) {
      expect(pattern.patternId).to.be.a('string').and.not.equal('');
      expect(pattern.label).to.be.a('string').and.not.equal('');
      expect(pattern.description).to.be.a('string').and.not.equal('');
      expect(pattern.severity).to.equal('block');
      expect(pattern.regex).to.be.instanceOf(RegExp);
    }
  });
});
