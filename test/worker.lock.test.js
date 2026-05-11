'use strict';

const { expect } = require('chai');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const workerPath = path.join(repoRoot, 'aggregator', 'worker.js');

function loadWorkerConfig(envOverrides = {}) {
  const script = [
    `const worker = require(${JSON.stringify(workerPath)});`,
    'const result = {',
    '  jobLockDurationMs: worker.JOB_LOCK_DURATION_MS,',
    '  workerJobTimeoutMs: worker.WORKER_JOB_TIMEOUT_MS,',
    '};',
    'try {',
    '  worker.assertWorkerLockConfig();',
    '  result.assertion = "pass";',
    '} catch (error) {',
    '  result.assertion = "fail";',
    '  result.error = error.message;',
    '}',
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    FETCH_TIMEOUT_MS: '5000',
    IPFS_GATEWAY_TIMEOUT: '5000',
    ML_TIMEOUT_MS: '5000',
    JOB_LOCK_DURATION_MS: '',
    WORKER_JOB_TIMEOUT_MS: '',
    ...envOverrides,
  };

  return JSON.parse(execFileSync(process.execPath, ['-e', script], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  }));
}

describe('worker lock configuration', function () {
  it('prefers JOB_LOCK_DURATION_MS over legacy WORKER_JOB_TIMEOUT_MS', function () {
    const result = loadWorkerConfig({
      JOB_LOCK_DURATION_MS: '30000',
      WORKER_JOB_TIMEOUT_MS: '60000',
    });

    expect(result.jobLockDurationMs).to.equal(30000);
    expect(result.workerJobTimeoutMs).to.equal(30000);
    expect(result.assertion).to.equal('pass');
  });

  it('falls back to WORKER_JOB_TIMEOUT_MS for compatibility', function () {
    const result = loadWorkerConfig({
      WORKER_JOB_TIMEOUT_MS: '31000',
    });

    expect(result.jobLockDurationMs).to.equal(31000);
    expect(result.workerJobTimeoutMs).to.equal(31000);
    expect(result.assertion).to.equal('pass');
  });

  it('defaults to a lock duration that satisfies the minimum buffer', function () {
    const result = loadWorkerConfig({
      FETCH_TIMEOUT_MS: '',
      IPFS_GATEWAY_TIMEOUT: '',
      ML_TIMEOUT_MS: '',
    });

    expect(result.jobLockDurationMs).to.equal(65000);
    expect(result.workerJobTimeoutMs).to.equal(65000);
    expect(result.assertion).to.equal('pass');
  });

  it('rejects a lock shorter than fetch plus ML timeout plus buffer', function () {
    const result = loadWorkerConfig({
      FETCH_TIMEOUT_MS: '8000',
      IPFS_GATEWAY_TIMEOUT: '8000',
      ML_TIMEOUT_MS: '12000',
      JOB_LOCK_DURATION_MS: '39000',
    });

    expect(result.assertion).to.equal('fail');
    expect(result.error).to.match(/at least 40000ms/);
  });
});
