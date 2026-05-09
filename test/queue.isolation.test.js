const { expect } = require("chai");
const { Worker } = require("bullmq");
const { buildQueueName } = require("../aggregator/queue");

const QUEUE_MODULE = "../aggregator/queue";
const PRODUCER_MODULE = "../aggregator/producer";
const ENV_KEYS = ["QUEUE_NAME", "OPERATOR_QUEUE_SUFFIX", "PILOT_ESCROW_ADDRESS"];

function clearRuntimeModules() {
  for (const modulePath of [QUEUE_MODULE, PRODUCER_MODULE]) {
    delete require.cache[require.resolve(modulePath)];
  }
}

function withRuntimeEnv(env, assertion) {
  const previous = {};
  for (const key of ENV_KEYS) {
    previous[key] = process.env[key];
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      process.env[key] = env[key];
    } else {
      delete process.env[key];
    }
  }

  clearRuntimeModules();
  try {
    assertion();
  } finally {
    clearRuntimeModules();
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

describe("BullMQ queue isolation", function () {
  it("preserves default shared queue names and Redis keys", function () {
    withRuntimeEnv({
      QUEUE_NAME: "venom-campaigns",
      OPERATOR_QUEUE_SUFFIX: "",
      PILOT_ESCROW_ADDRESS: "0xABCDEF"
    }, () => {
      const queue = require(QUEUE_MODULE);
      const producer = require(PRODUCER_MODULE);

      expect(queue.BASE_QUEUE_NAME).to.equal("venom-campaigns");
      expect(queue.OPERATOR_QUEUE_SUFFIX).to.equal("");
      expect(queue.QUEUE_NAME).to.equal("venom-campaigns");
      expect(queue.operatorScopedKey("campaign", "queued", "0xabc")).to.equal("venom:campaign:queued:0xabc");
      expect(producer.getCursorKey()).to.equal("venom:producer:lastScannedBlock:0xabcdef");
    });
  });

  it("scopes queue names, producer cursors, and queued-campaign markers by operator suffix", function () {
    withRuntimeEnv({
      QUEUE_NAME: "venom-campaigns",
      OPERATOR_QUEUE_SUFFIX: "op1",
      PILOT_ESCROW_ADDRESS: "0xABCDEF"
    }, () => {
      const queue = require(QUEUE_MODULE);
      const producer = require(PRODUCER_MODULE);

      expect(queue.QUEUE_NAME).to.equal("venom-campaigns-op1");
      expect(queue.buildQueueName("custom-queue", "op-2")).to.equal("custom-queue-op-2");
      expect(queue.operatorScopedKey("campaign", "queued", "0xabc")).to.equal("venom:op1:campaign:queued:0xabc");
      expect(producer.getCursorKey()).to.equal("venom:op1:producer:lastScannedBlock:0xabcdef");
    });
  });

  it("rejects ambiguous suffixes before connecting to Redis", function () {
    withRuntimeEnv({
      QUEUE_NAME: "venom-campaigns",
      OPERATOR_QUEUE_SUFFIX: "op:1",
      PILOT_ESCROW_ADDRESS: "0xABCDEF"
    }, () => {
      expect(() => require(QUEUE_MODULE)).to.throw(/OPERATOR_QUEUE_SUFFIX/);
    });
  });

  it("constructs a Worker for all valid suffixed queue names", async function () {
    const suffixes = ["op1", "op-test", "op_test", "op.test", "OPERATOR1", "a"];
    for (const suffix of suffixes) {
      const name = buildQueueName("venom-campaigns", suffix);
      const worker = new Worker(name, async () => {}, {
        connection: { host: "127.0.0.1", port: 6379 },
        autorun: false,
      });
      expect(worker.name).to.equal(name);
      await worker.close();
    }
  });
});
