// aggregator/queue.js
const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const path = require('path');

// Robust .env loading
const rootEnvPath = path.join(__dirname, "../.env");
require("dotenv").config({ path: rootEnvPath, quiet: true });

// Redis connection
const connection = new IORedis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: null
});

const QUEUE_NAME = 'venom-campaigns';
const campaignQueue = new Queue(QUEUE_NAME, { connection });

module.exports = {
  campaignQueue,
  connection,
  QUEUE_NAME
};
