'use strict';

const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ethers } = require('ethers');

const { STATE, validatePhaseResult } = require('../phases');
const {
  PHASE_INDEX,
  parseOperatorEnvFlags,
  resolveBalanceFloor,
  runCanaryReadiness,
} = require('../phases/canary-readiness');

const REGISTRY = '0x1000000000000000000000000000000000000001';
const ESCROW = '0x2000000000000000000000000000000000000002';
const OP1 = '0x3000000000000000000000000000000000000003';
const OP2 = '0x4000000000000000000000000000000000000004';

function makeContext(overrides = {}) {
  return {
    runId: 'cist-20260427-143012-a83f9c1e',
    runDir: '/tmp/test-run',
    mode: 'live-testnet',
    ...overrides,
  };
}

function makeManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    profile: 'canary-01-5',
    deployment: {
      network: 'base-sepolia',
      chainId: 84532,
      registry: REGISTRY,
      escrow: ESCROW,
    },
    operators: [
      { id: 'op1', address: OP1, envPath: 'operator-1/.env', healthPort: 3000, queueSuffix: 'op1' },
      { id: 'op2', address: OP2, envPath: 'operator-2/.env', healthPort: 3001, queueSuffix: 'op2' },
    ],
    generatedAt: '2026-05-08T09:00:00.000Z',
    ...overrides,
  };
}

function writeCanaryTree(root, manifest = makeManifest(), envOverrides = {}) {
  fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const operator of manifest.operators || []) {
    const envPath = path.join(root, operator.envPath);
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    const privateKey = envOverrides.privateKey || `0x${operator.id === 'op1' ? '1' : '2'.padStart(64, '2')}`;
    const privateMultiaddr = envOverrides.privateMultiaddr === true ? 'true' : 'false';
    fs.writeFileSync(envPath, [
      `OPERATOR_PRIVATE_KEY=${privateKey}`,
      `OPERATOR_QUEUE_SUFFIX=${operator.queueSuffix}`,
      `VENOM_ALLOW_PRIVATE_MULTIADDR=${privateMultiaddr}`,
      '',
    ].join('\n'));
  }
}

function makeContracts(overrides = {}) {
  return {
    escrow: {
      REQUIRED_ORACLES: async () => overrides.REQUIRED_ORACLES ?? 3n,
      SCORE_QUORUM_PCT: async () => overrides.SCORE_QUORUM_PCT ?? 50n,
      PARTICIPATION_FLOOR_PCT: async () => overrides.PARTICIPATION_FLOOR_PCT ?? 67n,
      CAMPAIGN_TIMEOUT_BLOCKS: async () => overrides.CAMPAIGN_TIMEOUT_BLOCKS ?? 3600n,
    },
    registry: {
      MIN_STAKE: async () => overrides.MIN_STAKE ?? ethers.parseEther('0.1'),
      SLASH_PERCENT: async () => overrides.SLASH_PERCENT ?? 5n,
      MAX_DEVIATION: async () => overrides.MAX_DEVIATION ?? 25n,
    },
  };
}

function makeProvider(balanceByAddress = {}) {
  return {
    getBalance: async (address) => {
      return balanceByAddress[ethers.getAddress(address)] ?? ethers.parseEther('0.2');
    },
  };
}

async function runPhase(root, options = {}) {
  const contracts = makeContracts(options.constants || {});
  return runCanaryReadiness(makeContext(options.context || {}), {
    canaryEnvsDir: root,
    env: {
      VENOM_REGISTRY_ADDRESS: REGISTRY,
      PILOT_ESCROW_ADDRESS: ESCROW,
      ...options.env,
    },
    provider: options.provider || makeProvider(options.balances || {}),
    registry: contracts.registry,
    escrow: contracts.escrow,
    registryAddress: options.registryAddress || REGISTRY,
    escrowAddress: options.escrowAddress || ESCROW,
    localOnly: options.localOnly,
  });
}

describe('CIST Phase 9: Canary multi-operator readiness', function () {
  let root;

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cist-canary-'));
  });

  afterEach(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('declares PHASE_INDEX as 9', function () {
    expect(PHASE_INDEX).to.equal(9);
  });

  it('SKIPs when --canary-envs is absent', async function () {
    const result = await runCanaryReadiness(makeContext(), {});
    expect(result.state).to.equal(STATE.SKIP);
    expect(result.codes).to.deep.equal([]);
    expect(validatePhaseResult(result)).to.equal(true);
  });

  it('PASSes when manifest, constants, balances, suffixes, and env files are valid', async function () {
    writeCanaryTree(root);
    const result = await runPhase(root);

    expect(result.state).to.equal(STATE.PASS);
    expect(result.codes).to.deep.equal([]);
    expect(result.manifest).to.deep.include({
      profile: 'canary-01-5',
      operatorCount: 2,
    });
    expect(validatePhaseResult(result)).to.equal(true);
  });

  it('FAILs on invalid manifest schema', async function () {
    writeCanaryTree(root, makeManifest({ schemaVersion: 0 }));
    const result = await runPhase(root);

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.deep.equal(['CANARY_MANIFEST_INVALID']);
  });

  it('FAILs when manifest deployment addresses do not match the preflight target', async function () {
    writeCanaryTree(root);
    const result = await runPhase(root, {
      registryAddress: '0x5000000000000000000000000000000000000005',
    });

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('CANARY_DEPLOYMENT_MISMATCH');
  });

  it('FAILs when deployed constants do not match the canary profile', async function () {
    writeCanaryTree(root);
    const result = await runPhase(root, {
      constants: { REQUIRED_ORACLES: 5n },
    });

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('CANARY_PROFILE_MISMATCH');
    expect(result.notes.join(' ')).to.include('REQUIRED_ORACLES');
  });

  it('FAILs when an operator balance is below the floor', async function () {
    writeCanaryTree(root);
    const result = await runPhase(root, {
      balances: { [OP2]: ethers.parseEther('0.15') },
    });

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('CANARY_OPERATOR_BALANCE_LOW');
    expect(result.notes.join(' ')).to.include('op2');
  });

  it('WARNs when an operator balance is just above the floor', async function () {
    writeCanaryTree(root);
    const result = await runPhase(root, {
      balances: { [OP2]: ethers.parseEther('0.165') },
    });

    expect(result.state).to.equal(STATE.WARN);
    expect(result.codes).to.deep.equal([]);
  });

  it('FAILs when a generated operator matches the deployer address', async function () {
    const deployer = ethers.Wallet.createRandom();
    writeCanaryTree(root, makeManifest({
      operators: [
        { id: 'op1', address: deployer.address, envPath: 'operator-1/.env', healthPort: 3000, queueSuffix: 'op1' },
      ],
    }));

    const result = await runPhase(root, {
      env: { DEPLOYER_PRIVATE_KEY: deployer.privateKey },
    });

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('CANARY_OPERATOR_IS_DEPLOYER');
  });

  it('FAILs on duplicate or invalid queue suffixes', async function () {
    writeCanaryTree(root, makeManifest({
      operators: [
        { id: 'op1', address: OP1, envPath: 'operator-1/.env', healthPort: 3000, queueSuffix: 'op1' },
        { id: 'op2', address: OP2, envPath: 'operator-2/.env', healthPort: 3001, queueSuffix: 'op1' },
      ],
    }));

    const result = await runPhase(root);

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('CANARY_QUEUE_SUFFIX_INVALID');
  });

  it('FAILs when private multiaddr is enabled outside local-only mode', async function () {
    writeCanaryTree(root, makeManifest(), { privateMultiaddr: true });
    const result = await runPhase(root);

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('CANARY_PRIVATE_MULTIADDR');
  });

  it('allows private multiaddr when local-only is set', async function () {
    writeCanaryTree(root, makeManifest(), { privateMultiaddr: true });
    const result = await runPhase(root, { localOnly: true });

    expect(result.state).to.equal(STATE.PASS);
    expect(result.codes).to.not.include('CANARY_PRIVATE_MULTIADDR');
  });

  it('FAILs when an operator env file is unreadable', async function () {
    writeCanaryTree(root);
    fs.rmSync(path.join(root, 'operator-2', '.env'));
    const result = await runPhase(root);

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('CANARY_OPERATOR_ENV_UNREADABLE');
  });

  it('parses only operator env flags needed by the readiness phase', function () {
    const envPath = path.join(root, '.env');
    fs.writeFileSync(envPath, [
      'OPERATOR_PRIVATE_KEY=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'OPERATOR_QUEUE_SUFFIX=op1',
      'VENOM_ALLOW_PRIVATE_MULTIADDR=true',
    ].join('\n'));

    expect(parseOperatorEnvFlags(envPath)).to.deep.equal({
      privateMultiaddr: true,
      queueSuffix: 'op1',
    });
  });

  it('does not leak private-key-shaped values into phase output', async function () {
    writeCanaryTree(root, makeManifest(), {
      privateKey: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    const result = await runPhase(root);
    const serialized = JSON.stringify(result);

    expect(serialized).to.not.match(/0x[0-9a-fA-F]{64}/);
  });

  it('uses an explicit operator balance floor when configured', function () {
    expect(resolveBalanceFloor('canary-01-5', ethers.parseEther('0.1'), {
      PREFLIGHT_OPERATOR_BALANCE_FLOOR: '0.2',
    })).to.equal(ethers.parseEther('0.2'));
  });
});
