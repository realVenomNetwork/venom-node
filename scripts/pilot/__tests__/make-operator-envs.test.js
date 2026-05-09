const { expect } = require('chai');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ethers } = require('ethers');

const {
  MakeEnvsError,
  parseArgs,
  validateDeploymentArtifact,
  shouldSkipRegistryDialForProfile,
  buildBootstrapPeerString,
  buildOperatorEnv,
  generateOperatorFiles,
} = require('../make-operator-envs');

const fixtureDeployment = path.join(__dirname, 'fixtures', 'deployment-base-sepolia.json');
const fixedDate = new Date('2026-05-08T09:00:00.000Z');

function walletFactory(index) {
  return new ethers.Wallet(`0x${String(index).padStart(64, '0')}`);
}

describe('make-operator-envs', function () {
  let root;

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-operator-envs-'));
  });

  afterEach(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('parses required arguments and rejects unsupported values', function () {
    expect(parseArgs([
      '--count=5',
      '--deployment=deployments/base-sepolia.json',
      '--out=.venom-canary',
      '--profile=canary-01-5',
      '--health-port-base=3100',
      '--force',
    ])).to.include({
      count: 5,
      deployment: 'deployments/base-sepolia.json',
      out: '.venom-canary',
      profile: 'canary-01-5',
      healthPortBase: 3100,
      force: true,
    });

    expect(() => parseArgs(['--unknown'])).to.throw(MakeEnvsError).with.property('code', 'MAKE_ENVS_BAD_ARG');
    expect(() => parseArgs(['--count=1', '--deployment=x', '--out=y'])).to.throw(MakeEnvsError).with.property('code', 'MAKE_ENVS_BAD_ARG');
    expect(() => parseArgs(['--count=21', '--deployment=x', '--out=y'])).to.throw(MakeEnvsError).with.property('code', 'MAKE_ENVS_BAD_ARG');
  });

  it('validates deployment artifacts against the selected profile', function () {
    const artifact = JSON.parse(fs.readFileSync(fixtureDeployment, 'utf8'));
    const deployment = validateDeploymentArtifact(artifact, 'canary-01-5');

    expect(deployment).to.deep.include({
      network: 'base-sepolia',
      chainId: 84532,
      registry: '0x1000000000000000000000000000000000000001',
      escrow: '0x2000000000000000000000000000000000000002',
      profile: 'canary-01-5',
    });

    artifact.profile.constants.REQUIRED_ORACLES = 5;
    expect(() => validateDeploymentArtifact(artifact, 'canary-01-5'))
      .to.throw(MakeEnvsError)
      .with.property('code', 'MAKE_ENVS_PROFILE_MISMATCH');
  });

  it('generates isolated operator envs, a manifest, funding targets, and compose file', function () {
    const out = path.join(root, '.venom-canary');
    const composeOut = path.join(root, 'docker-compose.canary-01-5.yml');
    const result = generateOperatorFiles({
      count: 3,
      deployment: fixtureDeployment,
      out,
      profile: 'canary-01-5',
      healthPortBase: 3300,
      composeOut,
      force: false,
    }, {
      now: () => fixedDate,
      walletFactory,
      env: { DEPLOYER_PRIVATE_KEY: '0xdeadbeef' },
    });

    expect(result.manifest.operators).to.have.length(3);
    expect(result.warnings).to.have.length(1);
    expect(fs.existsSync(path.join(out, 'manifest.json'))).to.equal(true);
    expect(fs.existsSync(path.join(out, 'funding-targets.txt'))).to.equal(true);
    expect(fs.existsSync(composeOut)).to.equal(true);

    const manifestText = fs.readFileSync(path.join(out, 'manifest.json'), 'utf8');
    expect(manifestText).to.not.match(/0x[0-9a-fA-F]{64}/);

    for (let index = 1; index <= 3; index++) {
      const envText = fs.readFileSync(path.join(out, `operator-${index}`, '.env'), 'utf8');
      expect(envText).to.include(`OPERATOR_QUEUE_SUFFIX=op${index}`);
      expect(envText).to.include(`HEALTH_PORT=${3299 + index}`);
      expect(envText).to.include('USE_TEST_PAYLOAD=false');
      expect(envText).to.include('DEPLOY_PROFILE=canary-01-5');
      expect(envText).to.include('VENOM_ALLOW_PRIVATE_MULTIADDR=false');
      expect(envText).to.include('VENOM_SKIP_REGISTRY_DIAL=true');
      expect(envText).to.include(`P2P_LISTEN_PORT=${42000 + index}`);
      expect(envText).to.include('P2P_BOOTSTRAP_PEERS=');
      expect(envText).to.not.include('DEPLOYER_PRIVATE_KEY');
    }

    const fundingTargets = fs.readFileSync(path.join(out, 'funding-targets.txt'), 'utf8');
    expect(fundingTargets).to.match(/^op1 0x[0-9A-Fa-f]{40}$/m);
    expect(fundingTargets).to.match(/^op2 0x[0-9A-Fa-f]{40}$/m);
    expect(fundingTargets).to.match(/^op3 0x[0-9A-Fa-f]{40}$/m);

    const compose = fs.readFileSync(composeOut, 'utf8');
    expect(compose).to.include('redis-canary:');
    expect(compose).to.include('ml-service-canary:');
    expect(compose).to.include('venom-node-canary-3:');
    expect(compose).to.include('.venom-canary/operator-3/.env');
    expect(compose).to.include('http://127.0.0.1:8000/health');
    expect(compose).to.not.include('http://127.0.0.1:8000/ready');
    expect(compose).to.not.include('dashboard');
  });

  it('enables registry-dial skip only for bootstrap canary profiles', function () {
    expect(shouldSkipRegistryDialForProfile('canary-01-5')).to.equal(true);
    expect(shouldSkipRegistryDialForProfile('production')).to.equal(false);
    expect(shouldSkipRegistryDialForProfile('solo')).to.equal(false);
  });

  it('includes bootstrap peers and pinned port for the canary-01-5 profile', function () {
    const out = path.join(root, '.venom-canary');
    const composeOut = path.join(root, 'docker-compose.canary-01-5.yml');
    generateOperatorFiles({
      count: 5,
      deployment: fixtureDeployment,
      out,
      profile: 'canary-01-5',
      healthPortBase: 3300,
      composeOut,
      force: false,
    }, { now: () => fixedDate, walletFactory, env: {} });

    const envText = fs.readFileSync(path.join(out, 'operator-2', '.env'), 'utf8');
    expect(envText).to.include('P2P_LISTEN_PORT=42002');
    expect(envText).to.include('P2P_BOOTSTRAP_PEERS=venom-node-canary-1:42001,venom-node-canary-3:42003');
    expect(envText).to.include('venom-node-canary-4:42004');
    expect(envText).to.include('venom-node-canary-5:42005');
    expect(envText).to.not.include('venom-node-canary-2:42002');
    expect(buildBootstrapPeerString(2, 5)).to.equal(
      'venom-node-canary-1:42001,venom-node-canary-3:42003,venom-node-canary-4:42004,venom-node-canary-5:42005'
    );
  });

  it('omits bootstrap peers and pinned port for non-bootstrap profiles', function () {
    const envText = buildOperatorEnv({
      operatorIndex: 1,
      count: 2,
      deployment: {
        profile: 'production',
        registry: '0x1000000000000000000000000000000000000001',
        escrow: '0x2000000000000000000000000000000000000002',
      },
      healthPort: 3000,
      privateKey: '0xabc',
      queueSuffix: 'op1',
    });

    expect(envText).to.not.include('VENOM_SKIP_REGISTRY_DIAL=true');
    expect(envText).to.not.include('P2P_LISTEN_PORT=');
    expect(envText).to.not.include('P2P_BOOTSTRAP_PEERS=');
  });

  it('keeps generated queue suffixes compatible with runtime queue normalization', function () {
    const out = path.join(root, '.venom-canary');
    const composeOut = path.join(root, 'docker-compose.canary-01-5.yml');
    const result = generateOperatorFiles({
      count: 3,
      deployment: fixtureDeployment,
      out,
      profile: 'canary-01-5',
      healthPortBase: 3300,
      composeOut,
      force: false,
    }, { now: () => fixedDate, walletFactory, env: {} });

    for (const operator of result.manifest.operators) {
      expect(operator.queueSuffix).to.match(/^[a-zA-Z0-9._-]{1,64}$/);
    }
  });

  it('rejects stray existing operator directories outside the requested count', function () {
    const out = path.join(root, '.venom-canary');
    fs.mkdirSync(path.join(out, 'operator-7'), { recursive: true });

    expect(() => generateOperatorFiles({
      count: 5,
      deployment: fixtureDeployment,
      out,
      profile: 'canary-01-5',
      composeOut: path.join(root, 'docker-compose.canary-01-5.yml'),
      force: false,
    }, { now: () => fixedDate, walletFactory, env: {} }))
      .to.throw(MakeEnvsError)
      .with.property('code', 'MAKE_ENVS_STRAY_OPERATOR');
  });

  it('does not print private-key-shaped values to stdout or stderr', function () {
    const out = path.join(root, '.venom-canary');
    const composeOut = path.join(root, 'docker-compose.canary-01-5.yml');
    const script = path.resolve(__dirname, '..', 'make-operator-envs.js');
    const result = spawnSync(process.execPath, [
      script,
      '--count=2',
      `--deployment=${fixtureDeployment}`,
      `--out=${out}`,
      '--profile=canary-01-5',
      `--compose-out=${composeOut}`,
      '--json',
    ], {
      cwd: path.resolve(__dirname, '..', '..', '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        DEPLOYER_PRIVATE_KEY: `0x${'a'.repeat(64)}`,
      },
    });

    expect(result.status).to.equal(0);
    expect(`${result.stdout}\n${result.stderr}`).to.not.match(/0x[0-9a-fA-F]{64}/);
  });

  it('leaves existing output untouched if generation fails before the atomic rename', function () {
    if (process.platform === 'win32') this.skip();

    const out = path.join(root, '.venom-canary');
    const composeOut = path.join(root, 'docker-compose.canary-01-5.yml');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'keep.txt'), 'keep\n');

    const originalChmod = fs.chmodSync;
    fs.chmodSync = () => {
      throw new Error('simulated chmod failure');
    };
    try {
      expect(() => generateOperatorFiles({
        count: 2,
        deployment: fixtureDeployment,
        out,
        profile: 'canary-01-5',
        composeOut,
        force: false,
      }, { now: () => fixedDate, walletFactory, env: {} }))
        .to.throw(MakeEnvsError)
        .with.property('code', 'MAKE_ENVS_PERM');
    } finally {
      fs.chmodSync = originalChmod;
    }

    expect(fs.readFileSync(path.join(out, 'keep.txt'), 'utf8')).to.equal('keep\n');
    expect(fs.existsSync(path.join(out, 'operator-1'))).to.equal(false);
    expect(fs.existsSync(composeOut)).to.equal(false);
  });

  it('sets 0600 permissions for operator envs where supported', function () {
    if (process.platform === 'win32') this.skip();

    const out = path.join(root, '.venom-canary');
    const composeOut = path.join(root, 'docker-compose.canary-01-5.yml');
    generateOperatorFiles({
      count: 2,
      deployment: fixtureDeployment,
      out,
      profile: 'canary-01-5',
      healthPortBase: 3000,
      composeOut,
      force: false,
    }, { now: () => fixedDate, walletFactory, env: {} });

    const mode = fs.statSync(path.join(out, 'operator-1', '.env')).mode & 0o777;
    expect(mode).to.equal(0o600);
  });

  it('refuses to overwrite existing operator output unless forced', function () {
    const out = path.join(root, '.venom-canary');
    fs.mkdirSync(path.join(out, 'operator-1'), { recursive: true });
    fs.writeFileSync(path.join(out, 'operator-1', '.env'), 'existing\n');

    expect(() => generateOperatorFiles({
      count: 2,
      deployment: fixtureDeployment,
      out,
      profile: 'canary-01-5',
      composeOut: path.join(root, 'docker-compose.canary-01-5.yml'),
      force: false,
    }, { now: () => fixedDate, walletFactory, env: {} }))
      .to.throw(MakeEnvsError)
      .with.property('code', 'MAKE_ENVS_OUTPUT_EXISTS');
  });

  it('replaces existing output when forced', function () {
    const out = path.join(root, '.venom-canary');
    fs.mkdirSync(path.join(out, 'operator-1'), { recursive: true });
    fs.writeFileSync(path.join(out, 'operator-1', '.env'), 'existing\n');

    generateOperatorFiles({
      count: 2,
      deployment: fixtureDeployment,
      out,
      profile: 'canary-01-5',
      healthPortBase: 3000,
      composeOut: path.join(root, 'docker-compose.canary-01-5.yml'),
      force: true,
    }, { now: () => fixedDate, walletFactory, env: {} });

    const envText = fs.readFileSync(path.join(out, 'operator-1', '.env'), 'utf8');
    expect(envText).to.include('OPERATOR_QUEUE_SUFFIX=op1');
    expect(envText).to.not.equal('existing\n');
  });
});
