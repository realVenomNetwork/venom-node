'use strict';

const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPhaseResult, STATE } = require('../phases');
const {
  REDACTION_FAILURE_CODE,
  buildJsonReport,
  buildMarkdownReport,
  writeReports,
  atomicWriteJson,
  deriveOverallResult
} = require('../report');

function makeRunContext() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cist-report-'));
  const runContext = {
    runId: 'cist-20260427-143012-a83f9c1e',
    runDir: path.join(root, 'cist-20260427-143012-a83f9c1e'),
    env: {
      nodeEnv: 'test',
      useTestPayload: true,
      redisHost: '127.0.0.1',
      redisPort: 6379,
      cistRedisDb: 14,
      mlServiceUrl: null,
      rpcUrlSet: true,
      operatorPrivateKeySet: true,
      pilotEscrowAddressSet: true,
      venomRegistryAddressSet: true,
    }
  };
  fs.mkdirSync(runContext.runDir, { recursive: true });
  return { root, runContext };
}

function passPhase(index) {
  return createPhaseResult(index, STATE.PASS, { durationMs: index });
}

describe('CIST report writer', function () {
  it('builds the expected JSON report shape', function () {
    const { root, runContext } = makeRunContext();
    try {
      const phases = [passPhase(1), passPhase(2)];
      const report = buildJsonReport({
        runContext,
        phases,
        startedAt: '2026-04-27T14:30:12Z',
        finishedAt: '2026-04-27T14:30:13Z'
      });

      expect(report.schemaVersion).to.equal('1.1');
      expect(report.harnessVersion).to.equal('1.1.0');
      expect(report.gitCommit).to.satisfy((value) => value === null || (typeof value === 'string' && value.length > 0));
      expect(report.runId).to.equal(runContext.runId);
      expect(report.mode).to.equal('fixture');
      expect(report.scenario).to.equal('all-agree');
      expect(report.environment).to.deep.equal(runContext.env);
      expect(report.network).to.have.property('chainId');
      expect(report.contracts).to.deep.equal({});
      expect(report.operator).to.include({
        privateKeySet: true,
        broadcasterKeySet: false,
        deployerKeySet: false,
        rpcConfigured: true,
      });
      expect(report.campaign).to.deep.equal({
        configured: false,
        campaignUid: null,
      });
      expect(report.result).to.equal(STATE.PASS);
      expect(report.durationMs).to.equal(1000);
      expect(report.didNotVerify.at(-1)).to.match(/^non-exhaustive:/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses GIT_COMMIT when provided in the environment', function () {
    const { root, runContext } = makeRunContext();
    const previous = process.env.GIT_COMMIT;

    process.env.GIT_COMMIT = 'deadbeef';
    try {
      const report = buildJsonReport({
        runContext,
        phases: [passPhase(1), passPhase(2)],
        startedAt: '2026-04-27T14:30:12Z',
        finishedAt: '2026-04-27T14:30:13Z'
      });

      expect(report.gitCommit).to.equal('deadbeef');
    } finally {
      if (previous === undefined) {
        delete process.env.GIT_COMMIT;
      } else {
        process.env.GIT_COMMIT = previous;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('derives FAIL from FAIL or SKIP phases', function () {
    expect(deriveOverallResult([passPhase(1), createPhaseResult(2, STATE.WARN)])).to.equal(STATE.PASS);
    expect(deriveOverallResult([passPhase(1), createPhaseResult(2, STATE.FAIL)])).to.equal(STATE.FAIL);
    expect(deriveOverallResult([passPhase(1), createPhaseResult(2, STATE.SKIP)])).to.equal(STATE.FAIL);
  });

  it('writes JSON atomically', function () {
    const { root, runContext } = makeRunContext();
    try {
      const finalPath = path.join(runContext.runDir, 'report.json');
      atomicWriteJson(finalPath, { safe: true });
      expect(JSON.parse(fs.readFileSync(finalPath, 'utf8'))).to.deep.equal({ safe: true });
      expect(fs.readdirSync(runContext.runDir).filter((name) => name.endsWith('.tmp'))).to.deep.equal([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds Markdown from the JSON report object', function () {
    const { root, runContext } = makeRunContext();
    try {
      const report = buildJsonReport({
        runContext,
        phases: [passPhase(1)],
        startedAt: '2026-04-27T14:30:12Z',
        finishedAt: '2026-04-27T14:30:13Z'
      });
      const markdown = buildMarkdownReport(report);
      expect(markdown).to.include('# VENOM CIST Report');
      expect(markdown).to.include('Lifecycle integration: PASS');
      expect(markdown).to.include('| 1 | Config and redaction preflight | PASS | 1ms | - |');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('populates campaign metadata when phase 5 resolved a campaign UID', function () {
    const { root, runContext } = makeRunContext();
    try {
      const phases = [
        passPhase(1),
        passPhase(2),
        passPhase(3),
        passPhase(4),
        createPhaseResult(5, STATE.PASS, {
          payload: {
            configured: true,
            campaignUid: 'campaign-abc123',
            loaded: { campaignUid: 'campaign-abc123' }
          }
        })
      ];

      const report = buildJsonReport({
        runContext,
        phases,
        startedAt: '2026-04-27T14:30:12Z',
        finishedAt: '2026-04-27T14:30:13Z'
      });

      expect(report.campaign).to.deep.equal({
        configured: true,
        campaignUid: 'campaign-abc123'
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed on report redaction and leaves no report files', function () {
    const { root, runContext } = makeRunContext();
    const privateKey = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    try {
      expect(() => writeReports({
        runContext,
        phases: [createPhaseResult(1, STATE.FAIL, { notes: [privateKey] })]
      })).to.throw().with.property('code', REDACTION_FAILURE_CODE);
      expect(fs.existsSync(path.join(runContext.runDir, 'report.json'))).to.equal(false);
      expect(fs.existsSync(path.join(runContext.runDir, 'report.md'))).to.equal(false);
      expect(fs.readdirSync(runContext.runDir).filter((name) => name.endsWith('.tmp'))).to.deep.equal([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writeReports writes aligned JSON and Markdown artifacts', function () {
    const { root, runContext } = makeRunContext();
    try {
      const paths = writeReports({
        runContext,
        phases: [passPhase(1), passPhase(2)],
        startedAt: '2026-04-27T14:30:12Z',
        finishedAt: '2026-04-27T14:30:13Z'
      });

      const report = JSON.parse(fs.readFileSync(paths.jsonPath, 'utf8'));
      const markdown = fs.readFileSync(paths.markdownPath, 'utf8');
      expect(report.runId).to.equal(runContext.runId);
      expect(markdown).to.include(`Run ID: ${runContext.runId}`);
      expect(markdown).to.include(`Lifecycle integration: ${report.result}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
