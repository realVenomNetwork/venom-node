const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const { EventEmitter } = require('events');
const path = require('path');

const rootEnvPath = path.join(__dirname, "../.env");
require("dotenv").config({ path: rootEnvPath, quiet: true });

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT || 6379);
const REDIS_USERNAME = process.env.REDIS_USERNAME || undefined;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
const REDIS_TLS = process.env.REDIS_TLS === 'true';

const QUEUE_NAME = process.env.QUEUE_NAME || 'venom-campaigns';

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
  QUEUE_NAME
};
