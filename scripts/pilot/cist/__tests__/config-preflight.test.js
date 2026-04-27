'use strict';

const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PHASE_INDEX,
  REQUIRED_ENV_BY_MODE,
  runConfigPreflight,
  findMissingRequiredEnv,
  runRedactionSelfTest,
  verifyRunDirectoryWritable,
} = require('../phases/config-preflight');

const { STATE, PHASE_BY_INDEX, validatePhaseResult } = require('../phases');

describe('CIST config-preflight phase (phase 1)', function () {
  let root;
  let runDir;

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cist-config-preflight-'));
    runDir = path.join(root, 'run');
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

  describe('module surface', function () {
    it('declares PHASE_INDEX as 1 and aligns with the phases registry', function () {
      expect(PHASE_INDEX).to.equal(1);
      expect(PHASE_BY_INDEX[PHASE_INDEX].key).to.equal('config');
    });

    it('declares fixture mode as having no required env vars', function () {
      expect(REQUIRED_ENV_BY_MODE.fixture).to.deep.equal([]);
    });

    it('declares the live-testnet required env set', function () {
      expect(REQUIRED_ENV_BY_MODE['live-testnet']).to.deep.equal([
        'RPC_URL',
        'OPERATOR_PRIVATE_KEY',
        'PILOT_ESCROW_ADDRESS',
        'VENOM_REGISTRY_ADDRESS',
      ]);
    });

    it('freezes REQUIRED_ENV_BY_MODE so phase code cannot mutate it at runtime', function () {
      expect(Object.isFrozen(REQUIRED_ENV_BY_MODE)).to.equal(true);
    });
  });

  describe('findMissingRequiredEnv', function () {
    it('returns no missing vars for fixture mode regardless of env', function () {
      expect(findMissingRequiredEnv('fixture', {})).to.deep.equal([]);
      expect(findMissingRequiredEnv('fixture', { RPC_URL: 'http://x' })).to.deep.equal([]);
    });

    it('returns all required vars for live-testnet with empty env', function () {
      expect(findMissingRequiredEnv('live-testnet', {})).to.deep.equal([
        'RPC_URL',
        'OPERATOR_PRIVATE_KEY',
        'PILOT_ESCROW_ADDRESS',
        'VENOM_REGISTRY_ADDRESS',
      ]);
    });

    it('returns only the subset that is missing', function () {
      const missing = findMissingRequiredEnv('live-testnet', {
        RPC_URL: 'http://x',
        PILOT_ESCROW_ADDRESS: '0x0000000000000000000000000000000000000001',
      });
      expect(missing).to.deep.equal([
        'OPERATOR_PRIVATE_KEY',
        'VENOM_REGISTRY_ADDRESS',
      ]);
    });

    it('returns no missing vars for live-testnet when all are set', function () {
      const missing = findMissingRequiredEnv('live-testnet', {
        RPC_URL: 'http://x',
        OPERATOR_PRIVATE_KEY: '0xabc',
        PILOT_ESCROW_ADDRESS: '0x0000000000000000000000000000000000000001',
        VENOM_REGISTRY_ADDRESS: '0x0000000000000000000000000000000000000002',
      });
      expect(missing).to.deep.equal([]);
    });

    it('treats unknown modes as having no required env', function () {
      expect(findMissingRequiredEnv('unknown-mode', {})).to.deep.equal([]);
    });

    it('treats empty-string env values as missing', function () {
      const missing = findMissingRequiredEnv('live-testnet', {
        RPC_URL: '',
        OPERATOR_PRIVATE_KEY: '0xabc',
        PILOT_ESCROW_ADDRESS: '0x0000000000000000000000000000000000000001',
        VENOM_REGISTRY_ADDRESS: '0x0000000000000000000000000000000000000002',
      });
      expect(missing).to.include('RPC_URL');
    });
  });

  describe('runRedactionSelfTest', function () {
    // Negative paths require mocking the redaction module; covered indirectly by
    // the redaction module's own test suite. This suite only verifies the
    // success path so the phase wiring stays honest.
    it('returns ok when the scanner detects synthetic secrets and lets safe content through', function () {
      const result = runRedactionSelfTest();
      expect(result.ok).to.equal(true);
      expect(result.note).to.equal(undefined);
    });
  });

  describe('verifyRunDirectoryWritable', function () {
    it('rejects null, empty, and undefined paths', function () {
      expect(verifyRunDirectoryWritable(null).ok).to.equal(false);
      expect(verifyRunDirectoryWritable('').ok).to.equal(false);
      expect(verifyRunDirectoryWritable(undefined).ok).to.equal(false);
    });

    it('rejects non-string input', function () {
      expect(verifyRunDirectoryWritable(42).ok).to.equal(false);
    });

    it('accepts a writable directory and leaves no probe artifacts behind', function () {
      const before = fs.readdirSync(runDir);
      const result = verifyRunDirectoryWritable(runDir);
      expect(result.ok).to.equal(true);

      const after = fs.readdirSync(runDir);
      expect(after).to.deep.equal(before);
    });

    it('creates the run directory if it does not exist yet', function () {
      const fresh = path.join(root, 'fresh');
      expect(fs.existsSync(fresh)).to.equal(false);

      const result = verifyRunDirectoryWritable(fresh);
      expect(result.ok).to.equal(true);
      expect(fs.existsSync(fresh)).to.equal(true);
    });

    it('rejects a path whose parent component is a regular file', function () {
      const blocker = path.join(root, 'blocker');
      fs.writeFileSync(blocker, 'not a directory\n');

      const result = verifyRunDirectoryWritable(path.join(blocker, 'inner'));
      expect(result.ok).to.equal(false);
      expect(result.note).to.be.a('string').and.match(/not writable|run directory/i);
    });
  });

  describe('runConfigPreflight', function () {
    it('returns a PASS phase result for a healthy fixture context', async function () {
      const result = await runConfigPreflight(makeContext(), { env: {} });

      expect(result.index).to.equal(PHASE_INDEX);
      expect(result.state).to.equal(STATE.PASS);
      expect(result.codes).to.deep.equal([]);
      expect(result.notes).to.be.an('array').that.is.not.empty;
      expect(result.durationMs).to.be.a('number').and.at.least(0);
      expect(validatePhaseResult(result)).to.equal(true);
    });

    it('produces an envSummary that does not contain raw secrets or token values', async function () {
      const secret = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const tokenFragment = 'super-secret-rpc-token';

      const result = await runConfigPreflight(makeContext(), {
        env: {
          OPERATOR_PRIVATE_KEY: secret,
          RPC_URL: `https://example.invalid/${tokenFragment}`,
        },
      });

      expect(result.envSummary).to.be.an('object');
      const serialized = JSON.stringify(result.envSummary);
      expect(serialized).to.not.include(secret);
      expect(serialized).to.not.include(tokenFragment);
      expect(result.envSummary.operatorPrivateKeySet).to.equal(true);
      expect(result.envSummary.rpcUrlSet).to.equal(true);
    });

    it('FAILs with CONFIG_ENV_MISSING when live-testnet env is incomplete', async function () {
      const result = await runConfigPreflight(makeContext({ mode: 'live-testnet' }), {
        env: { RPC_URL: 'http://x' },
      });

      expect(result.state).to.equal(STATE.FAIL);
      expect(result.codes).to.include('CONFIG_ENV_MISSING');

      const noteText = result.notes.join(' ');
      expect(noteText).to.match(/Missing required environment variables/);
      expect(noteText).to.include('OPERATOR_PRIVATE_KEY');
      expect(noteText).to.include('PILOT_ESCROW_ADDRESS');
      expect(noteText).to.include('VENOM_REGISTRY_ADDRESS');
      expect(noteText).to.not.include('RPC_URL');
    });

    it('PASSes for live-testnet when all required env vars are present', async function () {
      const result = await runConfigPreflight(makeContext({ mode: 'live-testnet' }), {
        env: {
          RPC_URL: 'http://x',
          OPERATOR_PRIVATE_KEY: '0xabc',
          PILOT_ESCROW_ADDRESS: '0x0000000000000000000000000000000000000001',
          VENOM_REGISTRY_ADDRESS: '0x0000000000000000000000000000000000000002',
        },
      });

      expect(result.state).to.equal(STATE.PASS);
      expect(result.codes).to.deep.equal([]);
    });

    it('FAILs when the run directory is not writable', async function () {
      // Force unwritability by putting a regular file where a parent directory
      // would have to exist. Cross-platform; mkdirSync will throw ENOTDIR.
      const blocker = path.join(root, 'blocker');
      fs.writeFileSync(blocker, 'block\n');
      const unwritable = path.join(blocker, 'inner');

      const result = await runConfigPreflight(makeContext({ runDir: unwritable }), {
        env: {},
      });

      expect(result.state).to.equal(STATE.FAIL);
      expect(result.codes).to.include('CONFIG_RUNDIR_NOT_WRITABLE');
      expect(result.codes).to.not.include('CONFIG_ENV_MISSING');
      expect(result.notes.join(' ')).to.match(/not writable|run directory/i);
    });

    it('FAILs with CIST_UNEXPECTED_ERROR for a null context', async function () {
      const result = await runConfigPreflight(null);

      expect(result.state).to.equal(STATE.FAIL);
      expect(result.codes).to.include('CIST_UNEXPECTED_ERROR');
      expect(result.notes.join(' ')).to.match(/Config preflight failed unexpectedly/);
    });

    it('FAILs with CIST_UNEXPECTED_ERROR when context.mode is missing', async function () {
      const result = await runConfigPreflight({ runDir });

      expect(result.state).to.equal(STATE.FAIL);
      expect(result.codes).to.include('CIST_UNEXPECTED_ERROR');
    });

    it('FAILs with CIST_UNEXPECTED_ERROR when context.runDir is missing', async function () {
      const result = await runConfigPreflight({ mode: 'fixture' });

      expect(result.state).to.equal(STATE.FAIL);
      expect(result.codes).to.include('CIST_UNEXPECTED_ERROR');
    });

    it('falls back to process.env when options.env is not provided', async function () {
      // Fixture mode requires no env vars, so this exercises the
      // `options.env || process.env` branch without depending on the host env.
      const result = await runConfigPreflight(makeContext());

      expect(result.state).to.equal(STATE.PASS);
    });

    it('reports a non-negative integer durationMs even for fast paths', async function () {
      const result = await runConfigPreflight(makeContext(), { env: {} });

      expect(Number.isInteger(result.durationMs)).to.equal(true);
      expect(result.durationMs).to.be.at.least(0);
    });

    it('produces FAIL results that still satisfy validatePhaseResult', async function () {
      const failResult = await runConfigPreflight(makeContext({ mode: 'live-testnet' }), {
        env: {},
      });

      expect(failResult.state).to.equal(STATE.FAIL);
      expect(validatePhaseResult(failResult)).to.equal(true);
    });

    it('does not leak the synthetic self-test private key into phase notes', async function () {
      // The redaction self-test scans a synthetic 0x-prefixed 64-hex string.
      // The phase must not echo that synthetic value into report-bound notes.
      const result = await runConfigPreflight(makeContext(), { env: {} });
      const noteText = result.notes.join(' ');

      expect(noteText).to.not.match(/0x[a-fA-F0-9]{64}/);
    });
  });
});
