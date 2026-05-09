const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const { EventEmitter } = require('events');
const path = require('path');

const rootEnvPath = path.join(__dirname, "../.env");
require("dotenv").config({ path: rootEnvPath, quiet: true });

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT || 6379);
const REDIS_USERNAME = process.env.REDIS_USERNAME || 'venom_node';
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
const REDIS_TLS = process.env.REDIS_TLS === 'true';

const BASE_QUEUE_NAME = process.env.QUEUE_NAME || 'venom-campaigns';

function normalizeQueueSuffix(input) {
  const suffix = String(input || '').trim();
  if (!suffix) return '';
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(suffix)) {
    throw new Error('OPERATOR_QUEUE_SUFFIX must be 1-64 characters using only letters, numbers, dot, underscore, or dash');
  }
  return suffix;
}

const OPERATOR_QUEUE_SUFFIX = normalizeQueueSuffix(process.env.OPERATOR_QUEUE_SUFFIX);

function buildQueueName(baseName = BASE_QUEUE_NAME, suffix = OPERATOR_QUEUE_SUFFIX) {
  const normalizedSuffix = normalizeQueueSuffix(suffix);
  return normalizedSuffix ? `${baseName}-${normalizedSuffix}` : baseName;
}

function operatorScopedKey(...parts) {
  const scopedParts = OPERATOR_QUEUE_SUFFIX
    ? ['venom', OPERATOR_QUEUE_SUFFIX, ...parts]
    : ['venom', ...parts];
  return scopedParts.map((part) => String(part)).join(':');
}

const QUEUE_NAME = buildQueueName();

let connection = null;
let campaignQueue = null;
const redisEventEmitter = new EventEmitter();

function createRedisConnection() {
  const conn = new IORedis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    username: REDIS_USERNAME,
    password: REDIS_PASSWORD,
    tls: REDIS_TLS ? {} : undefined,
    maxRetriesPerRequest: null,
    retryStrategy: (times) => Math.min(times * 100, 3000),
    reconnectOnError: (err) => {
      const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
      if (targetErrors.some(e => err.message.includes(e))) {
        return true;
      }
      return false;
    }
  });

  conn.on('error', (err) => {
    console.error('[Redis] Connection error:', err.message);
    redisEventEmitter.emit('error', err);
  });
  conn.on('close', () => {
    console.warn('[Redis] Connection closed, attempting reconnect...');
    redisEventEmitter.emit('close');
  });
  conn.on('reconnecting', () => {
    console.log('[Redis] Reconnecting...');
    redisEventEmitter.emit('reconnecting');
  });
  conn.on('connect', () => {
    console.log('[Redis] Connected successfully');
    redisEventEmitter.emit('connect');
  });

  return conn;
}

function getConnection() {
  if (!connection) {
    connection = createRedisConnection();
  }
  return connection;
}

function getCampaignQueue() {
  if (!campaignQueue) {
    campaignQueue = new Queue(QUEUE_NAME, { connection: getConnection() });
  }
  return campaignQueue;
}

async function closeQueueResources() {
  if (campaignQueue) {
    await campaignQueue.close();
    campaignQueue = null;
  }
  if (connection) {
    try {
      await connection.quit();
    } catch (error) {
      console.error('[Redis] Error closing connection:', error.message);
    } finally {
      connection = null;
    }
  }
}

function reconnectRedis() {
  if (connection) {
    try {
      connection.disconnect();
    } catch (e) {}
  }
  connection = createRedisConnection();
  redisEventEmitter.emit('reconnected');
}

module.exports = {
  getConnection,
  getCampaignQueue,
  closeQueueResources,
  reconnectRedis,
  redisEventEmitter,
  BASE_QUEUE_NAME,
  OPERATOR_QUEUE_SUFFIX,
  normalizeQueueSuffix,
  buildQueueName,
  operatorScopedKey,
  QUEUE_NAME
};
