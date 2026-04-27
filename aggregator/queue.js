const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const path = require('path');

const rootEnvPath = path.join(__dirname, "../.env");
require("dotenv").config({ path: rootEnvPath, quiet: true });

const QUEUE_NAME = 'venom-campaigns';
let connection = null;
let campaignQueue = null;

function getConnection() {
  if (!connection) {
    connection = new IORedis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: Number(process.env.REDIS_PORT || 6379),
      maxRetriesPerRequest: null
    });
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
    await connection.quit();
    connection = null;
  }
}

module.exports = {
  QUEUE_NAME,
  getConnection,
  getCampaignQueue,
  closeQueueResources
};
