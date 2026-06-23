const promClient = require('prom-client');
const http = require('node:http');

const register = new promClient.Registry();

const workerJobsTotal = new promClient.Counter({
  name: 'venom_worker_jobs_total',
  help: 'Total worker jobs processed',
  labelNames: ['status'],
  registers: [register]
});

const p2pMeshPeers = new promClient.Gauge({
  name: 'venom_p2p_mesh_peers',
  help: 'Current gossipsub mesh peers',
  registers: [register]
});

const rpcFailoverCount = new promClient.Counter({
  name: 'venom_rpc_failover_count',
  help: 'Number of RPC provider failovers',
  registers: [register]
});

const mlServiceLatency = new promClient.Histogram({
  name: 'venom_ml_service_latency_ms',
  help: 'ML service request latency in ms',
  buckets: [100, 500, 1000, 3000, 5000, 10000],
  registers: [register]
});

const closeSubmissionsTotal = new promClient.Counter({
  name: 'venom_close_submissions_total',
  help: 'Total closeCampaign submissions',
  labelNames: ['outcome'],
  registers: [register]
});

let metricsServer = null;

function initMetrics(options = {}) {
  const port = Number(process.env.METRICS_PORT) || 9090;
  const host = process.env.METRICS_HOST || '127.0.0.1';

  promClient.collectDefaultMetrics({ register });

  metricsServer = http.createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.setHeader('Content-Type', register.contentType);
      res.end(await register.metrics());
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  metricsServer.listen(port, host, () => {
    console.log(`Metrics server listening on ${host}:${port}/metrics`);
  });

  return {
    stop() {
      if (metricsServer) {
        metricsServer.close();
        metricsServer = null;
      }
    }
  };
}

function getMetricsRegistry() {
  return register;
}

function recordWorkerJob(status) {
  workerJobsTotal.inc({ status });
}

function updateP2PMeshPeers(count) {
  p2pMeshPeers.set(count);
}

function recordRpcFailover() {
  rpcFailoverCount.inc();
}

function recordMLLatency(durationMs) {
  mlServiceLatency.observe(durationMs);
}

function recordCloseSubmission(outcome) {
  closeSubmissionsTotal.inc({ outcome });
}

module.exports = {
  initMetrics,
  getMetricsRegistry,
  recordWorkerJob,
  updateP2PMeshPeers,
  recordRpcFailover,
  recordMLLatency,
  recordCloseSubmission
};
