#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Wallet } = require('ethers');

const { STATE, PHASES, createPhaseResult } = require('./cist/phases');
const { writeReports } = require('./cist/report');
const { updateLatestPointer } = require('./cist/latest');
const { renderExplainText } = require('./cist/explain');
const { runConfigPreflight } = require('./cist/phases/config-preflight');
const { runChainBinding } = require('./cist/phases/chain-binding');
const { runRedisPreflight } = require('./cist/phases/redis-preflight');
const { runMlServicePreflight } = require('./cist/phases/ml-service-preflight');
const { runPayloadResolution } = require('./cist/phases/payload-resolution');
const { runWorkerDecision } = require('./cist/phases/worker-decision');
const { runP2pAggregation } = require('./cist/phases/p2p-aggregation');
const { runReportTeardown } = require('./cist/phases/report-teardown');
const {
  buildRunContext,
  buildStrictRequirements,
  configErrorToText,
} = require('./cist/config');
const { SELECTORS } = require('./cist/phases/chain-binding');

const FIXTURE_ESCROW_ADDRESS = '0x1234567890123456789012345678901234567890';
const FIXTURE_REGISTRY_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const FIXTURE_ESCROW_BYTECODE =
  `0x608060405234801561001057600080fd5b5063${SELECTORS.OPERATOR_PAYOUT.slice(2)}600052`;
const FIXTURE_REGISTRY_BYTECODE =
  `0x608060405234801561001057600080fd5b5063${SELECTORS.UNSTAKE.slice(2)}600052`;
const FIXTURE_ORACLE_COUNT = 3;
const CORE_PHASES = PHASES.filter((phase) => phase.key !== 'canary');

function makeSkeletonPhaseResult(phase) {
  return createPhaseResult(phase.index, STATE.SKIP, {
    durationMs: 0,
    notes: ['CLI skeleton placeholder; component behavior is implemented in later CIST phases.'],
  });
}

function makeSkippedPhaseResult(phase, triggerPhase) {
  const reason = triggerPhase.state === STATE.SKIP ? 'did not pass' : 'failed';
  const triggerName = triggerPhase.skipReason || triggerPhase.name;
  return createPhaseResult(phase.index, STATE.SKIP, {
    durationMs: 0,
    codes: [],
    notes: [`Skipped because ${triggerName} ${reason}.`],
  });
}

function cascadeRest(results, triggerPhase, sliceFrom, sliceTo = CORE_PHASES.length - 1) {
  for (const phase of CORE_PHASES.slice(sliceFrom, sliceTo)) {
    results.push(makeSkippedPhaseResult(phase, triggerPhase));
  }
}

function effectiveState(phase, strict) {
  return strict && phase.state === STATE.WARN ? STATE.FAIL : phase.state;
}

function finalize(results) {
  return {
    phases: results,
    releaseReadiness: {
      unresolved: results.flatMap((phase) => phase.releaseReadiness?.unresolved ?? []),
    },
  };
}

function buildFixtureClientOptions(context) {
  return {
    provider: {
      getNetwork: async () => ({ chainId: 31337, name: 'hardhat' }),
      getCode: async (address) => {
        if (address === FIXTURE_ESCROW_ADDRESS) return FIXTURE_ESCROW_BYTECODE;
        if (address === FIXTURE_REGISTRY_ADDRESS) return FIXTURE_REGISTRY_BYTECODE;
        return '0x';
      },
    },
    escrowAddress: FIXTURE_ESCROW_ADDRESS,
    registryAddress: FIXTURE_REGISTRY_ADDRESS,
    redisClient: {
      ping: async () => 'PONG',
      keys: async () => [],
    },
    queue: {
      name: 'cist-fixture-queue',
      add: async () => ({ id: `${context.runId}:queue-probe` }),
      close: async () => {},
    },
    mlClient: {
      health: async () => ({
        status: 'healthy',
        model_loaded: true,
        model_name: 'fixture-semantic-model',
      }),
    },
    payloadSource: async () => ({
      campaignUid: `${context.runId}:campaign`,
      payload: 'fixture payload',
      reference_answer: 'fixture reference',
    }),
    worker: {
      process: async (job) => ({
        campaignUid: job.payload.campaignUid,
        decision: 'approve',
        score: 0.92,
        reason: 'fixture worker approved the payload',
      }),
    },
    oracleFactory: {
      createOracles: async ({ message }) => Array.from({ length: FIXTURE_ORACLE_COUNT }, (_, index) => {
        const wallet = Wallet.createRandom();
        return {
          sign: async () => ({
            oracleId: `fixture-oracle-${index + 1}`,
            address: wallet.address,
            signature: await wallet.signMessage(message),
          }),
        };
      }),
    },
    p2pQuorum: FIXTURE_ORACLE_COUNT,
  };
}

async function finalizeWithReportTeardown(context, options, results) {
  const phase8 = await runReportTeardown(context, options);
  results.push(phase8);
  return finalize(results);
}

async function runCistPhases(context, options = {}) {
  const results = [];
  const strict = context.strict === true;

  if (strict) {
    const missing = buildStrictRequirements({
      strict: true,
      provider: options.provider,
      redisClient: options.redisClient,
      queue: options.queue,
      mlClient: options.mlClient,
      payloadSource: options.payloadSource,
      worker: options.worker,
    });
    if (missing) {
      const phase1 = createPhaseResult(1, STATE.FAIL, {
        durationMs: 0,
        codes: ['STRICT_MODE_MISSING_CLIENTS'],
        skipReason: 'Strict mode dependency preflight',
        notes: [
          `strict mode requires all real clients. Missing: ${missing.join(', ')}.`,
          'Supply provider, redisClient, queue, mlClient, payloadSource, and worker options.',
        ],
      });
      results.push(phase1);
      cascadeRest(results, phase1, results.length);
      return finalizeWithReportTeardown(context, options, results);
    }
  }

  const phase1 = await runConfigPreflight(context, {
    env: options.env || process.env,
  });
  results.push(phase1);

  if (effectiveState(phase1, strict) === STATE.FAIL) {
    cascadeRest(results, phase1, results.length);
    return finalizeWithReportTeardown(context, options, results);
  }

  const phase2 = await runChainBinding(context, {
    provider: options.provider,
    escrowAddress: options.escrowAddress,
    registryAddress: options.registryAddress,
  });
  results.push(phase2);

  if (effectiveState(phase2, strict) === STATE.FAIL) {
    cascadeRest(results, phase2, results.length);
    return finalizeWithReportTeardown(context, options, results);
  }

  const phase3 = await runRedisPreflight(context, {
    redisClient: options.redisClient,
    queue: options.queue,
  });
  results.push(phase3);

  if (effectiveState(phase3, strict) === STATE.FAIL) {
    cascadeRest(results, phase3, results.length);
    return finalizeWithReportTeardown(context, options, results);
  }

  const phase4 = await runMlServicePreflight(context, {
    mlClient: options.mlClient,
  });
  results.push(phase4);

  if (effectiveState(phase4, strict) === STATE.FAIL) {
    cascadeRest(results, phase4, results.length);
    return finalizeWithReportTeardown(context, options, results);
  }

  const phase5 = await runPayloadResolution(context, {
    payloadSource: options.payloadSource,
  });
  results.push(phase5);

  if (effectiveState(phase5, strict) === STATE.FAIL) {
    cascadeRest(results, phase5, results.length);
    return finalizeWithReportTeardown(context, options, results);
  }

  const workerJob = phase5.payload && phase5.payload.loaded
    ? {
        id: `${context.runId}:worker-decision`,
        payload: phase5.payload.loaded,
      }
    : undefined;

  const phase6 = await runWorkerDecision(context, {
    worker: options.worker,
    job: workerJob,
    timeoutMs: options.workerDecisionTimeoutMs,
  });
  results.push(phase6);

  if (effectiveState(phase6, strict) === STATE.FAIL) {
    cascadeRest(results, phase6, results.length);
    return finalizeWithReportTeardown(context, options, results);
  }

  if (effectiveState(phase6, strict) !== STATE.PASS) {
    for (const phase of CORE_PHASES.slice(results.length, CORE_PHASES.length - 1)) {
      results.push(makeSkeletonPhaseResult(phase));
    }

    return finalizeWithReportTeardown(context, options, results);
  }

  const phase7 = await runP2pAggregation(context, {
    chainId: phase2.network && phase2.network.chainId,
    workerDecision: phase6.worker && phase6.worker.decision
      ? {
          decision: phase6.worker.decision,
          score: phase6.worker.score,
          reason: phase6.worker.reason,
        }
      : null,
    oracleFactory: options.oracleFactory,
    usesFixtureKeys: context.mode === 'fixture',
    quorum: options.p2pQuorum,
  });
  results.push(phase7);

  return finalizeWithReportTeardown(context, options, results);
}

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function displayPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function printDefaultOutput({ context, report, paths }) {
  const evidenceDir = displayPath(path.relative(process.cwd(), path.dirname(paths.jsonPath)));
  const jsonPath = displayPath(path.relative(process.cwd(), paths.jsonPath));
  const markdownPath = displayPath(path.relative(process.cwd(), paths.markdownPath));

  console.log('VENOM Component Integration Smoke Test');
  console.log('');
  console.log(`Mode:     ${report.mode}`);
  console.log(`Scenario: ${report.scenario}`);
  console.log(`Safety:   ${context.safety.line}`);
  console.log(`Run ID:   ${report.runId}`);
  console.log(`Evidence: ${evidenceDir}/`);
  console.log('');

  for (const phase of report.phases) {
    const label = `[${phase.index}/${PHASES.length}] ${phase.name}`.padEnd(48, ' ');
    console.log(`${label}${phase.state.padEnd(6, ' ')} ${formatSeconds(phase.durationMs)}`);

    if (phase.state === STATE.WARN || phase.state === STATE.FAIL || phase.state === STATE.SKIP) {
      for (const code of phase.codes) {
        console.log(`  Code: ${code}`);
      }
      for (const note of phase.notes) {
        console.log(`  Observed: ${note}`);
      }
    }
  }

  console.log('');
  console.log(`Lifecycle integration:    ${report.result}`);
  console.log(`Release-readiness probes: ${report.releaseReadiness.unresolved.length} unresolved`);

  if (report.releaseReadiness.unresolved.length > 0) {
    for (const code of report.releaseReadiness.unresolved) {
      console.log(`  - ${code}`);
    }
  }

  console.log('');
  console.log('Artifacts:');
  console.log(`  ${jsonPath}`);
  console.log(`  ${markdownPath}`);
  console.log('');
  console.log('Next suggested command:');
  console.log(`  cat ${markdownPath}`);
}

function minimalFatalJson(error) {
  return {
    schemaVersion: '1.1',
    result: 'FAIL',
    fatal: true,
    codes: [error.code || 'CIST_UNEXPECTED_ERROR'],
    reportWritten: false,
  };
}

function printFatalError(error, jsonMode) {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(minimalFatalJson(error))}\n`);
    return;
  }

  if (Array.isArray(error.details)) {
    process.stderr.write(configErrorToText(error));
    return;
  }

  process.stderr.write(`${error.message}\n`);
}

async function main(argv = process.argv.slice(2), env = process.env) {
  let context;

  try {
    context = buildRunContext({ argv, env });
  } catch (error) {
    const jsonMode = argv.includes('--json');
    printFatalError(error, jsonMode);
    process.exitCode = 1;
    return;
  }

  if (context.explain) {
    process.stdout.write(renderExplainText());
    return;
  }

  try {
    const fixtureOptions = context.withFixtureClients ? buildFixtureClientOptions(context) : {};
    const { phases, releaseReadiness } = await runCistPhases(context, {
      ...fixtureOptions,
      env,
    });
    const finishedAt = new Date();

    const reportParams = {
      runContext: context,
      phases,
      releaseReadiness,
      mode: context.mode,
      scenario: context.scenario,
      startedAt: context.startedAt,
      finishedAt,
      argv: context.argv,
      command: context.command,
    };

    const paths = writeReports(reportParams);

    updateLatestPointer({
      baseDir: context.baseDir,
      runId: context.runId,
      runDir: context.runDir,
    });

    const report = JSON.parse(fs.readFileSync(paths.jsonPath, 'utf8'));

    if (context.json) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else {
      printDefaultOutput({ context, report, paths });
    }

    const hasRealFail = phases.some((phase) =>
      effectiveState(phase, context.strict === true) === STATE.FAIL
    );
    process.exitCode = hasRealFail ? 1 : 0;
  } catch (error) {
    printFatalError(error, context.json);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  makeSkeletonPhaseResult,
  makeSkippedPhaseResult,
  cascadeRest,
  finalize,
  runCistPhases,
  effectiveState,
  displayPath,
  printDefaultOutput,
  minimalFatalJson,
  printFatalError,
  buildFixtureClientOptions,
  main,
};
