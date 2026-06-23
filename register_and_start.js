#!/usr/bin/env node
require('dotenv').config({ quiet: true });
const { ethers } = require('ethers');
const http = require('http');
const { assertRuntimeModeConfig, describeRuntimeMode } = require('./src/config/runtime-mode');
const { isPrivateOrWildcardMultiaddr } = require('./src/utils/multiaddr');
const { closeQueueResources, reconnectRedis } = require('./aggregator/queue');
const readiness = require('./src/observability/readiness');
const canaryEvents = require('./src/observability/canary-events');

const VERSION = "1.0.1";
const VENOM_REGISTRY_ADDRESS = process.env.VENOM_REGISTRY_ADDRESS;
const REQUIRED_ENV = [
  "RPC_URL",
  "VENOM_REGISTRY_ADDRESS",
  "PILOT_ESCROW_ADDRESS",
  "OPERATOR_PRIVATE_KEY"
];
const ALLOW_PRIVATE_MULTIADDR = process.env.VENOM_ALLOW_PRIVATE_MULTIADDR === "true";

let p2pNode = null;
let producerHandle = null;
let workerHandle = null;
let runtimeModeConfig = null;
let httpServer = null;
let canaryEventsHandle = null;

function validateEnv() {
  runtimeModeConfig = assertRuntimeModeConfig(process.env);

  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  // Operator runtime must not have access to deployer key
  if (process.env.DEPLOYER_PRIVATE_KEY) {
    throw new Error(
      "DEPLOYER_PRIVATE_KEY must not be set in the operator process. Use OPERATOR_PRIVATE_KEY only. " +
      "If you just finished deploying, comment out or remove DEPLOYER_PRIVATE_KEY from .env, then run " +
      "docker compose up -d --force-recreate venom-node."
    );
  }
}

function getOperatorPrivateKey() {
  return process.env.OPERATOR_PRIVATE_KEY;
}

async function shutdown(signal) {
  console.log(`\n${signal} received, shutting down VENOM Node (HTTP server: ${httpServer ? 'stopping' : 'not running'})...`);
  let exitCode = 0;
  try {
    if (canaryEventsHandle && typeof canaryEventsHandle.stop === 'function') canaryEventsHandle.stop();
    if (workerHandle) await workerHandle.close();
    if (producerHandle?.stop) producerHandle.stop();
    if (p2pNode) await p2pNode.stop();
    if (httpServer) {
      await new Promise(resolve => httpServer.close(resolve));
    }
    await closeQueueResources();
  } catch (error) {
    exitCode = 1;
    console.error("Shutdown error:", error);
  }
  setTimeout(() => process.exit(exitCode), 100);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

function startHealthServer({ getDeps, version = VERSION, port, host, logger = console.log } = {}) {
  const effectivePort = Number(port !== undefined ? port : (process.env.HEALTH_PORT || 3000));
  const effectiveHost = host !== undefined ? host : (process.env.HEALTH_HOST || '127.0.0.1');

  const server = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      let statusCode = 503;
      const body = {
        status: 'error',
        version,
        timestamp: new Date().toISOString(),
      };
      try {
        const deps = typeof getDeps === 'function' ? getDeps() : {};
        const redis = await readiness.probeRedis(deps.queueModule);
        if (redis.ok) {
          statusCode = 200;
          body.status = 'ok';
        } else {
          body.error = redis.reason || 'redis check failed';
        }
      } catch (err) {
        body.error = err.message;
      }
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    } else if (req.url === '/healthz') {
      let status;
      try {
        const deps = typeof getDeps === 'function' ? getDeps() : {};
        status = await readiness.computeAsync({ ...deps, version });
      } catch (err) {
        status = {
          ok: false,
          version,
          timestamp: new Date().toISOString(),
          checks: {},
          error: err.message,
        };
      }
      res.writeHead(status.ok ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
    } else if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`VENOM Node v${version}`);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(effectivePort, effectiveHost, () => {
    const boundPort = (server.address() && server.address().port) || effectivePort;
    logger(`[Health] Server listening on http://${effectiveHost}:${boundPort}`);
  });

  return server;
}

function warnPrivateMultiaddrOverride(multiaddr) {
  console.warn("[P2P] VENOM_ALLOW_PRIVATE_MULTIADDR=true: registering a private or non-public multiaddr.");
  console.warn("[P2P] This is intended only for solo test setups and must not be used for production pilots.");
  console.warn(`[P2P] Selected non-public multiaddr: ${multiaddr}`);
}

async function main() {
  validateEnv();
  const { startP2PNode, refreshActiveOracles } = require('./aggregator/p2p');
  const { startProducer } = require('./aggregator/producer');
  const { startWorker } = require('./aggregator/worker');

  console.log(`Starting VENOM Node v${VERSION}...`);
  console.log(`Runtime guardrails: ${describeRuntimeMode(runtimeModeConfig)}`);

  const rpcUrls = (process.env.RPC_URLS || process.env.RPC_URL || "https://base-sepolia-rpc.publicnode.com")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);

  const MultiRpcProvider = require('./rpc/router');
  const multiProvider = new MultiRpcProvider(rpcUrls);
  const provider = multiProvider.getProvider();
  const wallet = new ethers.Wallet(getOperatorPrivateKey(), provider);

  const registry = new ethers.Contract(VENOM_REGISTRY_ADDRESS, [
    "function isActiveOracle(address) view returns (bool)",
    "function registerOracle(string) payable",
    "function MIN_STAKE() view returns (uint256)"
  ], wallet);

  const isRegistered = await registry.isActiveOracle(wallet.address);
  const stakeAmount = await registry.MIN_STAKE();

  let registeredMultiaddr = null;

  if (!isRegistered) {
    console.log("Starting P2P node for registration...");
    p2pNode = await startP2PNode(wallet);

    const multiaddrs = p2pNode.getMultiaddrs();

    // Try env override first
    if (process.env.PUBLIC_MULTIADDR) {
      registeredMultiaddr = process.env.PUBLIC_MULTIADDR;
      console.log(`Using PUBLIC_MULTIADDR from env: ${registeredMultiaddr}`);
      if (ALLOW_PRIVATE_MULTIADDR && isPrivateOrWildcardMultiaddr(registeredMultiaddr)) {
        warnPrivateMultiaddrOverride(registeredMultiaddr);
      }
    } else {
      const reachable = multiaddrs.filter(m => !isPrivateOrWildcardMultiaddr(m));
      if (reachable.length === 0) {
        if (ALLOW_PRIVATE_MULTIADDR && multiaddrs.length > 0) {
          const privateMultiaddr = multiaddrs.find(m => m.toString().includes('/tcp/')) || multiaddrs[0];
          registeredMultiaddr = privateMultiaddr.toString();
          warnPrivateMultiaddrOverride(registeredMultiaddr);
        } else {
          await p2pNode.stop();
          p2pNode = null;
          throw new Error(
            "No public multiaddr found. Set PUBLIC_MULTIADDR env var or configure port forwarding. " +
            "For solo non-production tests only, set VENOM_ALLOW_PRIVATE_MULTIADDR=true to register a private multiaddr. " +
            "libp2p returned: " + multiaddrs.map(m => m.toString()).join(', ')
          );
        }
      } else {
        const publicMultiaddr = reachable.find(m => m.toString().includes('/tcp/')) || reachable[0];
        registeredMultiaddr = publicMultiaddr.toString();
        console.log(`Auto-detected public multiaddr: ${registeredMultiaddr}`);
      }
    }

    console.log(`Registering node with multiaddr: ${registeredMultiaddr}`);

    try {
      const tx = await registry.registerOracle(registeredMultiaddr, { value: stakeAmount });
      await tx.wait();
      await refreshActiveOracles();
      console.log(`Successfully registered with multiaddr: ${registeredMultiaddr}`);
    } catch (err) {
      console.error("Registration failed, cleaning up P2P node...", err.message);
      await p2pNode.stop();
      p2pNode = null;
      throw err;
    }
  } else {
    console.log("Already registered");
    if (!p2pNode) {
      p2pNode = await startP2PNode(wallet);
    }
  }

  // Give gossipsub mesh time to converge before workers publish signatures
  await new Promise(r => setTimeout(r, 15000));

  console.log("\nStarting Producer, Worker, and P2P mesh...");
  producerHandle = await startProducer();
  workerHandle = await startWorker();

  console.log(`\nVENOM Node v${VERSION} is fully operational.`);
}

if (require.main === module) {
  main().then(() => {
    const queueModule = require('./aggregator/queue');
    const p2pModule = require('./aggregator/p2p');
    const producerModule = require('./aggregator/producer');
    const getDeps = () => ({
      p2pNode,
      p2pStatus: typeof p2pModule.getNodeStatus === 'function' ? p2pModule.getNodeStatus() : null,
      workerHandle,
      producerHandle,
      producerStatus: typeof producerModule.getProducerStatus === 'function' ? producerModule.getProducerStatus() : null,
      queueModule,
    });
    httpServer = startHealthServer({ getDeps, version: VERSION });
    canaryEventsHandle = canaryEvents.startFromEnv({
      getDeps: () => ({ ...getDeps(), version: VERSION }),
    });
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  validateEnv,
  getOperatorPrivateKey,
  shutdown,
  startHealthServer,
  VERSION
};
