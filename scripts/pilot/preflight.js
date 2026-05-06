#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { Queue } = require('bullmq');
const { ethers } = require('ethers');
const IORedis = require('ioredis');

const rootEnvPath = path.join(__dirname, '..', '..', '.env');
require('dotenv').config({ path: rootEnvPath, quiet: true });

const { runCistPhases, displayPath, printFatalError } = require('./smoke-test');
const { buildRunContext, makeConfigError } = require('./cist/config');
const { STATE } = require('./cist/phases');
const { writeReports } = require('./cist/report');
const { updateLatestPointer } = require('./cist/latest');

const SUPPORTED_NETWORKS = Object.freeze({
  'base-sepolia': {
    chainId: 84532,
    name: 'base-sepolia',
  },
});

const REGISTRY_ABI = Object.freeze([
  'function activeOracleCount() view returns (uint256)',
  'function MIN_STAKE() view returns (uint256)',
  'function oracles(address) view returns (uint256 stake, bool active, uint256 registeredAt, string multiaddr)',
]);

const ESCROW_ABI = Object.freeze([
  'function REQUIRED_ORACLES() view returns (uint256)',
]);

const PREFLIGHT_DID_NOT_VERIFY = Object.freeze([
  'live funded bounty creation',
  'live close-or-cancel transaction submission',
  'operator payout distribution',
  'unstake lifecycle',
  'governance/tithe integration into closeCampaign',
  'multi-node gossip quorum beyond local operator signing',
]);

function parsePreflightArgs(argv = []) {
  const options = {
    network: 'base-sepolia',
    json: false,
    help: false,
    ipfsCid: null,
    ipfsSha256: null,
    skipP2pDialback: false,
    requireP2pDialback: false,
  };

  for (const arg of argv) {
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--skip-p2p-dialback') {
      options.skipP2pDialback = true;
    } else if (arg === '--require-p2p-dialback') {
      options.requireP2pDialback = true;
    } else if (arg.startsWith('--network=')) {
      options.network = arg.slice('--network='.length);
    } else if (arg.startsWith('--ipfs-cid=')) {
      options.ipfsCid = arg.slice('--ipfs-cid='.length);
    } else if (arg.startsWith('--ipfs-sha256=')) {
      options.ipfsSha256 = arg.slice('--ipfs-sha256='.length);
    } else {
      throw makeConfigError(
        'PREFLIGHT_UNSUPPORTED_ARGUMENT',
        `Unsupported preflight argument: ${arg}`,
        [
          'Supported examples:',
          '  npm run pilot:preflight -- --network=base-sepolia',
          '  npm run pilot:preflight -- --network=base-sepolia --json',
          '  npm run pilot:preflight -- --network=base-sepolia --skip-p2p-dialback',
          '  npm run pilot:preflight -- --network=base-sepolia --ipfs-cid=<cid> --ipfs-sha256=<sha256>',
        ]
      );
    }
  }

  if (!SUPPORTED_NETWORKS[options.network]) {
    throw makeConfigError(
      'PREFLIGHT_UNSUPPORTED_NETWORK',
      `Unsupported preflight network: ${options.network}`,
      [
        'Supported networks:',
        ...Object.keys(SUPPORTED_NETWORKS).map((network) => `  ${network}`),
      ]
    );
  }

  return options;
}

function renderHelp() {
  return [
    'VENOM live preflight',
    '',
    'Usage:',
    '  npm run pilot:preflight -- --network=base-sepolia',
    '',
    'Options:',
    '  --network=base-sepolia       Target live testnet network.',
    '  --json                       Print report.json to stdout.',
    '  --ipfs-cid=<cid>             Override PREFLIGHT_IPFS_CID.',
    '  --ipfs-sha256=<sha256>       Override PREFLIGHT_IPFS_SHA256.',
    '  --skip-p2p-dialback          Do not attempt optional external dial-back probe.',
    '  --require-p2p-dialback       Fail if no dial-back probe is configured or reachable.',
    '',
  ].join('\n');
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildRpcUrls(env) {
  return splitCsv(env.RPC_URLS || env.RPC_URL);
}

function buildIpfsGateways(env) {
  return splitCsv(env.IPFS_GATEWAYS);
}

function assertSha256(value) {
  if (!/^[a-fA-F0-9]{64}$/.test(String(value || ''))) {
    throw new Error('PREFLIGHT_IPFS_SHA256 must be a 64-character hex SHA-256 digest');
  }
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function normalizeGateway(gateway) {
  return gateway.replace(/\/+$/, '');
}

async function fetchWithTimeout(url, options = {}) {
  const {
    timeoutMs = 15000,
    fetchImpl = fetch,
    method = 'GET',
    headers,
    body,
  } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timeout.unref === 'function') timeout.unref();

  try {
    return await fetchImpl(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchGatewayBytes(gateway, cid, options = {}) {
  const response = await fetchWithTimeout(`${normalizeGateway(gateway)}/${cid}`, options);
  if (!response.ok) {
    throw new Error(`gateway returned HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function fetchCidRoundTrip(options = {}) {
  const {
    cid,
    expectedSha256,
    gateways,
    timeoutMs,
    fetchImpl,
  } = options;

  if (!cid) throw new Error('PREFLIGHT_IPFS_CID is required');
  assertSha256(expectedSha256);
  if (!Array.isArray(gateways) || gateways.length === 0) {
    throw new Error('IPFS_GATEWAYS must include at least one gateway');
  }

  const failures = [];
  const successes = [];
  let bytes = null;

  for (const gateway of gateways) {
    try {
      const fetched = await fetchGatewayBytes(gateway, cid, { timeoutMs, fetchImpl });
      const actualSha256 = sha256Hex(fetched);
      if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
        throw new Error('gateway bytes did not match expected SHA-256');
      }
      if (!bytes) bytes = fetched;
      successes.push({ gatewayConfigured: true, bytes: fetched.length });
    } catch (error) {
      failures.push({ gatewayConfigured: true, error: error.message });
    }
  }

  if (!successes.length) {
    throw new Error(`IPFS round-trip failed on all configured gateways (${failures.length} failures)`);
  }

  return {
    cid,
    bytes,
    sha256: expectedSha256.toLowerCase(),
    gatewaysConfigured: gateways.length,
    gatewaysSucceeded: successes.length,
    gatewaysFailed: failures.length,
  };
}

function createIpfsPayloadSource(context, options = {}) {
  const {
    env = process.env,
    ipfsCid,
    ipfsSha256,
    fetchImpl = fetch,
  } = options;

  return async () => {
    const roundTrip = await fetchCidRoundTrip({
      cid: ipfsCid || env.PREFLIGHT_IPFS_CID,
      expectedSha256: ipfsSha256 || env.PREFLIGHT_IPFS_SHA256,
      gateways: buildIpfsGateways(env),
      timeoutMs: Number(env.PREFLIGHT_IPFS_TIMEOUT_MS || env.IPFS_GATEWAY_TIMEOUT || 8000),
      fetchImpl,
    });

    return {
      campaignUid: `${context.runId}:live-preflight`,
      payload: 'VENOM live preflight IPFS round-trip payload verified.',
      reference_answer: env.PREFLIGHT_REFERENCE_ANSWER || 'VENOM live preflight IPFS round-trip payload verified.',
      ipfs: {
        cid: roundTrip.cid,
        bytes: roundTrip.bytes.length,
        sha256: roundTrip.sha256,
        gatewaysConfigured: roundTrip.gatewaysConfigured,
        gatewaysSucceeded: roundTrip.gatewaysSucceeded,
        gatewaysFailed: roundTrip.gatewaysFailed,
      },
    };
  };
}

function deriveHealthUrl(evaluateUrl) {
  const url = new URL(evaluateUrl);
  url.pathname = '/health';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function createMlHttpClient(env = process.env, options = {}) {
  const evaluateUrl = env.ML_SERVICE_URL || 'http://127.0.0.1:8000/evaluate';
  const healthUrl = env.ML_SERVICE_HEALTH_URL || deriveHealthUrl(evaluateUrl);
  const timeoutMs = Number(env.ML_TIMEOUT_MS || 30000);
  const fetchImpl = options.fetchImpl || fetch;
  const apiKey = env.ML_SERVICE_API_KEY || '';

  function headers(extra = {}) {
    return {
      ...extra,
      ...(apiKey ? { 'X-API-Key': apiKey } : {}),
    };
  }

  return {
    health: async () => {
      const response = await fetchWithTimeout(healthUrl, {
        timeoutMs,
        fetchImpl,
        headers: headers(),
      });
      if (!response.ok) {
        throw new Error(`ML health returned HTTP ${response.status}`);
      }
      return response.json();
    },
    evaluate: async (payload) => {
      const response = await fetchWithTimeout(evaluateUrl, {
        timeoutMs,
        fetchImpl,
        method: 'POST',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(`ML evaluate returned HTTP ${response.status}`);
      }
      return response.json();
    },
  };
}

function createMlWorker(mlClient) {
  return {
    process: async (job) => {
      const result = await mlClient.evaluate({
        payload: job.payload.payload,
        reference_answer: job.payload.reference_answer || '',
        campaign_uid: job.payload.campaignUid,
      });
      const finalScore = Number(result.final_score);
      const normalizedScore = Number.isFinite(finalScore)
        ? Math.max(0, Math.min(1, finalScore))
        : 0;

      return {
        campaignUid: job.payload.campaignUid,
        decision: result.passes_threshold ? 'approve' : 'reject',
        score: normalizedScore,
        reason: `ML preflight final_score=${normalizedScore.toFixed(4)} passes=${Boolean(result.passes_threshold)}`,
      };
    },
  };
}

function createOperatorOracleFactory(wallet) {
  return {
    createOracles: async ({ message }) => ([{
      sign: async () => ({
        oracleId: 'operator-wallet',
        address: wallet.address,
        signature: await wallet.signMessage(message),
      }),
    }]),
  };
}

function parseEtherEnv(env, name, fallback) {
  return ethers.parseEther(String(env[name] || fallback));
}

function formatEth(wei) {
  return ethers.formatEther(wei);
}

async function runP2pDialbackCheck(options = {}) {
  const {
    env = process.env,
    parsed = {},
    fetchImpl = fetch,
  } = options;

  const requireDialback = parsed.requireP2pDialback || env.PREFLIGHT_REQUIRE_P2P_DIALBACK === 'true';
  const publicMultiaddr = env.PUBLIC_MULTIADDR || '';
  const probeUrl = env.PREFLIGHT_P2P_DIALBACK_URL || '';

  if (parsed.skipP2pDialback) {
    return {
      state: STATE.PASS,
      codes: [],
      notes: ['P2P dial-back probe skipped by --skip-p2p-dialback.'],
      p2pDialback: { skipped: true },
    };
  }

  if (!publicMultiaddr || !probeUrl) {
    const code = requireDialback
      ? 'PREFLIGHT_P2P_DIALBACK_MISSING'
      : 'PREFLIGHT_P2P_DIALBACK_DEFERRED';
    return {
      state: requireDialback ? STATE.FAIL : STATE.WARN,
      codes: [code],
      notes: [
        'External P2P dial-back was not run; set PUBLIC_MULTIADDR and PREFLIGHT_P2P_DIALBACK_URL to enable it.',
      ],
      p2pDialback: {
        configured: false,
        publicMultiaddrSet: Boolean(publicMultiaddr),
        probeUrlSet: Boolean(probeUrl),
      },
    };
  }

  try {
    const url = new URL(probeUrl);
    url.searchParams.set('multiaddr', publicMultiaddr);
    const response = await fetchWithTimeout(url.toString(), {
      timeoutMs: Number(env.PREFLIGHT_P2P_DIALBACK_TIMEOUT_MS || 10000),
      fetchImpl,
    });
    if (!response.ok) {
      throw new Error(`dial-back probe returned HTTP ${response.status}`);
    }
    const body = await response.json();
    if (!body || body.reachable !== true) {
      throw new Error('dial-back probe did not report reachable=true');
    }
    return {
      state: STATE.PASS,
      codes: [],
      notes: ['External P2P dial-back probe reported reachable=true.'],
      p2pDialback: {
        configured: true,
        reachable: true,
        publicMultiaddrSet: true,
        probeUrlSet: true,
      },
    };
  } catch (error) {
    return {
      state: STATE.FAIL,
      codes: ['PREFLIGHT_P2P_DIALBACK_FAILED'],
      notes: [`External P2P dial-back failed: ${error.message}`],
      p2pDialback: {
        configured: true,
        reachable: false,
        publicMultiaddrSet: true,
        probeUrlSet: true,
      },
    };
  }
}

async function runLivePreflightGates(resources, options = {}) {
  const started = performance.now();
  const env = options.env || process.env;
  const parsed = options.parsed || {};
  const notes = [];
  const codes = [];
  const livePreflight = {
    activeOracleGate: {},
    operatorBalanceGate: {},
    p2pDialback: {},
  };

  try {
    const [
      requiredOraclesRaw,
      activeOracleCountRaw,
      minStake,
      operatorBalance,
      feeData,
      oracleRecord,
    ] = await Promise.all([
      resources.escrow.REQUIRED_ORACLES(),
      resources.registry.activeOracleCount(),
      resources.registry.MIN_STAKE(),
      resources.provider.getBalance(resources.wallet.address),
      resources.provider.getFeeData(),
      resources.registry.oracles(resources.wallet.address),
    ]);

    const requiredOracles = Number(requiredOraclesRaw);
    const activeOracleCount = Number(activeOracleCountRaw);
    livePreflight.activeOracleGate = {
      activeOracleCount,
      requiredOracles,
      pass: activeOracleCount >= requiredOracles,
    };

    if (activeOracleCount < requiredOracles) {
      codes.push('PREFLIGHT_ACTIVE_ORACLE_COUNT_LOW');
      notes.push(`Active oracle count ${activeOracleCount} is below REQUIRED_ORACLES ${requiredOracles}.`);
    }

    const closeGasLimit = BigInt(env.PREFLIGHT_CLOSE_GAS_LIMIT || env.CLOSE_GAS_LIMIT || 500000);
    const gasPrice = feeData.maxFeePerGas || feeData.gasPrice || ethers.parseUnits(
      String(env.PREFLIGHT_FALLBACK_GAS_PRICE_GWEI || '1'),
      'gwei'
    );
    const estimatedCloseGas = closeGasLimit * gasPrice;
    const buffer = parseEtherEnv(env, 'PREFLIGHT_BALANCE_BUFFER_ETH', '0.02');
    const oracleActive = Boolean(oracleRecord.active);
    const stakeNeeded = oracleActive ? 0n : minStake;
    const requiredBalance = stakeNeeded + estimatedCloseGas + buffer;

    livePreflight.operatorBalanceGate = {
      operator: resources.wallet.address,
      oracleActive,
      balanceEth: formatEth(operatorBalance),
      requiredBalanceEth: formatEth(requiredBalance),
      minStakeEth: formatEth(minStake),
      estimatedCloseGasEth: formatEth(estimatedCloseGas),
      bufferEth: formatEth(buffer),
      pass: operatorBalance >= requiredBalance,
    };

    if (operatorBalance < requiredBalance) {
      codes.push('PREFLIGHT_OPERATOR_BALANCE_LOW');
      notes.push('Operator wallet balance is below the stake/gas/buffer preflight requirement.');
    }

    const dialback = await runP2pDialbackCheck({ env, parsed, fetchImpl: options.fetchImpl });
    livePreflight.p2pDialback = dialback.p2pDialback;
    notes.push(...dialback.notes);
    codes.push(...dialback.codes);

    const hasFail = codes.some((code) => (
      code !== 'PREFLIGHT_P2P_DIALBACK_DEFERRED'
    ));
    const hasWarn = dialback.state === STATE.WARN;

    return {
      state: hasFail ? STATE.FAIL : (hasWarn ? STATE.WARN : STATE.PASS),
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      codes,
      notes,
      livePreflight,
    };
  } catch (error) {
    return {
      state: STATE.FAIL,
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      codes: ['PREFLIGHT_LIVE_GATE_UNEXPECTED'],
      notes: [`Live preflight gate failed unexpectedly: ${error.message}`],
      livePreflight,
    };
  }
}

function applyLivePreflightGates(phases, gateResult) {
  const phase7 = phases.find((phase) => phase.index === 7);
  if (!phase7) return phases;

  phase7.livePreflight = gateResult.livePreflight;
  phase7.notes.push(...gateResult.notes);
  for (const code of gateResult.codes) {
    if (!phase7.codes.includes(code)) {
      phase7.codes.push(code);
    }
  }

  if (gateResult.state === STATE.FAIL) {
    phase7.state = STATE.FAIL;
  } else if (gateResult.state === STATE.WARN && phase7.state === STATE.PASS) {
    phase7.state = STATE.WARN;
  }

  return phases;
}

function buildRedisConnection(env) {
  const redis = new IORedis({
    host: env.REDIS_HOST || '127.0.0.1',
    port: Number(env.REDIS_PORT || 6379),
    username: env.REDIS_USERNAME || undefined,
    password: env.REDIS_PASSWORD || undefined,
    tls: env.REDIS_TLS === 'true' ? {} : undefined,
    db: Number(env.CIST_REDIS_DB || 14),
    maxRetriesPerRequest: null,
  });
  redis.on('error', () => undefined);
  return redis;
}

function buildLiveClientOptions(context, parsed, env = process.env) {
  const rpcUrls = buildRpcUrls(env);
  if (!rpcUrls.length) {
    throw makeConfigError('CONFIG_ENV_MISSING', 'RPC_URL or RPC_URLS is required for live preflight');
  }

  const provider = new ethers.JsonRpcProvider(rpcUrls[0]);
  const wallet = new ethers.Wallet(env.OPERATOR_PRIVATE_KEY, provider);
  const registryAddress = ethers.getAddress(env.VENOM_REGISTRY_ADDRESS);
  const escrowAddress = ethers.getAddress(env.PILOT_ESCROW_ADDRESS);
  const registry = new ethers.Contract(registryAddress, REGISTRY_ABI, provider);
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, provider);
  const redisClient = buildRedisConnection(env);
  const queue = new Queue(env.QUEUE_NAME || 'venom-campaigns', { connection: redisClient });
  const mlClient = createMlHttpClient(env);

  return {
    provider,
    wallet,
    registry,
    escrow,
    redisClient,
    queue,
    mlClient,
    cistOptions: {
      provider,
      escrowAddress,
      registryAddress,
      redisClient,
      queue,
      mlClient,
      payloadSource: createIpfsPayloadSource(context, {
        env,
        ipfsCid: parsed.ipfsCid,
        ipfsSha256: parsed.ipfsSha256,
      }),
      worker: createMlWorker(mlClient),
      oracleFactory: createOperatorOracleFactory(wallet),
      p2pQuorum: 1,
    },
    close: async () => {
      try {
        await queue.close();
      } finally {
        try {
          await redisClient.quit();
        } catch {
          redisClient.disconnect();
        }
      }
    },
  };
}

function printPreflightOutput({ context, report, paths }) {
  const evidenceDir = displayPath(path.relative(process.cwd(), path.dirname(paths.jsonPath)));
  const markdownPath = displayPath(path.relative(process.cwd(), paths.markdownPath));

  console.log('VENOM Live Preflight');
  console.log('');
  console.log(`Network:  ${context.preflight.network}`);
  console.log(`Run ID:   ${report.runId}`);
  console.log(`Evidence: ${evidenceDir}/`);
  console.log('');
  for (const phase of report.phases) {
    console.log(`[${phase.index}] ${phase.name}: ${phase.state}`);
    for (const code of phase.codes) {
      console.log(`  Code: ${code}`);
    }
  }
  console.log('');
  console.log(`Preflight result: ${report.result}`);
  console.log(`Report: ${markdownPath}`);
}

async function main(argv = process.argv.slice(2), env = process.env) {
  let parsed;
  let context;
  let resources;

  try {
    parsed = parsePreflightArgs(argv);
    if (parsed.help) {
      process.stdout.write(renderHelp());
      return;
    }

    context = buildRunContext({
      argv: ['--mode=live-testnet', '--confirm-live-testnet'],
      env,
      baseDir: path.join(process.cwd(), 'tmp', 'preflight'),
    });
    context.command = 'npm run pilot:preflight';
    context.argv = [...argv];
    context.preflight = {
      network: parsed.network,
      chainId: SUPPORTED_NETWORKS[parsed.network].chainId,
      readOnly: true,
    };
    context.safety = {
      touchesLiveState: true,
      maySpendTestnetEth: false,
      fixtureKeysAllowed: false,
      line: 'live preflight uses real clients and live reads, but does not submit transactions.',
    };

    resources = buildLiveClientOptions(context, parsed, env);
    const { phases, releaseReadiness } = await runCistPhases(context, {
      ...resources.cistOptions,
      env,
    });

    const hasBlockingPhase = phases.some((phase) => phase.state === STATE.FAIL || phase.state === STATE.SKIP);
    if (!hasBlockingPhase) {
      const gateResult = await runLivePreflightGates(resources, { env, parsed });
      applyLivePreflightGates(phases, gateResult);
    }

    const finishedAt = new Date();
    const paths = writeReports({
      runContext: context,
      phases,
      releaseReadiness,
      mode: context.mode,
      scenario: context.scenario,
      startedAt: context.startedAt,
      finishedAt,
      argv: context.argv,
      command: context.command,
      didNotVerify: PREFLIGHT_DID_NOT_VERIFY,
    });

    updateLatestPointer({
      baseDir: context.baseDir,
      runId: context.runId,
      runDir: context.runDir,
    });

    const report = JSON.parse(fs.readFileSync(paths.jsonPath, 'utf8'));
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else {
      printPreflightOutput({ context, report, paths });
    }
    process.exitCode = report.result === STATE.PASS ? 0 : 1;
  } catch (error) {
    printFatalError(error, Boolean(parsed && parsed.json));
    process.exitCode = 1;
  } finally {
    if (resources && typeof resources.close === 'function') {
      await resources.close();
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  SUPPORTED_NETWORKS,
  PREFLIGHT_DID_NOT_VERIFY,
  parsePreflightArgs,
  renderHelp,
  buildRpcUrls,
  buildIpfsGateways,
  sha256Hex,
  fetchCidRoundTrip,
  createIpfsPayloadSource,
  deriveHealthUrl,
  createMlHttpClient,
  createMlWorker,
  createOperatorOracleFactory,
  runP2pDialbackCheck,
  runLivePreflightGates,
  applyLivePreflightGates,
  buildLiveClientOptions,
  main,
};
