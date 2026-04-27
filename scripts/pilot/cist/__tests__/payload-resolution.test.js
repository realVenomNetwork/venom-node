'use strict';

const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PHASE_INDEX,
  runPayloadResolution,
  isValidPayload,
} = require('../phases/payload-resolution');

const { STATE, PHASE_BY_INDEX, validatePhaseResult } = require('../phases');

describe('CIST Phase 5: Payload resolution', function () {
  function makeContext(overrides = {}) {
    return {
      runId: 'cist-20260427-143012-a83f9c1e',
      runDir: '/tmp/test-run',
      mode: 'fixture',
      scenario: 'all-agree',
      ...overrides,
    };
  }

  function makeValidPayload() {
    return {
      campaignUid: 'campaign-abc123',
      title: 'Test Campaign',
      budget: 1000,
    };
  }

  function makeInvalidPayload() {
    return { title: 'Missing campaignUid' };
  }

  it('declares PHASE_INDEX as 5 and aligns with the phases registry', function () {
    expect(PHASE_INDEX).to.equal(5);
    expect(PHASE_BY_INDEX[PHASE_INDEX].key).to.equal('payload');
  });

  it('isValidPayload returns true for valid payload', function () {
    expect(isValidPayload(makeValidPayload())).to.equal(true);
  });

  it('isValidPayload returns false for invalid payload', function () {
    expect(isValidPayload(makeInvalidPayload())).to.equal(false);
    expect(isValidPayload(null)).to.equal(false);
    expect(isValidPayload({})).to.equal(false);
  });

  it('WARNs with PAYLOAD_NOT_CONFIGURED when no payloadSource is supplied', async function () {
    const result = await runPayloadResolution(makeContext(), {});

    expect(result.state).to.equal(STATE.WARN);
    expect(result.codes).to.deep.equal(['PAYLOAD_NOT_CONFIGURED']);
    expect(result.payload).to.deep.equal({ configured: false });
    expect(validatePhaseResult(result)).to.equal(true);
  });

  it('FAILs with PAYLOAD_LOAD_FAILED when payloadSource function throws', async function () {
    const result = await runPayloadResolution(makeContext(), {
      payloadSource: async () => { throw new Error('network error'); },
    });

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('PAYLOAD_LOAD_FAILED');
    expect(result.notes.join(' ')).to.match(/network error/i);
    expect(validatePhaseResult(result)).to.equal(true);
  });

  it('FAILs with PAYLOAD_LOAD_FAILED when payload file does not exist', async function () {
    const result = await runPayloadResolution(makeContext(), {
      payloadSource: '/nonexistent/path/payload.json',
    });

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('PAYLOAD_LOAD_FAILED');
    expect(validatePhaseResult(result)).to.equal(true);
  });

  it('FAILs with PAYLOAD_SCHEMA_INVALID when loaded payload is invalid', async function () {
    const result = await runPayloadResolution(makeContext(), {
      payloadSource: async () => makeInvalidPayload(),
    });

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('PAYLOAD_SCHEMA_INVALID');
    expect(result.payload.loaded).to.deep.equal(makeInvalidPayload());
    expect(validatePhaseResult(result)).to.equal(true);
  });

  it('PASSes with valid payload from function', async function () {
    const valid = makeValidPayload();

    const result = await runPayloadResolution(makeContext(), {
      payloadSource: async () => valid,
    });

    expect(result.state).to.equal(STATE.PASS);
    expect(result.codes).to.deep.equal([]);
    expect(result.payload).to.deep.include({
      configured: true,
      campaignUid: 'campaign-abc123',
    });
    expect(result.payload.loaded).to.deep.equal(valid);
    expect(validatePhaseResult(result)).to.equal(true);
  });

  it('PASSes with valid payload from file path (fixture)', async function () {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cist-payload-'));
    const payloadPath = path.join(tmpDir, 'payload.json');
    const valid = makeValidPayload();
    fs.writeFileSync(payloadPath, JSON.stringify(valid), 'utf8');

    try {
      const result = await runPayloadResolution(makeContext(), {
        payloadSource: payloadPath,
      });

      expect(result.state).to.equal(STATE.PASS);
      expect(result.payload.campaignUid).to.equal('campaign-abc123');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('stores only serializable primitives in result metadata', async function () {
    const result = await runPayloadResolution(makeContext(), {
      payloadSource: async () => makeValidPayload(),
    });

    expect(() => JSON.stringify(result)).to.not.throw();
    expect(result).to.not.have.property('payloadSource');
  });
});
