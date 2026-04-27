'use strict';

const { performance } = require('node:perf_hooks');

const { STATE, createPhaseResult } = require('../phases');

const PHASE_INDEX = 3;

const DEFAULT_REDIS_NAMESPACE_PREFIX = 'cist';

function buildRedisNamespace(context) {
  return `${DEFAULT_REDIS_NAMESPACE_PREFIX}:${context.runId}`;
}

function assertRedisClientShape(client) {
  if (!client || typeof client.ping !== 'function') {
    throw new Error('Redis client must have a ping() method');
  }
  if (typeof client.keys !== 'function') {
    throw new Error('Redis client must have a keys() method');
  }
  return true;
}

async function runRedisPreflight(context, options = {}) {
  const started = performance.now();
  const codes = [];
  const notes = [];
  const redis = { configured: false };
  const queue = { configured: false };

  try {
    if (!options.redisClient) {
      return createPhaseResult(PHASE_INDEX, STATE.WARN, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes: ['REDIS_NOT_CONFIGURED'],
        notes: [
          'Redis client was not configured; Redis and queue probes were not run.',
          'Run with a Redis-backed CIST invocation for full queue checks.',
        ],
        redis,
        queue,
      });
    }

    assertRedisClientShape(options.redisClient);
    redis.configured = true;

    try {
      redis.ping = await options.redisClient.ping();
    } catch (error) {
      codes.push('REDIS_UNREACHABLE');
      notes.push(`Redis ping failed: ${error.message}`);
      return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes,
        notes,
        redis,
        queue,
      });
    }

    const namespace = buildRedisNamespace(context);
    redis.namespace = namespace;

    const existingKeys = await options.redisClient.keys(`${namespace}:*`);
    if (existingKeys.length > 0) {
      codes.push('REDIS_NAMESPACE_COLLISION');
      notes.push('CIST Redis namespace already contains keys from a previous run.');
      redis.namespaceCollision = true;
      return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes,
        notes,
        redis,
        queue,
      });
    }
    redis.namespaceCollision = false;

    if (!options.queue) {
      codes.push('QUEUE_NOT_CONFIGURED');
      notes.push('Queue binding was not supplied; queue operation probe deferred.');
      return createPhaseResult(PHASE_INDEX, STATE.WARN, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes,
        notes,
        redis,
        queue,
      });
    }

    const q = options.queue;
    if (typeof q.add !== 'function' || typeof q.close !== 'function' || !q.name) {
      codes.push('QUEUE_BINDING_INVALID');
      notes.push('Queue binding is missing required methods (add, close) or name property.');
      return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes,
        notes,
        redis,
        queue,
      });
    }

    queue.configured = true;
    queue.name = q.name;
    queue.hasAdd = true;
    queue.hasClose = true;

    return createPhaseResult(PHASE_INDEX, STATE.PASS, {
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      codes,
      notes,
      redis,
      queue,
    });
  } catch (error) {
    codes.push('CIST_UNEXPECTED_ERROR');
    notes.push(`Redis preflight failed: ${error.message}`);
    return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      codes,
      notes,
      redis,
      queue,
    });
  }
}

module.exports = {
  PHASE_INDEX,
  DEFAULT_REDIS_NAMESPACE_PREFIX,
  buildRedisNamespace,
  assertRedisClientShape,
  runRedisPreflight,
};
