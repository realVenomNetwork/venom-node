'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { STATE, validatePhaseResult } = require('./phases');
const { assertNoSecrets } = require('./redaction');

const SCHEMA_VERSION = '1.1';
const HARNESS_VERSION = '1.1.0';
const REDACTION_FAILURE_CODE = 'REPORT_REDACTION_FAILED';

const DID_NOT_VERIFY = Object.freeze([
  'live-network gossip resilience',
  'real bounty funding',
  'operator payout distribution',
  'unstake lifecycle',
  'governance/tithe integration into closeCampaign',
  'live IPFS gateway reliability',
  'non-exhaustive: CIST verifies a happy-path lifecycle, not a comprehensive failure surface'
]);

function normalizeDate(value, fieldName) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid report input: ${fieldName} is invalid`);
  }
  return date;
}

function validateRunContext(runContext) {
  if (!runContext || typeof runContext !== 'object') {
    throw new Error('Invalid report input: runContext is required');
  }
  if (typeof runContext.runId !== 'string' || !runContext.runId) {
    throw new Error('Invalid report input: runContext.runId is required');
  }
  if (typeof runContext.runDir !== 'string' || !path.isAbsolute(runContext.runDir)) {
    throw new Error('Invalid report input: runContext.runDir must be an absolute path');
  }
}

function deriveOverallResult(phases) {
  return phases.some((phase) => phase.state === STATE.FAIL || phase.state === STATE.SKIP)
    ? STATE.FAIL
    : STATE.PASS;
}

function safeFindPhase(phases, index) {
  return Array.isArray(phases) ? phases.find((phase) => phase && phase.index === index) : null;
}

function summarizeNetwork(phases, runContext) {
  const phase2 = safeFindPhase(phases, 2);
  const network = phase2 && phase2.network ? phase2.network : null;

  return network || {
    chainId: null,
    name: null,
    rpcRedacted: Boolean(runContext?.env?.rpcUrlSet)
  };
}

function summarizeContracts(phases) {
  const phase2 = safeFindPhase(phases, 2);
  return phase2 && phase2.contracts ? phase2.contracts : {};
}

function summarizeOperator(runContext) {
  const env = runContext && runContext.env ? runContext.env : {};
  return {
    privateKeySet: Boolean(env.operatorPrivateKeySet),
    broadcasterKeySet: Boolean(env.broadcasterPrivateKeySet),
    deployerKeySet: Boolean(env.deployerPrivateKeySet),
    rpcConfigured: Boolean(env.rpcUrlSet)
  };
}

function summarizeCampaign(phases) {
  const phase5 = safeFindPhase(phases, 5);
  const payload = phase5 && phase5.payload ? phase5.payload : null;

  return {
    configured: Boolean(payload && payload.configured),
    campaignUid: payload && typeof payload.campaignUid === 'string' ? payload.campaignUid : null
  };
}

function resolveGitCommit() {
  if (typeof process.env.GIT_COMMIT === 'string' && process.env.GIT_COMMIT) {
    return process.env.GIT_COMMIT;
  }

  try {
    let dir = process.cwd();
    while (true) {
      const dotGit = path.join(dir, '.git');
      if (fs.existsSync(dotGit)) {
        let gitDir = dotGit;
        if (fs.statSync(dotGit).isFile()) {
          const text = fs.readFileSync(dotGit, 'utf8').trim();
          const match = text.match(/^gitdir:\s*(.+)$/i);
          if (!match) return null;
          gitDir = path.resolve(dir, match[1].trim());
        }

        const headPath = path.join(gitDir, 'HEAD');
        const head = fs.readFileSync(headPath, 'utf8').trim();
        if (head.startsWith('ref: ')) {
          const ref = head.slice('ref: '.length).trim();
          const refPath = path.join(gitDir, ...ref.split('/'));
          const resolved = fs.readFileSync(refPath, 'utf8').trim();
          return resolved.slice(0, 7);
        }

        return head.slice(0, 7);
      }

      const parent = path.dirname(dir);
      if (parent === dir) {
        return null;
      }
      dir = parent;
    }
  } catch {
    return null;
  }
}

function toRedactionFailure(error) {
  if (error.code === REDACTION_FAILURE_CODE) return error;
  const wrapped = new Error('Report redaction failed');
  wrapped.code = REDACTION_FAILURE_CODE;
  wrapped.cause = error;
  wrapped.matches = error.matches || [];
  return wrapped;
}

function assertReportHasNoSecrets(value) {
  try {
    assertNoSecrets(typeof value === 'string' ? value : JSON.stringify(value));
    return true;
  } catch (error) {
    throw toRedactionFailure(error);
  }
}

function buildJsonReport(params) {
  const {
    runContext,
    phases,
    mode = 'fixture',
    scenario = 'all-agree',
    startedAt = new Date(),
    finishedAt = new Date(),
    releaseReadiness = { unresolved: [] },
    argv = process.argv.slice(2),
    command = 'npm run pilot:smoke-test'
  } = params || {};

  validateRunContext(runContext);
  if (!Array.isArray(phases)) {
    throw new Error('Invalid report input: phases must be an array');
  }
  phases.forEach(validatePhaseResult);

  const started = normalizeDate(startedAt, 'startedAt');
  const finished = normalizeDate(finishedAt, 'finishedAt');
  if (finished.getTime() < started.getTime()) {
    throw new Error('Invalid report input: finishedAt must be after startedAt');
  }

  const report = {
    schemaVersion: SCHEMA_VERSION,
    harnessVersion: HARNESS_VERSION,
    gitCommit: resolveGitCommit(),
    command,
    argv,
    runId: runContext.runId,
    runDir: runContext.runDir,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - started.getTime(),
    mode,
    scenario,
    environment: runContext.env || {},
    network: summarizeNetwork(phases, runContext),
    contracts: summarizeContracts(phases),
    operator: summarizeOperator(runContext),
    campaign: summarizeCampaign(phases),
    phases,
    result: deriveOverallResult(phases),
    releaseReadiness: {
      unresolved: Array.isArray(releaseReadiness.unresolved) ? releaseReadiness.unresolved : []
    },
    didNotVerify: [...DID_NOT_VERIFY]
  };

  assertReportHasNoSecrets(report);
  return report;
}

function tmpPathFor(finalPath) {
  const dir = path.dirname(finalPath);
  const base = path.basename(finalPath);
  const suffix = crypto.randomBytes(8).toString('hex');
  return path.join(dir, `.${base}.${process.pid}.${suffix}.tmp`);
}

function cleanupTmp(tmpPath) {
  try {
    fs.rmSync(tmpPath, { force: true });
  } catch {
    // best effort cleanup
  }
}

function fsyncPathIfPossible(targetPath) {
  let fd;
  try {
    fd = fs.openSync(targetPath, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Directory fsync is best-effort on non-POSIX platforms.
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort cleanup
      }
    }
  }
}

function fsyncParentDirIfPossible(finalPath) {
  fsyncPathIfPossible(path.dirname(finalPath));
}

function writeTempFileWithFsync(tmpPath, content) {
  let fd;
  try {
    fd = fs.openSync(tmpPath, 'w', 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

function renameTempIntoPlace(tmpPath, finalPath) {
  fs.renameSync(tmpPath, finalPath);
  fsyncParentDirIfPossible(finalPath);
}

function atomicWriteJson(finalPath, data) {
  const content = `${JSON.stringify(data, null, 2)}\n`;
  assertReportHasNoSecrets(content);
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  const tmpPath = tmpPathFor(finalPath);

  try {
    writeTempFileWithFsync(tmpPath, content);
    renameTempIntoPlace(tmpPath, finalPath);
  } catch (error) {
    cleanupTmp(tmpPath);
    throw error;
  }
}

function atomicWriteText(finalPath, text) {
  assertReportHasNoSecrets(text);
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  const tmpPath = tmpPathFor(finalPath);

  try {
    writeTempFileWithFsync(tmpPath, text);
    renameTempIntoPlace(tmpPath, finalPath);
  } catch (error) {
    cleanupTmp(tmpPath);
    throw error;
  }
}

function writeJsonReport(params) {
  const report = buildJsonReport(params);
  const jsonPath = path.join(params.runContext.runDir, 'report.json');
  atomicWriteJson(jsonPath, report);
  return jsonPath;
}

function buildMarkdownReport(report) {
  assertReportHasNoSecrets(report);
  const lines = [
    '# VENOM CIST Report',
    '',
    '## Verdict',
    `- Lifecycle integration: ${report.result}`,
    `- Mode: ${report.mode}`,
    `- Scenario: ${report.scenario}`,
    `- Run ID: ${report.runId}`,
    '',
    '## What this run did not verify',
    ...report.didNotVerify.map((entry) => `- ${entry}`),
    '',
    '## Phase results',
    '| # | Phase | State | Duration | Codes |',
    '|---:|---|---|---:|---|'
  ];

  for (const phase of report.phases) {
    const codes = phase.codes.length ? phase.codes.join(', ') : '-';
    lines.push(`| ${phase.index} | ${phase.name} | ${phase.state} | ${phase.durationMs}ms | ${codes} |`);
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

function writeMarkdownReport(params) {
  const report = params.report || buildJsonReport(params);
  const markdownPath = path.join(params.runContext.runDir, 'report.md');
  atomicWriteText(markdownPath, buildMarkdownReport(report));
  return markdownPath;
}

function removeReportArtifacts(runDir) {
  for (const name of ['report.json', 'report.md']) {
    try {
      fs.rmSync(path.join(runDir, name), { force: true });
    } catch {
      // best effort cleanup
    }
  }
  for (const entry of fs.existsSync(runDir) ? fs.readdirSync(runDir) : []) {
    if (/^\.report\.(json|md)\..*\.tmp$/.test(entry)) {
      cleanupTmp(path.join(runDir, entry));
    }
  }
}

function writeReports(params) {
  const report = buildJsonReport(params);
  const jsonPath = path.join(params.runContext.runDir, 'report.json');
  const markdownPath = path.join(params.runContext.runDir, 'report.md');

  try {
    atomicWriteJson(jsonPath, report);
    atomicWriteText(markdownPath, buildMarkdownReport(report));
    return { jsonPath, markdownPath };
  } catch (error) {
    if (error.code === REDACTION_FAILURE_CODE) {
      removeReportArtifacts(params.runContext.runDir);
    }
    throw error;
  }
}

module.exports = {
  SCHEMA_VERSION,
  HARNESS_VERSION,
  REDACTION_FAILURE_CODE,
  buildJsonReport,
  writeJsonReport,
  buildMarkdownReport,
  writeMarkdownReport,
  writeReports,
  atomicWriteJson,
  atomicWriteText,
  deriveOverallResult,
  assertReportHasNoSecrets
};
