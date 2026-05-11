'use strict';

const DEFAULT_REDIS_TIMEOUT_MS = 1000;

function safeCall(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function checkLibp2p(p2pNode, p2pStatus) {
  if ((!p2pNode || !p2pNode.peerId) && !p2pStatus) {
    return { ok: false, reason: 'p2p node not started' };
  }
  const peerId = p2pStatus?.peerId || safeCall(() => p2pNode.peerId.toString(), null);
  const peers = Number.isFinite(p2pStatus?.peerCount)
    ? p2pStatus.peerCount
    : typeof p2pNode?.getPeers === 'function'
    ? safeCall(() => p2pNode.getPeers().length, 0)
    : 0;
  const result = {
    ok: Boolean(peerId) && p2pStatus?.started !== false && p2pStatus?.quorumConstantsLoaded !== false,
    peerId,
    peers,
  };
  if (p2pStatus) {
    result.started = p2pStatus.started;
    result.quorumConstantsLoaded = p2pStatus.quorumConstantsLoaded;
    result.activeOracleCount = p2pStatus.activeOracleCount;
    result.pendingCampaignCount = p2pStatus.pendingCampaignCount;
  }
  if (!result.ok && !result.reason) {
    result.reason = p2pStatus?.quorumConstantsLoaded === false
      ? 'p2p quorum constants not loaded'
      : 'p2p node not started';
  }
  return result;
}

function checkWorker(workerHandle) {
  if (!workerHandle) {
    return { ok: false, reason: 'worker not started' };
  }
  const name = safeCall(() => workerHandle.name, null);
  const running = typeof workerHandle.isRunning === 'function'
    ? safeCall(() => workerHandle.isRunning(), true)
    : true;
  return { ok: Boolean(running), name };
}

function checkProducer(producerHandle, producerStatus) {
  if (!producerHandle && !producerStatus) {
    return { ok: false, reason: 'producer not started' };
  }
  if (producerStatus) {
    return {
      ok: producerStatus.running !== false,
      running: producerStatus.running,
      lastScannedBlock: producerStatus.lastScannedBlock,
      lastScanAt: producerStatus.lastScanAt,
      lastScanError: producerStatus.lastScanError,
    };
  }
  return { ok: typeof producerHandle.stop === 'function' };
}

function compute({ p2pNode, p2pStatus, workerHandle, producerHandle, producerStatus, version, now } = {}) {
  const checks = {
    libp2p: checkLibp2p(p2pNode, p2pStatus),
    worker: checkWorker(workerHandle),
    producer: checkProducer(producerHandle, producerStatus),
  };
  const ok = Object.values(checks).every((check) => check && check.ok);
  const timestamp = typeof now === 'function' ? now() : (now || Date.now());
  return {
    ok,
    version: version || null,
    timestamp: new Date(timestamp).toISOString(),
    checks,
  };
}

async function probeRedis(queueModule, timeoutMs = DEFAULT_REDIS_TIMEOUT_MS) {
  if (!queueModule || typeof queueModule.getConnection !== 'function') {
    return { ok: false, reason: 'queue module not provided' };
  }

  let connection;
  try {
    connection = queueModule.getConnection();
  } catch (error) {
    return { ok: false, reason: `getConnection threw: ${error.message}` };
  }

  let timer;
  try {
    await Promise.race([
      connection.ping(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('redis ping timeout')), timeoutMs);
      }),
    ]);
    return { ok: true, status: safeCall(() => connection.status, 'unknown') };
  } catch (error) {
    return { ok: false, reason: error.message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function computeAsync(deps = {}) {
  const status = compute(deps);
  status.checks.redis = await probeRedis(deps.queueModule, deps.redisTimeoutMs);
  status.ok = status.ok && status.checks.redis.ok;
  return status;
}

module.exports = {
  DEFAULT_REDIS_TIMEOUT_MS,
  compute,
  probeRedis,
  computeAsync,
};
