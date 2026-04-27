'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatUtcTimestamp(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error('Invalid date');
  }

  return [
    date.getUTCFullYear(),
    pad2(date.getUTCMonth() + 1),
    pad2(date.getUTCDate())
  ].join('') + '-' + [
    pad2(date.getUTCHours()),
    pad2(date.getUTCMinutes()),
    pad2(date.getUTCSeconds())
  ].join('');
}

function shortUuid(uuid = crypto.randomUUID()) {
  return String(uuid).replace(/-/g, '').slice(0, 8);
}

function createRunId(date = new Date()) {
  return `cist-${formatUtcTimestamp(date)}-${shortUuid()}`;
}

function createRunContext(options = {}) {
  const baseDir = path.resolve(options.baseDir || path.join(process.cwd(), 'tmp', 'smoke-test'));
  const runId = options.runId || createRunId(options.date || new Date());
  const runDir = path.join(baseDir, runId);

  fs.mkdirSync(runDir, { recursive: true });
  return { runId, runDir };
}

module.exports = {
  formatUtcTimestamp,
  shortUuid,
  createRunId,
  createRunContext
};
