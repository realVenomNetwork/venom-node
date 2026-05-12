#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');

const { validateDeploymentArtifact } = require('./make-operator-envs');
const { PROFILE_CONSTANTS } = require('./profiles');

const CANARY03 = 'canary-03';
const EXPECTED_NETWORK = 'base-sepolia';
const EXPECTED_CHAIN_ID = 84532;
const EXPECTED_OPERATOR_COUNT = 5;
const REQUIRED_KEYS = ['OPERATOR_PRIVATE_KEY', 'OPERATOR_QUEUE_SUFFIX', 'VENOM_REGISTRY_ADDRESS', 'PILOT_ESCROW_ADDRESS', 'DEPLOY_PROFILE', 'HEALTH_PORT', 'P2P_KEYSTORE_PATH'];
const FORBIDDEN_IN_ENVS = ['DEPLOYER_PRIVATE_KEY'];
const TEST_PAYLOAD_KEY = 'USE_TEST_PAYLOAD';
const GITIGNORE_PATTERNS = ['.venom-canary*', 'docker-compose.canary-*.yml'];
const PRIVATE_KEY_RE = /0x[a-fA-F0-9]{64}/;
const SECRET_REDACTED = '[REDACTED]';

function redactIfNeeded(value) {
  if (!value || typeof value !== 'string') return value;
  if (PRIVATE_KEY_RE.test(value)) return SECRET_REDACTED;
  return value;
}

function parseGateArgs(argv) {
  const opts = { deployment: null, canaryEnvs: null, json: false, help: false, checkFixtures: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--check-fixtures') opts.checkFixtures = true;
    else if (arg.startsWith('--deployment=')) opts.deployment = arg.slice('--deployment='.length);
    else if (arg.startsWith('--canary-envs=')) opts.canaryEnvs = arg.slice('--canary-envs='.length);
    else throw new Error(`GATE_UNSUPPORTED_ARG: ${arg}`);
  }
  return opts;
}

function renderHelp() {
  return [
    'Canary 03 Preflight Evidence Gate',
    '',
    'Usage:',
    '  npm run pilot:canary03-gate -- --deployment=<path> --canary-envs=<dir>',
    '',
    'Options:',
    '  --deployment=<path>     Deployment artifact from deploy:phase4.',
    '  --canary-envs=<dir>     Generated operator env output directory.',
    '  --check-fixtures        Also verify the latest fixture smoke-test report passed.',
    '  --json                  Print JSON result to stdout.',
    '  --help, -h              Show this help.',
    '',
  ].join('\n');
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    throw new Error(`Cannot read ${path.basename(filePath)}: ${e.message}`);
  }
}

function checkDeploymentArtifact(artifactPath) {
  try {
    const artifact = readJson(artifactPath);
    const deployment = validateDeploymentArtifact(artifact, CANARY03);
    if (deployment.network !== EXPECTED_NETWORK) {
      return { pass: false, detail: `network=${deployment.network} (expected ${EXPECTED_NETWORK})` };
    }
    if (deployment.chainId !== EXPECTED_CHAIN_ID) {
      return { pass: false, detail: `chainId=${deployment.chainId} (expected ${EXPECTED_CHAIN_ID})` };
    }
    return { pass: true, detail: `network=${deployment.network}, chainId=${deployment.chainId}, profile=${CANARY03}` };
  } catch (e) {
    return { pass: false, detail: e.message };
  }
}

function checkProfileConstants() {
  try {
    const constants = PROFILE_CONSTANTS[CANARY03];
    if (!constants) return { pass: false, detail: `profile ${CANARY03} not found in profiles.js` };
    const expected = {
      REQUIRED_ORACLES: '4',
      SCORE_QUORUM_PCT: '50',
      PARTICIPATION_FLOOR_PCT: '67',
      CAMPAIGN_TIMEOUT_BLOCKS: '3600',
      MIN_STAKE: '250000000000000000',
      SLASH_PERCENT: '5',
      MAX_DEVIATION: '25',
    };
    const mismatches = [];
    for (const [key, val] of Object.entries(expected)) {
      if (String(constants[key]) !== val) {
        mismatches.push(`${key}=${constants[key]} (expected ${val})`);
      }
    }
    if (mismatches.length) return { pass: false, detail: mismatches.join('; ') };
    return { pass: true, detail: `${Object.keys(expected).length} constants match` };
  } catch (e) {
    return { pass: false, detail: e.message };
  }
}

function checkManifest(manifestPath) {
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (e) {
    return { pass: false, detail: e.message };
  }
  if (!manifest || typeof manifest !== 'object') return { pass: false, detail: 'manifest.json is not a JSON object' };
  if (!Array.isArray(manifest.operators)) return { pass: false, detail: 'manifest.operators is not an array' };

  const ops = manifest.operators;
  const issues = [];

  if (ops.length !== EXPECTED_OPERATOR_COUNT) {
    issues.push(`expected ${EXPECTED_OPERATOR_COUNT} operators, got ${ops.length}`);
  }

  const suffixes = new Set();
  const ports = new Set();
  const addresses = new Set();

  for (const op of ops) {
    if (!op.id || !op.queueSuffix || !Number.isFinite(op.healthPort)) {
      issues.push(`${op.id || 'unknown'}: missing id, queueSuffix, or healthPort`);
    }
    if (!op.address) {
      issues.push(`${op.id || 'unknown'}: missing address`);
    } else {
      try {
        const normalized = ethers.getAddress(op.address);
        if (normalized === ethers.ZeroAddress) {
          issues.push(`${op.id}: address is zero address (${ethers.ZeroAddress})`);
        }
        if (addresses.has(normalized)) {
          issues.push(`duplicate address: ${normalized}`);
        }
        addresses.add(normalized);
      } catch (e) {
        issues.push(`${op.id}: invalid address format ${op.address}: ${e.message}`);
      }
    }
    if (suffixes.has(op.queueSuffix)) issues.push(`duplicate queue suffix: ${op.queueSuffix}`);
    suffixes.add(op.queueSuffix);
    if (ports.has(op.healthPort)) issues.push(`duplicate health port: ${op.healthPort}`);
    ports.add(op.healthPort);
  }

  if (issues.length) return { pass: false, detail: issues.join('; ') };
  return { pass: true, detail: `${ops.length} operators, ${suffixes.size} queues, ${ports.size} ports, ${addresses.size} addresses` };
}

function parseEnvFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const vars = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return vars;
}

function checkOperatorEnvs(manifestPath, canaryEnvsDir) {
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (e) {
    return { pass: false, detail: e.message };
  }
  if (!Array.isArray(manifest.operators)) return { pass: true, detail: 'no operators to check' };

  const envIssues = [];
  const resolvedCanaryDir = path.resolve(canaryEnvsDir);
  const privateKeys = {};

  for (const op of manifest.operators) {
    if (!op.envPath) { envIssues.push(`${op.id}: missing envPath`); continue; }
    const envFile = path.resolve(resolvedCanaryDir, op.envPath);
    if (!envFile.startsWith(resolvedCanaryDir + path.sep)) {
      envIssues.push(`${op.id}: envPath escapes canary env directory`);
      continue;
    }
    if (!fs.existsSync(envFile)) { envIssues.push(`${op.id}: ${op.envPath} not found`); continue; }

    let vars;
    try {
      vars = parseEnvFile(envFile);
    } catch (e) {
      envIssues.push(`${op.id}: cannot read env: ${e.message}`);
      continue;
    }

    const missingKeys = REQUIRED_KEYS.filter((key) => !vars[key]);
    if (missingKeys.length) envIssues.push(`${op.id}: missing required keys: ${missingKeys.join(', ')}`);

    if (vars.VENOM_RUNTIME_MODE !== 'testnet') {
      envIssues.push(`${op.id}: VENOM_RUNTIME_MODE must be testnet`);
    }
    if (vars.DEPLOY_PROFILE !== CANARY03) {
      envIssues.push(`${op.id}: DEPLOY_PROFILE must be ${CANARY03}`);
    }
    if (vars[TEST_PAYLOAD_KEY] !== 'false') {
      envIssues.push(`${op.id}: USE_TEST_PAYLOAD must be false (got ${vars[TEST_PAYLOAD_KEY] || 'unset'})`);
    }
    if (vars.OPERATOR_QUEUE_SUFFIX && op.queueSuffix && vars.OPERATOR_QUEUE_SUFFIX !== op.queueSuffix) {
      envIssues.push(`${op.id}: OPERATOR_QUEUE_SUFFIX does not match manifest`);
    }
    if (vars.HEALTH_PORT && Number(vars.HEALTH_PORT) !== op.healthPort) {
      envIssues.push(`${op.id}: HEALTH_PORT does not match manifest`);
    }
    for (const forbidden of FORBIDDEN_IN_ENVS) {
      if (forbidden in vars) envIssues.push(`${op.id}: ${forbidden} must not be present`);
    }

    const pk = vars.OPERATOR_PRIVATE_KEY;
    if (!pk || !/^0x[a-fA-F0-9]{64}$/.test(pk)) {
      envIssues.push(`${op.id}: OPERATOR_PRIVATE_KEY missing or malformed (expected 0x + 64 hex chars)`);
    } else {
      if (privateKeys[pk]) {
        envIssues.push(`${op.id}: duplicate OPERATOR_PRIVATE_KEY (also used by ${privateKeys[pk]})`);
      }
      privateKeys[pk] = op.id;

      if (op.address) {
        try {
          const derived = new ethers.Wallet(pk).address;
          if (derived.toLowerCase() !== op.address.toLowerCase()) {
            envIssues.push(`${op.id}: OPERATOR_PRIVATE_KEY derived address ${derived} does not match manifest address ${op.address}`);
          }
        } catch (e) {
          envIssues.push(`${op.id}: OPERATOR_PRIVATE_KEY is not a valid key: ${e.message}`);
        }
      }
    }
  }

  if (envIssues.length) return { pass: false, detail: envIssues.join('; ') };
  return { pass: true, detail: `${manifest.operators.length} envs clean` };
}

function checkGitignore(gitignorePath) {
  if (!fs.existsSync(gitignorePath)) return { pass: false, detail: '.gitignore not found' };
  const content = fs.readFileSync(gitignorePath, 'utf8');
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const missing = GITIGNORE_PATTERNS.filter((p) => !lines.some((l) => l === p || l.startsWith(p)));
  if (missing.length) return { pass: false, detail: `missing patterns: ${missing.join(', ')}` };
  return { pass: true, detail: `${GITIGNORE_PATTERNS.length} patterns found` };
}

function checkManifestVsDeployment(manifestPath, deploymentPath) {
  let manifest, deployment;
  try {
    manifest = readJson(manifestPath);
    deployment = readJson(deploymentPath);
  } catch (e) {
    return { pass: false, detail: e.message };
  }
  const issues = [];
  if (manifest.profile !== deployment.profile?.name) {
    issues.push(`manifest profile="${manifest.profile}", deployment profile="${deployment.profile?.name}"`);
  }
  if (manifest.deployment?.network !== deployment.network) {
    issues.push(`manifest network="${manifest.deployment?.network}", deployment network="${deployment.network}"`);
  }
  if (manifest.deployment?.chainId !== deployment.chainId) {
    issues.push(`manifest chainId=${manifest.deployment?.chainId}, deployment chainId=${deployment.chainId}`);
  }
  if (issues.length) return { pass: false, detail: issues.join('; ') };
  return { pass: true, detail: 'manifest matches deployment artifact' };
}

function checkFixtureReport(cwd) {
  const baseDir = path.join(cwd, 'tmp', 'smoke-test');
  const symlinkPath = path.join(baseDir, 'latest');
  const textPath = path.join(baseDir, 'latest.txt');

  let runDir = null;
  if (fs.existsSync(symlinkPath)) {
    try {
      const target = fs.readlinkSync(symlinkPath);
      runDir = path.isAbsolute(target) ? target : path.join(baseDir, target);
    } catch { runDir = symlinkPath; }
  } else if (fs.existsSync(textPath)) {
    const runId = fs.readFileSync(textPath, 'utf8').trim();
    runDir = path.join(baseDir, runId);
  }

  if (!runDir || !fs.existsSync(runDir)) return { pass: null, detail: 'no fixture smoke-test report found' };

  const reportPath = path.join(runDir, 'report.json');
  if (!fs.existsSync(reportPath)) return { pass: null, detail: 'report.json not found in latest run' };

  try {
    const report = readJson(reportPath);
    if (report.mode !== 'fixture') return { pass: null, detail: 'latest report is not a fixture run' };
    if (report.result === 'PASS') return { pass: true, detail: `fixture run ${report.runId}: PASS` };
    return { pass: false, detail: `fixture run ${report.runId}: ${report.result} (see ${reportPath})` };
  } catch (e) {
    return { pass: null, detail: `could not read fixture report: ${e.message}` };
  }
}

function runAllChecks(opts, cwd) {
  const deploymentPath = path.resolve(cwd, opts.deployment);
  const canaryEnvsDir = path.resolve(cwd, opts.canaryEnvs);
  const manifestPath = path.join(canaryEnvsDir, 'manifest.json');
  const gitignorePath = path.join(cwd, '.gitignore');

  const checks = [
    { key: 'deployment', name: 'deployment artifact valid for canary-03', required: true, run: () => checkDeploymentArtifact(deploymentPath) },
    { key: 'profile_constants', name: 'profile constants match source of truth', required: true, run: checkProfileConstants },
    { key: 'manifest', name: `operator count is ${EXPECTED_OPERATOR_COUNT}, unique queues, ports, addresses`, required: true, run: () => checkManifest(manifestPath) },
    { key: 'manifest_deployment', name: 'manifest matches deployment artifact', required: true, run: () => checkManifestVsDeployment(manifestPath, deploymentPath) },
    { key: 'env_audit', name: 'operator envs clean (USE_TEST_PAYLOAD, DEPLOYER_PRIVATE_KEY)', required: true, run: () => checkOperatorEnvs(manifestPath, canaryEnvsDir) },
    { key: 'gitignore', name: '.gitignore protects canary artifacts', required: true, run: () => checkGitignore(gitignorePath) },
  ];

  if (opts.checkFixtures) {
    checks.push({ key: 'fixture_report', name: 'latest fixture smoke-test report passed', required: false, run: () => checkFixtureReport(cwd) });
  }

  const results = checks.map((c) => {
    try {
      const r = c.run();
      return { key: c.key, name: c.name, required: c.required, pass: r.pass, detail: redactIfNeeded(r.detail) };
    } catch (e) {
      return { key: c.key, name: c.name, required: c.required, pass: false, detail: e.message };
    }
  });

  return results;
}

function formatTable(results, opts) {
  const lines = [];
  lines.push('=== Canary 03 Preflight Evidence Gate ===');
  lines.push('');
  lines.push(`  deployment:  ${opts.deployment}`);
  lines.push(`  canary envs: ${opts.canaryEnvs}`);
  if (opts.checkFixtures) lines.push('  fixtures:    checking latest report');
  lines.push('');

  const nameW = 52;
  const reqW = 8;
  const sep = '  ' + '-'.repeat(nameW + reqW + 9 + 4);

  lines.push(`  ${'CHECK'.padEnd(nameW)} ${'REQ'.padEnd(reqW)} STATUS  DETAIL`);
  lines.push(sep);

  for (const r of results) {
    const name = r.name.length > nameW ? r.name.slice(0, nameW - 3) + '...' : r.name;
    const req = r.required ? 'yes' : 'no';
    const status = r.pass === null ? 'SKIP' : r.pass ? 'PASS' : 'FAIL';
    const detail = r.detail ? r.detail.slice(0, 50) : '';
    lines.push(`  ${name.padEnd(nameW)} ${req.padEnd(reqW)} ${status.padEnd(6)} ${detail}`);
  }
  lines.push(sep);
  lines.push('');

  const requiredPass = results.filter((r) => r.required).every((r) => r.pass === true);
  const exitCode = requiredPass ? 0 : 1;

  lines.push(`  Required checks: ${requiredPass ? 'PASS' : 'FAIL'}   exit code: ${exitCode}`);
  if (!requiredPass) lines.push('  Fix failures above before proceeding with Canary 03.');
  lines.push('');

  return { text: lines.join('\n'), exitCode };
}

async function main(argv, cwd) {
  let opts;
  try {
    opts = parseGateArgs(argv);
  } catch (e) {
    process.stderr.write(`[GATE_CONFIG_ERROR] ${e.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (opts.help) {
    process.stdout.write(renderHelp());
    return;
  }

  try {
    const results = runAllChecks(opts, cwd);
    const { text, exitCode } = formatTable(results, opts);

    if (opts.json) {
      const out = {
        gate: 'canary-03',
        passed: results.filter((r) => r.required).every((r) => r.pass === true),
        checks: results.map((r) => ({
          key: r.key, name: r.name, required: r.required,
          pass: r.pass, detail: r.detail,
        })),
      };
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    } else {
      process.stdout.write(text);
    }

    process.exitCode = exitCode;
  } catch (e) {
    process.stderr.write(`[GATE_ERROR] ${e.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2), process.cwd());
}

module.exports = {
  parseGateArgs,
  renderHelp,
  checkDeploymentArtifact,
  checkProfileConstants,
  checkManifest,
  checkOperatorEnvs,
  checkGitignore,
  checkManifestVsDeployment,
  checkFixtureReport,
  runAllChecks,
  formatTable,
  main,
};
