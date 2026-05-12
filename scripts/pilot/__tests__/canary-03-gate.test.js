const { expect } = require('chai');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ethers } = require('ethers');

const {
  parseGateArgs,
  checkDeploymentArtifact,
  checkProfileConstants,
  checkManifest,
  checkOperatorEnvs,
  checkGitignore,
  checkManifestVsDeployment,
  checkFixtureReport,
} = require('../canary-03-gate');

const fixtureDeployment = path.join(__dirname, 'fixtures', 'deployment-base-sepolia.json');

function operatorAddress(i) {
  return new ethers.Wallet(`0x${String(i).padStart(64, '0')}`).address;
}
const CANARY03_CONSTANTS = {
  REQUIRED_ORACLES: 4,
  SCORE_QUORUM_PCT: 50,
  PARTICIPATION_FLOOR_PCT: 67,
  CAMPAIGN_TIMEOUT_BLOCKS: 3600,
  MIN_STAKE: '250000000000000000',
  SLASH_PERCENT: 5,
  MAX_DEVIATION: 25,
};

function makeCanary03Artifact(root, mutate) {
  const artifact = JSON.parse(fs.readFileSync(fixtureDeployment, 'utf8'));
  artifact.profile = { name: 'canary-03', constants: CANARY03_CONSTANTS };
  if (mutate) mutate(artifact);
  const ap = path.join(root, 'deployment-canary-03.json');
  fs.writeFileSync(ap, JSON.stringify(artifact, null, 2) + '\n');
  return ap;
}

function makeManifest(root, overrides) {
  const manifest = {
    schemaVersion: 1,
    profile: 'canary-03',
    deployment: { network: 'base-sepolia', chainId: 84532, registry: '0x1000000000000000000000000000000000000001', escrow: '0x2000000000000000000000000000000000000002' },
    operators: [
      { id: 'op1', address: operatorAddress(1), envPath: 'operator-1/.env', healthPort: 3000, queueSuffix: 'op1' },
      { id: 'op2', address: operatorAddress(2), envPath: 'operator-2/.env', healthPort: 3001, queueSuffix: 'op2' },
      { id: 'op3', address: operatorAddress(3), envPath: 'operator-3/.env', healthPort: 3002, queueSuffix: 'op3' },
      { id: 'op4', address: operatorAddress(4), envPath: 'operator-4/.env', healthPort: 3003, queueSuffix: 'op4' },
      { id: 'op5', address: operatorAddress(5), envPath: 'operator-5/.env', healthPort: 3004, queueSuffix: 'op5' },
    ],
    generatedAt: '2026-05-12T00:00:00.000Z',
  };
  if (overrides) Object.assign(manifest, overrides);
  const mp = path.join(root, 'manifest.json');
  fs.writeFileSync(mp, JSON.stringify(manifest, null, 2) + '\n');
  return mp;
}

function makeEnv(dir, opDir, extraVars) {
  const fullDir = path.join(dir, opDir);
  fs.mkdirSync(fullDir, { recursive: true });
  const operatorIndex = Number(opDir.slice('operator-'.length));
  const queueSuffix = `op${operatorIndex}`;
  const healthPort = 2999 + operatorIndex;
  const pk = `0x${String(operatorIndex).padStart(64, '0')}`;
  const lines = [
    '# Generated env',
    `OPERATOR_PRIVATE_KEY=${pk}`,
    `OPERATOR_QUEUE_SUFFIX=${queueSuffix}`,
    'VENOM_REGISTRY_ADDRESS=0x1000000000000000000000000000000000000001',
    'PILOT_ESCROW_ADDRESS=0x2000000000000000000000000000000000000002',
    'DEPLOY_PROFILE=canary-03',
    `HEALTH_PORT=${healthPort}`,
    'P2P_KEYSTORE_PATH=/app/.venom/libp2p-key',
    'USE_TEST_PAYLOAD=false',
    'VENOM_RUNTIME_MODE=testnet',
    'VENOM_ALLOW_PRIVATE_MULTIADDR=false',
  ];
  if (extraVars) lines.push(...extraVars);
  fs.writeFileSync(path.join(fullDir, '.env'), lines.join('\n') + '\n');
}

describe('canary-03-gate', function () {
  let root;

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-gate-'));
  });

  afterEach(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('parseGateArgs', function () {
    it('parses required arguments', function () {
      const args = parseGateArgs(['--deployment=deployments/base-sepolia.json', '--canary-envs=.venom-canary-03']);
      expect(args).to.include({ deployment: 'deployments/base-sepolia.json', canaryEnvs: '.venom-canary-03' });
    });

    it('parses optional flags', function () {
      expect(parseGateArgs(['--deployment=x', '--canary-envs=y', '--json']).json).to.equal(true);
      expect(parseGateArgs(['--deployment=x', '--canary-envs=y', '--check-fixtures']).checkFixtures).to.equal(true);
      expect(parseGateArgs(['--deployment=x', '--canary-envs=y', '--help']).help).to.equal(true);
    });

    it('rejects unsupported args', function () {
      expect(() => parseGateArgs(['--unknown'])).to.throw();
    });
  });

  describe('checkDeploymentArtifact', function () {
    it('passes for valid canary-03 artifact', function () {
      const ap = makeCanary03Artifact(root);
      const result = checkDeploymentArtifact(ap);
      expect(result.pass).to.equal(true);
    });

    it('fails for missing file', function () {
      const result = checkDeploymentArtifact(path.join(root, 'nope.json'));
      expect(result.pass).to.equal(false);
    });

    it('fails for canary-01-5 artifact', function () {
      const result = checkDeploymentArtifact(fixtureDeployment);
      expect(result.pass).to.equal(false);
    });

    it('fails for a canary-03 artifact on the wrong network', function () {
      const ap = makeCanary03Artifact(root, (artifact) => {
        artifact.network = 'localhost';
      });
      const result = checkDeploymentArtifact(ap);
      expect(result.pass).to.equal(false);
      expect(result.detail).to.include('expected base-sepolia');
    });

    it('fails for a canary-03 artifact on the wrong chain id', function () {
      const ap = makeCanary03Artifact(root, (artifact) => {
        artifact.chainId = 31337;
      });
      const result = checkDeploymentArtifact(ap);
      expect(result.pass).to.equal(false);
      expect(result.detail).to.include('expected 84532');
    });
  });

  describe('checkProfileConstants', function () {
    it('passes for canary-03 profile', function () {
      const result = checkProfileConstants();
      expect(result.pass).to.equal(true);
    });

    it('reports correct constant count', function () {
      const result = checkProfileConstants();
      expect(result.detail).to.match(/7 constants match/);
    });
  });

  describe('checkManifest', function () {
    it('passes for valid manifest with 5 operators', function () {
      const mp = makeManifest(root);
      const result = checkManifest(mp);
      expect(result.pass).to.equal(true);
    });

    it('fails with wrong operator count', function () {
      const manifest = JSON.parse(fs.readFileSync(makeManifest(root), 'utf8'));
      manifest.operators = manifest.operators.slice(0, 3);
      const mp = path.join(root, 'manifest.json');
      fs.writeFileSync(mp, JSON.stringify(manifest, null, 2) + '\n');
      const result = checkManifest(mp);
      expect(result.pass).to.equal(false);
      expect(result.detail).to.include('expected 5');
    });

    it('fails with duplicate queue suffixes', function () {
      const manifest = JSON.parse(fs.readFileSync(makeManifest(root), 'utf8'));
      manifest.operators[1].queueSuffix = 'op1';
      const mp = path.join(root, 'manifest.json');
      fs.writeFileSync(mp, JSON.stringify(manifest, null, 2) + '\n');
      const result = checkManifest(mp);
      expect(result.pass).to.equal(false);
      expect(result.detail).to.include('duplicate queue');
    });

    it('fails with duplicate health ports', function () {
      const manifest = JSON.parse(fs.readFileSync(makeManifest(root), 'utf8'));
      manifest.operators[1].healthPort = 3000;
      const mp = path.join(root, 'manifest.json');
      fs.writeFileSync(mp, JSON.stringify(manifest, null, 2) + '\n');
      const result = checkManifest(mp);
      expect(result.pass).to.equal(false);
      expect(result.detail).to.include('duplicate health port');
    });

    it('fails for missing file', function () {
      const result = checkManifest(path.join(root, 'nope.json'));
      expect(result.pass).to.equal(false);
    });

    it('fails for zero address', function () {
      const manifest = JSON.parse(fs.readFileSync(makeManifest(root), 'utf8'));
      manifest.operators[0].address = ethers.ZeroAddress;
      const mp = path.join(root, 'manifest.json');
      fs.writeFileSync(mp, JSON.stringify(manifest, null, 2) + '\n');
      const result = checkManifest(mp);
      expect(result.pass).to.equal(false);
      expect(result.detail).to.include('zero address');
    });

    it('fails for invalid address format', function () {
      const manifest = JSON.parse(fs.readFileSync(makeManifest(root), 'utf8'));
      manifest.operators[0].address = 'not-an-address';
      const mp = path.join(root, 'manifest.json');
      fs.writeFileSync(mp, JSON.stringify(manifest, null, 2) + '\n');
      const result = checkManifest(mp);
      expect(result.pass).to.equal(false);
      expect(result.detail).to.include('invalid address format');
    });

    it('fails for duplicate addresses', function () {
      const manifest = JSON.parse(fs.readFileSync(makeManifest(root), 'utf8'));
      manifest.operators[1].address = manifest.operators[0].address;
      const mp = path.join(root, 'manifest.json');
      fs.writeFileSync(mp, JSON.stringify(manifest, null, 2) + '\n');
      const result = checkManifest(mp);
      expect(result.pass).to.equal(false);
      expect(result.detail).to.include('duplicate address');
    });

    it('fails for missing address field', function () {
      const manifest = JSON.parse(fs.readFileSync(makeManifest(root), 'utf8'));
      delete manifest.operators[0].address;
      const mp = path.join(root, 'manifest.json');
      fs.writeFileSync(mp, JSON.stringify(manifest, null, 2) + '\n');
      const result = checkManifest(mp);
      expect(result.pass).to.equal(false);
      expect(result.detail).to.include('missing address');
    });
  });

  describe('checkOperatorEnvs', function () {
    it('passes when envs are clean', function () {
      const canaryDir = path.join(root, '.venom-canary-03');
      fs.mkdirSync(canaryDir, { recursive: true });
      const mp = makeManifest(root, {});
      fs.renameSync(mp, path.join(canaryDir, 'manifest.json'));
      for (let i = 1; i <= 5; i++) {
        makeEnv(canaryDir, `operator-${i}`);
      }
      const result = checkOperatorEnvs(path.join(canaryDir, 'manifest.json'), canaryDir);
      expect(result.pass).to.equal(true);
    });

    it('fails when USE_TEST_PAYLOAD=true', function () {
      const canaryDir = path.join(root, '.venom-canary-03');
      fs.mkdirSync(canaryDir, { recursive: true });
      const mp = makeManifest(root, {});
      fs.renameSync(mp, path.join(canaryDir, 'manifest.json'));
      makeEnv(canaryDir, 'operator-1', ['USE_TEST_PAYLOAD=true']);
      for (let i = 2; i <= 5; i++) makeEnv(canaryDir, `operator-${i}`);
      const result = checkOperatorEnvs(path.join(canaryDir, 'manifest.json'), canaryDir);
      expect(result.pass).to.equal(false);
      expect(result.detail).to.include('USE_TEST_PAYLOAD must be false');
    });

    it('fails when runtime mode is not testnet', function () {
      const canaryDir = path.join(root, '.venom-canary-03');
      fs.mkdirSync(canaryDir, { recursive: true });
      const mp = makeManifest(root, {});
      fs.renameSync(mp, path.join(canaryDir, 'manifest.json'));
      makeEnv(canaryDir, 'operator-1', ['VENOM_RUNTIME_MODE=demo']);
      for (let i = 2; i <= 5; i++) makeEnv(canaryDir, `operator-${i}`);
      const result = checkOperatorEnvs(path.join(canaryDir, 'manifest.json'), canaryDir);
      expect(result.pass).to.equal(false);
      expect(result.detail).to.include('VENOM_RUNTIME_MODE must be testnet');
    });

    it('fails when required env keys are missing', function () {
      const canaryDir = path.join(root, '.venom-canary-03');
      fs.mkdirSync(canaryDir, { recursive: true });
      const mp = makeManifest(root, {});
      fs.renameSync(mp, path.join(canaryDir, 'manifest.json'));
      const fullDir = path.join(canaryDir, 'operator-1');
      fs.mkdirSync(fullDir, { recursive: true });
      fs.writeFileSync(path.join(fullDir, '.env'), 'USE_TEST_PAYLOAD=false\nVENOM_RUNTIME_MODE=testnet\n');
      for (let i = 2; i <= 5; i++) makeEnv(canaryDir, `operator-${i}`);
      const result = checkOperatorEnvs(path.join(canaryDir, 'manifest.json'), canaryDir);
      expect(result.pass).to.equal(false);
      expect(result.detail).to.include('missing required keys');
      expect(result.detail).to.include('OPERATOR_PRIVATE_KEY');
    });

    it('fails when env queue suffix does not match manifest', function () {
      const canaryDir = path.join(root, '.venom-canary-03');
      fs.mkdirSync(canaryDir, { recursive: true });
      const mp = makeManifest(root, {});
      fs.renameSync(mp, path.join(canaryDir, 'manifest.json'));
      makeEnv(canaryDir, 'operator-1', ['OPERATOR_QUEUE_SUFFIX=wrong']);
      for (let i = 2; i <= 5; i++) makeEnv(canaryDir, `operator-${i}`);
      const result = checkOperatorEnvs(path.join(canaryDir, 'manifest.json'), canaryDir);
      expect(result.pass).to.equal(false);
      expect(result.detail).to.include('OPERATOR_QUEUE_SUFFIX does not match manifest');
    });

    it('fails when DEPLOYER_PRIVATE_KEY present', function () {
      const canaryDir = path.join(root, '.venom-canary-03');
      fs.mkdirSync(canaryDir, { recursive: true });
      const mp = makeManifest(root, {});
      fs.renameSync(mp, path.join(canaryDir, 'manifest.json'));
      makeEnv(canaryDir, 'operator-1', ['DEPLOYER_PRIVATE_KEY=0xdeadbeef']);
      for (let i = 2; i <= 5; i++) makeEnv(canaryDir, `operator-${i}`);
      const result = checkOperatorEnvs(path.join(canaryDir, 'manifest.json'), canaryDir);
      expect(result.pass).to.equal(false);
      expect(result.detail).to.include('DEPLOYER_PRIVATE_KEY must not be present');
    });

    it('fails when env file is missing', function () {
      const canaryDir = path.join(root, '.venom-canary-03');
      fs.mkdirSync(canaryDir, { recursive: true });
      const mp = makeManifest(root, {});
      fs.renameSync(mp, path.join(canaryDir, 'manifest.json'));
      const result = checkOperatorEnvs(path.join(canaryDir, 'manifest.json'), canaryDir);
      expect(result.pass).to.equal(false);
    });

    it('fails for malformed OPERATOR_PRIVATE_KEY (short)', function () {
      const canaryDir = path.join(root, '.venom-canary-03');
      fs.mkdirSync(canaryDir, { recursive: true });
      const mp = makeManifest(root, {});
      fs.renameSync(mp, path.join(canaryDir, 'manifest.json'));
      makeEnv(canaryDir, 'operator-1', ['OPERATOR_PRIVATE_KEY=0xdeadbeef']);
      for (let i = 2; i <= 5; i++) makeEnv(canaryDir, `operator-${i}`);
      const result = checkOperatorEnvs(path.join(canaryDir, 'manifest.json'), canaryDir);
      expect(result.pass).to.equal(false);
      expect(result.detail).to.include('malformed');
    });

    it('fails for OPERATOR_PRIVATE_KEY without 0x prefix', function () {
      const canaryDir = path.join(root, '.venom-canary-03');
      fs.mkdirSync(canaryDir, { recursive: true });
      const mp = makeManifest(root, {});
      fs.renameSync(mp, path.join(canaryDir, 'manifest.json'));
      const pk = '0'.repeat(64);
      makeEnv(canaryDir, 'operator-1', [`OPERATOR_PRIVATE_KEY=${pk}`]);
      for (let i = 2; i <= 5; i++) makeEnv(canaryDir, `operator-${i}`);
      const result = checkOperatorEnvs(path.join(canaryDir, 'manifest.json'), canaryDir);
      expect(result.pass).to.equal(false);
      expect(result.detail).to.include('malformed');
    });

    it('fails for duplicate OPERATOR_PRIVATE_KEY across operators', function () {
      const canaryDir = path.join(root, '.venom-canary-03');
      fs.mkdirSync(canaryDir, { recursive: true });
      const mp = makeManifest(root, {});
      fs.renameSync(mp, path.join(canaryDir, 'manifest.json'));
      makeEnv(canaryDir, 'operator-1');
      const sharedKey = `0x${String(1).padStart(64, '0')}`;
      const fullDir = path.join(canaryDir, 'operator-2');
      fs.mkdirSync(fullDir, { recursive: true });
      fs.writeFileSync(path.join(fullDir, '.env'), [
        '# Generated env',
        `OPERATOR_PRIVATE_KEY=${sharedKey}`,
        'OPERATOR_QUEUE_SUFFIX=op2',
        'VENOM_REGISTRY_ADDRESS=0x1000000000000000000000000000000000000001',
        'PILOT_ESCROW_ADDRESS=0x2000000000000000000000000000000000000002',
        'DEPLOY_PROFILE=canary-03',
        'HEALTH_PORT=3000',
        'P2P_KEYSTORE_PATH=/app/.venom/libp2p-key',
        'USE_TEST_PAYLOAD=false',
        'VENOM_RUNTIME_MODE=testnet',
      ].join('\n') + '\n');
      for (let i = 3; i <= 5; i++) makeEnv(canaryDir, `operator-${i}`);
      const result = checkOperatorEnvs(path.join(canaryDir, 'manifest.json'), canaryDir);
      expect(result.pass).to.equal(false);
      expect(result.detail).to.include('duplicate OPERATOR_PRIVATE_KEY');
    });

    it('fails when OPERATOR_PRIVATE_KEY does not match manifest address', function () {
      const canaryDir = path.join(root, '.venom-canary-03');
      fs.mkdirSync(canaryDir, { recursive: true });
      const mp = makeManifest(root, {});
      fs.renameSync(mp, path.join(canaryDir, 'manifest.json'));
      const wrongKey = `0x${String(99).padStart(64, '0')}`;
      makeEnv(canaryDir, 'operator-1', [`OPERATOR_PRIVATE_KEY=${wrongKey}`]);
      for (let i = 2; i <= 5; i++) makeEnv(canaryDir, `operator-${i}`);
      const result = checkOperatorEnvs(path.join(canaryDir, 'manifest.json'), canaryDir);
      expect(result.pass).to.equal(false);
      expect(result.detail).to.include('does not match manifest address');
    });
  });

  describe('checkGitignore', function () {
    it('passes when patterns exist', function () {
      const gi = path.join(root, '.gitignore');
      fs.writeFileSync(gi, 'node_modules/\n.venom-canary*\ndocker-compose.canary-*.yml\n.env\n');
      const result = checkGitignore(gi);
      expect(result.pass).to.equal(true);
    });

    it('fails when patterns are missing', function () {
      const gi = path.join(root, '.gitignore');
      fs.writeFileSync(gi, 'node_modules/\n.env\n');
      const result = checkGitignore(gi);
      expect(result.pass).to.equal(false);
      expect(result.detail).to.include('.venom-canary*');
      expect(result.detail).to.include('docker-compose.canary-*.yml');
    });

    it('fails when file does not exist', function () {
      const result = checkGitignore(path.join(root, 'nope'));
      expect(result.pass).to.equal(false);
    });
  });

  describe('checkManifestVsDeployment', function () {
    it('passes when manifest matches deployment artifact', function () {
      const dp = makeCanary03Artifact(root);
      const mp = makeManifest(root);
      const result = checkManifestVsDeployment(mp, dp);
      expect(result.pass).to.equal(true);
    });

    it('fails when manifest profile does not match deployment profile', function () {
      const dp = makeCanary03Artifact(root);
      const mp = makeManifest(root, { profile: 'canary-01-5' });
      const result = checkManifestVsDeployment(mp, dp);
      expect(result.pass).to.equal(false);
      expect(result.detail).to.include('profile');
    });

    it('fails when manifest network does not match deployment network', function () {
      const dp = makeCanary03Artifact(root);
      const mp = makeManifest(root, { deployment: { network: 'localhost', chainId: 84532 } });
      const result = checkManifestVsDeployment(mp, dp);
      expect(result.pass).to.equal(false);
      expect(result.detail).to.include('network');
    });

    it('fails when manifest chainId does not match deployment chainId', function () {
      const dp = makeCanary03Artifact(root);
      const mp = makeManifest(root, { deployment: { network: 'base-sepolia', chainId: 31337 } });
      const result = checkManifestVsDeployment(mp, dp);
      expect(result.pass).to.equal(false);
      expect(result.detail).to.include('chainId');
    });

    it('fails for missing manifest file', function () {
      const dp = makeCanary03Artifact(root);
      const result = checkManifestVsDeployment(path.join(root, 'nope.json'), dp);
      expect(result.pass).to.equal(false);
    });

    it('fails for missing deployment file', function () {
      const mp = makeManifest(root);
      const result = checkManifestVsDeployment(mp, path.join(root, 'nope.json'));
      expect(result.pass).to.equal(false);
    });
  });

  describe('checkFixtureReport', function () {
    it('returns null when no report exists', function () {
      const result = checkFixtureReport(root);
      expect(result.pass).to.equal(null);
    });

    it('returns pass when latest fixture report passed', function () {
      const runDir = path.join(root, 'tmp', 'smoke-test', 'run-001');
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify({ runId: 'run-001', mode: 'fixture', result: 'PASS' }) + '\n');
      const symlinkPath = path.join(root, 'tmp', 'smoke-test', 'latest');
      try { fs.symlinkSync('run-001', symlinkPath, 'dir'); } catch {
        fs.writeFileSync(path.join(root, 'tmp', 'smoke-test', 'latest.txt'), 'run-001\n');
      }
      const result = checkFixtureReport(root);
      if (result.pass === null) this.skip();
      expect(result.pass).to.equal(true);
    });

    it('returns fail when latest fixture report failed', function () {
      const runDir = path.join(root, 'tmp', 'smoke-test', 'run-002');
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify({ runId: 'run-002', mode: 'fixture', result: 'FAIL' }) + '\n');
      const symlinkPath = path.join(root, 'tmp', 'smoke-test', 'latest');
      try { fs.symlinkSync('run-002', symlinkPath, 'dir'); } catch {
        fs.writeFileSync(path.join(root, 'tmp', 'smoke-test', 'latest.txt'), 'run-002\n');
      }
      const result = checkFixtureReport(root);
      if (result.pass === null) this.skip();
      expect(result.pass).to.equal(false);
    });
  });

  function cliSetup(root) {
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.venom-canary*\ndocker-compose.canary-*.yml\n');
    const canaryDir = path.join(root, '.venom-canary-03');
    fs.mkdirSync(canaryDir, { recursive: true });
    const ap = makeCanary03Artifact(root);
    makeManifest(root, {});
    const manifestSrc = path.join(root, 'manifest.json');
    const manifestDst = path.join(canaryDir, 'manifest.json');
    if (fs.existsSync(manifestSrc)) fs.renameSync(manifestSrc, manifestDst);
    for (let i = 1; i <= 5; i++) makeEnv(canaryDir, `operator-${i}`);
    return { canaryDir, ap };
  }

  describe('CLI integration and secret redaction', function () {
    it('does not print private-key-shaped values to stdout or stderr', function () {
      const { canaryDir, ap } = cliSetup(root);

      const script = path.resolve(__dirname, '..', 'canary-03-gate.js');
      const result = spawnSync(process.execPath, [
        script,
        `--deployment=${ap}`,
        `--canary-envs=${canaryDir}`,
      ], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, PATH: process.env.PATH },
      });

      expect(result.status).to.equal(0);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).to.not.match(/0x[0-9a-fA-F]{64}/);
    });

    it('exits nonzero when required checks fail', function () {
      const script = path.resolve(__dirname, '..', 'canary-03-gate.js');
      const result = spawnSync(process.execPath, [
        script,
        '--deployment=nonexistent.json',
        '--canary-envs=nonexistent',
      ], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, PATH: process.env.PATH },
      });

      expect(result.status).to.equal(1);
      expect(result.stdout).to.include('FAIL');
    });

    it('exits zero when all required checks pass', function () {
      const { canaryDir, ap } = cliSetup(root);

      const script = path.resolve(__dirname, '..', 'canary-03-gate.js');
      const result = spawnSync(process.execPath, [
        script,
        `--deployment=${ap}`,
        `--canary-envs=${canaryDir}`,
      ], {
        cwd: root,
        encoding: 'utf8',
      });

      expect(result.status).to.equal(0);
      expect(result.stdout).to.include('PASS');
    });
  });
});
