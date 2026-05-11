'use strict';

const readiness = require('./readiness');

const ENV_VAR_NAME = 'CANARY_METRICS_INTERVAL_MS';
const MIN_INTERVAL_MS = 1000;

function start({ getDeps, intervalMs, logger = console.log, warn = console.warn } = {}) {
  if (typeof getDeps !== 'function') {
    throw new Error('canary-events.start requires getDeps to be a function');
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return null;
  }

  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const snapshot = await readiness.computeAsync(getDeps());
      logger(JSON.stringify({ kind: 'canary.metrics', ...snapshot }));
    } catch (error) {
      warn(`[Canary] Failed to emit metrics: ${error.message}`);
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
    async _tickForTesting() {
      await tick();
    },
  };
}

function startFromEnv({ getDeps, logger, warn = console.warn, env = process.env } = {}) {
  const raw = env[ENV_VAR_NAME];
  if (raw === undefined || raw === '' || raw === '0') return null;

  const intervalMs = Number(raw);
  if (!Number.isFinite(intervalMs) || intervalMs < MIN_INTERVAL_MS) {
    warn(
      `[Canary] ${ENV_VAR_NAME}=${raw} is invalid; must be an integer >= ${MIN_INTERVAL_MS}. ` +
      'Metrics emitter disabled.'
    );
    return null;
  }

  return start({ getDeps, intervalMs, logger, warn });
}

module.exports = {
  ENV_VAR_NAME,
  MIN_INTERVAL_MS,
  start,
  startFromEnv,
};
