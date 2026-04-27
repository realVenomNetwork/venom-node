'use strict';

const { expect } = require('chai');

const {
  PHASE_INDEX,
  buildRedisNamespace,
  assertRedisClientShape,
  runRedisPreflight,
} = require('../phases/redis-preflight');

const { STATE, PHASE_BY_INDEX, validatePhaseResult } = require('../phases');

describe('CIST Phase 3: Redis and queue', function () {
  function makeContext(overrides = {}) {
    return {
      runId: 'cist-20260427-143012-a83f9c1e',
      runDir: '/tmp/test-run',
      mode: 'fixture',
      scenario: 'all-agree',
      ...overrides,
    };
  }

  function makeRedisClient({ ping = 'PONG', keys = [] } = {}) {
    return {
      ping: async () => ping,
      keys: async () => keys,
    };
  }

  function makeFailingRedisClient() {
    return {
      ping: async () => { throw new Error('connection refused'); },
      keys: async () => [],
    };
  }

  function makeQueue(overrides = {}) {
    return {
      name: 'cist-smoke-test',
      add: async () => ({ id: 'job-1' }),
      close: async () => undefined,
      ...overrides,
    };
  }

  it('declares PHASE_INDEX as 3 and aligns with the phases registry', function () {
    expect(PHASE_INDEX).to.equal(3);
    expect(PHASE_BY_INDEX[PHASE_INDEX].key).to.equal('redis');
  });

  it('buildRedisNamespace returns cist:<runId>', function () {
    expect(buildRedisNamespace(makeContext())).to.equal(
      'cist:cist-20260427-143012-a83f9c1e'
    );
  });

  it('WARNs with REDIS_NOT_CONFIGURED when no redis client is supplied', async function () {
    const result = await runRedisPreflight(makeContext(), {});
    expect(result.state).to.equal(STATE.WARN);
    expect(result.codes).to.deep.equal(['REDIS_NOT_CONFIGURED']);
    expect(result.redis).to.deep.equal({ configured: false });
    expect(validatePhaseResult(result)).to.equal(true);
  });

  it('FAILs with REDIS_UNREACHABLE when ping throws', async function () {
    const result = await runRedisPreflight(makeContext(), {
      redisClient: makeFailingRedisClient(),
    });
    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('REDIS_UNREACHABLE');
    expect(result.notes.join(' ')).to.match(/connection refused|Redis/i);
    expect(validatePhaseResult(result)).to.equal(true);
  });

  it('WARNs with QUEUE_NOT_CONFIGURED when Redis is healthy and no queue is supplied', async function () {
    const result = await runRedisPreflight(makeContext(), {
      redisClient: makeRedisClient(),
    });
    expect(result.state).to.equal(STATE.WARN);
    expect(result.codes).to.deep.equal(['QUEUE_NOT_CONFIGURED']);
    expect(result.redis.configured).to.equal(true);
    expect(result.redis.ping).to.equal('PONG');
    expect(result.redis.namespaceCollision).to.equal(false);
    expect(validatePhaseResult(result)).to.equal(true);
  });

  it('FAILs with REDIS_NAMESPACE_COLLISION when namespace has existing keys', async function () {
    const context = makeContext();
    const result = await runRedisPreflight(context, {
      redisClient: makeRedisClient({
        keys: [`${buildRedisNamespace(context)}:old-job`],
      }),
    });
    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('REDIS_NAMESPACE_COLLISION');
    expect(result.redis.namespaceCollision).to.equal(true);
  });

  it('FAILs with QUEUE_BINDING_INVALID when queue is supplied but missing required methods', async function () {
    const result = await runRedisPreflight(makeContext(), {
      redisClient: makeRedisClient(),
      queue: { name: 'bad-queue' },
    });
    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('QUEUE_BINDING_INVALID');
  });

  it('PASSes with valid queue shape (add, close, name)', async function () {
    const result = await runRedisPreflight(makeContext(), {
      redisClient: makeRedisClient(),
      queue: makeQueue(),
    });
    expect(result.state).to.equal(STATE.PASS);
    expect(result.queue).to.deep.include({
      configured: true,
      name: 'cist-smoke-test',
      hasAdd: true,
      hasClose: true,
    });
  });

  it('stores only serializable primitives in result metadata', async function () {
    const result = await runRedisPreflight(makeContext(), {
      redisClient: makeRedisClient(),
      queue: makeQueue(),
    });
    expect(() => JSON.stringify(result)).to.not.throw();
    const serialized = JSON.stringify(result);
    expect(serialized).to.not.include('function');
    expect(serialized).to.include('"queue"');
    expect(result).to.have.property('queue');
  });
});
