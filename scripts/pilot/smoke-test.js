#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

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
  configErrorToText,
} = require('./cist/config');

function makeSkeletonPhaseResult(phase) {
  return createPhaseResult(phase.index, STATE.SKIP, {
    durationMs: 0,
    notes: ['CLI skeleton placeholder; component behavior is implemented in later CIST phases.'],
  });
}

function makeSkippedPhaseResult(phase, triggerPhase) {
  const reason = triggerPhase.state === STATE.SKIP ? 'did not pass' : 'failed';
  return createPhaseResult(phase.index, STATE.SKIP, {
    durationMs: 0,
    codes: [],
    notes: [`Skipped because ${triggerPhase.name} ${reason}.`],
  });
}

function cascadeRest(results, triggerPhase, sliceFrom, sliceTo = PHASES.length - 1) {
  for (const phase of PHASES.slice(sliceFrom, sliceTo)) {
    results.push(makeSkippedPhaseResult(phase, triggerPhase));
  }
}

function finalize(results) {
  return {
    phases: results,
    releaseReadiness: {
      unresolved: results.flatMap((phase) => phase.releaseReadiness?.unresolved ?? []),
    },
  };
}

async function finalizeWithReportTeardown(context, options, results) {
  const phase8 = await runReportTeardown(context, options);
  results.push(phase8);
  return finalize(results);
}

async function runCistPhases(context, options = {}) {
  const results = [];

  const phase1 = await runConfigPreflight(context, {
    env: options.env || process.env,
  });
  results.push(phase1);

  if (phase1.state === STATE.FAIL) {
    cascadeRest(results, phase1, results.length);
    return finalizeWithReportTeardown(context, options, results);
  }

  const phase2 = await runChainBinding(context, {
    provider: options.provider,
    escrowAddress: options.escrowAddress,
    registryAddress: options.registryAddress,
  });
  results.push(phase2);

  if (phase2.state === STATE.FAIL) {
    cascadeRest(results, phase2, results.length);
    return finalizeWithReportTeardown(context, options, results);
  }

  const phase3 = await runRedisPreflight(context, {
    redisClient: options.redisClient,
    queue: options.queue,
  });
  results.push(phase3);

  if (phase3.state === STATE.FAIL) {
    cascadeRest(results, phase3, results.length);
    return finalizeWithReportTeardown(context, options, results);
  }

  const phase4 = await runMlServicePreflight(context, {
    mlClient: options.mlClient,
  });
  results.push(phase4);

  if (phase4.state === STATE.FAIL) {
    cascadeRest(results, phase4, results.length);
    return finalizeWithReportTeardown(context, options, results);
  }

  const phase5 = await runPayloadResolution(context, {
    payloadSource: options.payloadSource,
  });
  results.push(phase5);

  if (phase5.state === STATE.FAIL) {
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

  if (phase6.state === STATE.FAIL) {
    cascadeRest(results, phase6, results.length);
    return finalizeWithReportTeardown(context, options, results);
  }

  if (phase6.state !== STATE.PASS) {
    for (const phase of PHASES.slice(results.length, PHASES.length - 1)) {
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
    const { phases, releaseReadiness } = await runCistPhases(context, { env });
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

    const hasRealFail = phases.some((phase) => phase.state === STATE.FAIL);
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
  displayPath,
  printDefaultOutput,
  minimalFatalJson,
  printFatalError,
  main,
};	
