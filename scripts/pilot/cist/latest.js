'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function validateInput({ baseDir, runId, runDir }) {
  if (!baseDir) throw new Error('baseDir is required');
  if (!runId) throw new Error('runId is required');
  if (!runDir) throw new Error('runDir is required');
  if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) {
    throw new Error(`runDir does not exist: ${runDir}`);
  }
}

function removeIfExists(targetPath) {
  fs.rmSync(targetPath, { force: true, recursive: true });
}

function randomTmpPath(baseDir, name) {
  const suffix = crypto.randomBytes(8).toString('hex');
  return path.join(baseDir, `.${name}.${process.pid}.${suffix}.tmp`);
}

function cleanupTmp(tmpPath) {
  try {
    fs.rmSync(tmpPath, { force: true, recursive: true });
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

function fsyncParentDirIfPossible(targetPath) {
  fsyncPathIfPossible(path.dirname(targetPath));
}

function renameTempIntoPlace(tmpPath, finalPath) {
  try {
    fs.renameSync(tmpPath, finalPath);
  } catch (error) {
    if (error.code !== 'EEXIST' && error.code !== 'EPERM') {
      throw error;
    }
    removeIfExists(finalPath);
    fs.renameSync(tmpPath, finalPath);
  }
  fsyncParentDirIfPossible(finalPath);
}

function atomicWriteText(finalPath, text) {
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  const tmpPath = randomTmpPath(path.dirname(finalPath), path.basename(finalPath));
  let fd;

  try {
    fd = fs.openSync(tmpPath, 'w', 0o600);
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    renameTempIntoPlace(tmpPath, finalPath);
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort cleanup
      }
    }
    cleanupTmp(tmpPath);
    throw error;
  }
}

function updateLatestSymlink({ baseDir, runId, runDir }) {
  validateInput({ baseDir, runId, runDir });
  fs.mkdirSync(baseDir, { recursive: true });

  const latestPath = path.join(baseDir, 'latest');
  const fallbackPath = path.join(baseDir, 'latest.txt');
  const tmpPath = randomTmpPath(baseDir, 'latest');

  try {
    removeIfExists(tmpPath);
    fs.symlinkSync(runId, tmpPath, 'dir');
    renameTempIntoPlace(tmpPath, latestPath);
    removeIfExists(fallbackPath);
  } catch (error) {
    cleanupTmp(tmpPath);
    throw error;
  }

  return {
    type: 'symlink',
    path: latestPath,
    target: runId
  };
}

function updateLatestTextFile({ baseDir, runId }) {
  if (!baseDir) throw new Error('baseDir is required');
  if (!runId) throw new Error('runId is required');
  fs.mkdirSync(baseDir, { recursive: true });

  const latestPath = path.join(baseDir, 'latest.txt');
  atomicWriteText(latestPath, `${runId}\n`);
  return {
    type: 'text',
    path: latestPath,
    target: runId
  };
}

function updateLatestPointer({ baseDir, runId, runDir }) {
  validateInput({ baseDir, runId, runDir });
  try {
    return updateLatestSymlink({ baseDir, runId, runDir });
  } catch {
    removeIfExists(path.join(baseDir, 'latest'));
    return updateLatestTextFile({ baseDir, runId });
  }
}

module.exports = {
  updateLatestPointer,
  updateLatestSymlink,
  updateLatestTextFile
};
