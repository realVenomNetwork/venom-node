'use strict';

const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const latest = require('../latest');

function makeRun(baseDir, runId) {
  const runDir = path.join(baseDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

describe('CIST latest pointer', function () {
  let root;

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cist-latest-'));
  });

  afterEach(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('validates missing and nonexistent input', function () {
    const runDir = makeRun(root, 'run-1');
    expect(() => latest.updateLatestPointer({ runId: 'run-1', runDir })).to.throw('baseDir');
    expect(() => latest.updateLatestPointer({ baseDir: root, runDir })).to.throw('runId');
    expect(() => latest.updateLatestPointer({ baseDir: root, runId: 'run-1' })).to.throw('runDir');
    expect(() => latest.updateLatestPointer({ baseDir: root, runId: 'missing', runDir: path.join(root, 'missing') }))
      .to.throw('runDir does not exist');
  });

  it('updates a symlink where supported and removes stale fallback text', function () {
    const runId = 'run-1';
    const runDir = makeRun(root, runId);
    fs.writeFileSync(path.join(root, 'latest.txt'), 'stale\n');

    let result;
    try {
      result = latest.updateLatestSymlink({ baseDir: root, runId, runDir });
    } catch (error) {
      this.skip(`symlink unavailable in this environment: ${error.message}`);
    }

    expect(result.type).to.equal('symlink');
    expect(fs.existsSync(path.join(root, 'latest'))).to.equal(true);
    expect(fs.realpathSync(path.join(root, 'latest'))).to.equal(fs.realpathSync(runDir));
    expect(fs.existsSync(path.join(root, 'latest.txt'))).to.equal(false);
  });

  it('falls back to latest.txt when symlink creation fails', function () {
    const runId = 'run-1';
    const runDir = makeRun(root, runId);
    const original = fs.symlinkSync;
    fs.symlinkSync = () => {
      throw new Error('no symlink');
    };

    try {
      const result = latest.updateLatestPointer({ baseDir: root, runId, runDir });
      expect(result.type).to.equal('text');
      expect(fs.readFileSync(path.join(root, 'latest.txt'), 'utf8')).to.equal(`${runId}\n`);
    } finally {
      fs.symlinkSync = original;
    }
  });

  it('updates repeated pointers to the latest run', function () {
    const firstDir = makeRun(root, 'run-1');
    const secondDir = makeRun(root, 'run-2');

    latest.updateLatestPointer({ baseDir: root, runId: 'run-1', runDir: firstDir });
    const result = latest.updateLatestPointer({ baseDir: root, runId: 'run-2', runDir: secondDir });

    if (result.type === 'symlink') {
      expect(fs.realpathSync(path.join(root, 'latest'))).to.equal(fs.realpathSync(secondDir));
    } else {
      expect(fs.readFileSync(path.join(root, 'latest.txt'), 'utf8')).to.equal('run-2\n');
    }
  });
});
