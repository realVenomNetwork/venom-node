'use strict';

const { expect } = require('chai');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');

const { STATE } = require('../phases');
const {
  parsePreflightArgs,
  renderHelp,
  sha256Hex,
  fetchCidRoundTrip,
  createIpfsPayloadSource,
  deriveHealthUrl,
  runP2pDialbackCheck,
  runLivePreflightGates,
  applyLivePreflightGates,
  buildPreflightQueueName,
  isBlockingPreflightPhase,
} = require('../../preflight');

function arrayBufferFromText(text) {
  const buffer = Buffer.from(text, 'utf8');
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function makeFetch({ ok = true, status = 200, text = 'hello', json = null } = {}) {
  return async () => ({
    ok,
    status,
    arrayBuffer: async () => arrayBufferFromText(text),
    json: async () => (json === null ? JSON.parse(text) : json),
  });
}

describe('pilot live preflight', function () {
  it('parses supported preflight arguments', function () {
    const options = parsePreflightArgs([
      '--network=base-sepolia',
      '--json',
      '--skip-p2p-dialback',
      '--ipfs-cid=bafkreitest',
      '--ipfs-sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '--canary-envs=.venom-canary',
      '--local-only',
    ]);

    expect(options).to.deep.include({
      network: 'base-sepolia',
      json: true,
      skipP2pDialback: true,
      localOnly: true,
      canaryEnvsDir: '.venom-canary',
      ipfsCid: 'bafkreitest',
      ipfsSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
  });

  it('rejects unsupported preflight networks and arguments', function () {
    expect(() => parsePreflightArgs(['--network=eth-sepolia']))
      .to.throw('Unsupported preflight network: eth-sepolia')
      .with.property('code', 'PREFLIGHT_UNSUPPORTED_NETWORK');

    expect(() => parsePreflightArgs(['--bad']))
      .to.throw('Unsupported preflight argument: --bad')
      .with.property('code', 'PREFLIGHT_UNSUPPORTED_ARGUMENT');
  });

  it('renders discoverable help for the package command', function () {
    expect(renderHelp()).to.include('npm run pilot:preflight -- --network=base-sepolia');
    expect(renderHelp()).to.include('--canary-envs=<dir>');
  });

  it('keeps the registry oracle ABI aligned with the deployed tuple shape', function () {
    // Regression: MAIN-FIX-2
    const text = fs.readFileSync(path.resolve(__dirname, '../../preflight.js'), 'utf8');

    expect(text).to.include(
      'function oracles(address) view returns (address operator, uint256 stake, uint256 scoreCount, uint256 lastActive, bool active, string multiaddr)'
    );
  });

  it('builds the live preflight queue name with the operator suffix', function () {
    // Regression: MF-8
    expect(buildPreflightQueueName({
      QUEUE_NAME: 'venom-campaigns',
      OPERATOR_QUEUE_SUFFIX: 'op2',
    })).to.equal('venom-campaigns-op2');
    expect(buildPreflightQueueName({
      QUEUE_NAME: 'venom-campaigns',
      OPERATOR_QUEUE_SUFFIX: '',
    })).to.equal('venom-campaigns');
    expect(() => buildPreflightQueueName({
      QUEUE_NAME: 'venom-campaigns',
      OPERATOR_QUEUE_SUFFIX: 'op:2',
    })).to.throw('OPERATOR_QUEUE_SUFFIX');
  });

  it('does not treat the intentional canary Phase 7 SKIP as blocking Phase 9', function () {
    // Regression: MF-5
    expect(isBlockingPreflightPhase({
      index: 7,
      state: STATE.SKIP,
    }, { canaryEnvsDir: '.venom-canary' })).to.equal(false);
    expect(isBlockingPreflightPhase({
      index: 7,
      state: STATE.SKIP,
    }, {})).to.equal(true);
    expect(isBlockingPreflightPhase({
      index: 9,
      state: STATE.SKIP,
    }, { canaryEnvsDir: '.venom-canary' })).to.equal(true);
  });

  it('derives the ML health URL from the evaluate URL', function () {
    expect(deriveHealthUrl('http://127.0.0.1:8000/evaluate'))
      .to.equal('http://127.0.0.1:8000/health');
    expect(deriveHealthUrl('https://ml.example.test/nested/evaluate?token=abc'))
      .to.equal('https://ml.example.test/health');
  });

  it('fetches a CID from configured gateways and verifies SHA-256', async function () {
    const expected = sha256Hex(Buffer.from('hello', 'utf8'));
    const result = await fetchCidRoundTrip({
      cid: 'bafkreitest',
      expectedSha256: expected,
      gateways: ['https://gateway.example/ipfs'],
      fetchImpl: makeFetch({ text: 'hello' }),
    });

    expect(result).to.deep.include({
      cid: 'bafkreitest',
      sha256: expected,
      gatewaysConfigured: 1,
      gatewaysSucceeded: 1,
      gatewaysFailed: 0,
    });
    expect(result.bytes.toString('utf8')).to.equal('hello');
  });

  it('fails the IPFS round-trip when bytes do not match', async function () {
    let error;
    try {
      await fetchCidRoundTrip({
        cid: 'bafkreitest',
        expectedSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        gateways: ['https://gateway.example/ipfs'],
        fetchImpl: makeFetch({ text: 'hello' }),
      });
    } catch (err) {
      error = err;
    }

    expect(error).to.be.instanceOf(Error);
    expect(error.message).to.include('IPFS round-trip failed on all configured gateways');
  });

  it('builds a report-safe payload source from the IPFS round-trip', async function () {
    const expected = sha256Hex(Buffer.from('hello', 'utf8'));
    const payloadSource = createIpfsPayloadSource(
      { runId: 'cist-20260506-183304-431f3f5e' },
      {
        env: {
          PREFLIGHT_IPFS_CID: 'bafkreitest',
          PREFLIGHT_IPFS_SHA256: expected,
          IPFS_GATEWAYS: 'https://gateway.example/ipfs',
        },
        fetchImpl: makeFetch({ text: 'hello' }),
      }
    );

    const payload = await payloadSource();
    expect(payload.campaignUid).to.equal('cist-20260506-183304-431f3f5e:live-preflight');
    expect(payload.payload).to.equal('VENOM live preflight IPFS round-trip payload verified.');
    expect(payload.ipfs).to.deep.include({
      cid: 'bafkreitest',
      bytes: 5,
      sha256: expected,
      gatewaysConfigured: 1,
      gatewaysSucceeded: 1,
      gatewaysFailed: 0,
    });
  });

  it('treats missing P2P dial-back configuration as a warning by default', async function () {
    const result = await runP2pDialbackCheck({ env: {}, parsed: {} });

    expect(result.state).to.equal(STATE.WARN);
    expect(result.codes).to.deep.equal(['PREFLIGHT_P2P_DIALBACK_DEFERRED']);
    expect(result.p2pDialback.configured).to.equal(false);
  });

  it('can require P2P dial-back configuration', async function () {
    const result = await runP2pDialbackCheck({
      env: {},
      parsed: { requireP2pDialback: true },
    });

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.deep.equal(['PREFLIGHT_P2P_DIALBACK_MISSING']);
  });

  it('accepts a successful external P2P dial-back probe', async function () {
    const result = await runP2pDialbackCheck({
      env: {
        PUBLIC_MULTIADDR: '/ip4/203.0.113.10/tcp/4001',
        PREFLIGHT_P2P_DIALBACK_URL: 'https://probe.example/check',
      },
      parsed: {},
      fetchImpl: makeFetch({ json: { reachable: true } }),
    });

    expect(result.state).to.equal(STATE.PASS);
    expect(result.p2pDialback).to.deep.include({
      configured: true,
      reachable: true,
      publicMultiaddrSet: true,
      probeUrlSet: true,
    });
  });

  function makeGateResources(overrides = {}) {
    const wallet = { address: '0x000000000000000000000000000000000000dEaD' };
    return {
      wallet,
      escrow: {
        REQUIRED_ORACLES: async () => overrides.requiredOracles ?? 5n,
      },
      registry: {
        activeOracleCount: async () => overrides.activeOracleCount ?? 5n,
        MIN_STAKE: async () => ethers.parseEther('1'),
        oracles: async () => ({
          active: overrides.oracleActive ?? true,
        }),
      },
      provider: {
        getBalance: async () => overrides.balance ?? ethers.parseEther('0.05'),
        getFeeData: async () => ({
          gasPrice: ethers.parseUnits('1', 'gwei'),
        }),
      },
    };
  }

  it('passes live gates when active-oracle count and operator balance are sufficient', async function () {
    const result = await runLivePreflightGates(makeGateResources(), {
      env: {
        PREFLIGHT_BALANCE_BUFFER_ETH: '0.01',
        PREFLIGHT_CLOSE_GAS_LIMIT: '100000',
      },
      parsed: { skipP2pDialback: true },
    });

    expect(result.state).to.equal(STATE.PASS);
    expect(result.codes).to.deep.equal([]);
    expect(result.livePreflight.activeOracleGate.pass).to.equal(true);
    expect(result.livePreflight.operatorBalanceGate.pass).to.equal(true);
  });

  it('fails live gates when active-oracle count is below contract requirement', async function () {
    const result = await runLivePreflightGates(makeGateResources({ activeOracleCount: 4n }), {
      env: {
        PREFLIGHT_BALANCE_BUFFER_ETH: '0.01',
        PREFLIGHT_CLOSE_GAS_LIMIT: '100000',
      },
      parsed: { skipP2pDialback: true },
    });

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('PREFLIGHT_ACTIVE_ORACLE_COUNT_LOW');
  });

  it('fails live gates when the operator is not registered and cannot cover stake plus gas', async function () {
    const result = await runLivePreflightGates(makeGateResources({
      oracleActive: false,
      balance: ethers.parseEther('0.5'),
    }), {
      env: {
        PREFLIGHT_BALANCE_BUFFER_ETH: '0.01',
        PREFLIGHT_CLOSE_GAS_LIMIT: '100000',
      },
      parsed: { skipP2pDialback: true },
    });

    expect(result.state).to.equal(STATE.FAIL);
    expect(result.codes).to.include('PREFLIGHT_OPERATOR_BALANCE_LOW');
    expect(result.livePreflight.operatorBalanceGate.oracleActive).to.equal(false);
  });

  it('applies live gate failures to the existing P2P phase', function () {
    const phases = [{
      index: 7,
      key: 'p2p',
      name: 'P2P / signature aggregation',
      state: STATE.PASS,
      durationMs: 1,
      codes: [],
      notes: [],
    }];

    applyLivePreflightGates(phases, {
      state: STATE.FAIL,
      codes: ['PREFLIGHT_ACTIVE_ORACLE_COUNT_LOW'],
      notes: ['Active oracle count is too low.'],
      livePreflight: { activeOracleGate: { pass: false } },
    });

    expect(phases[0].state).to.equal(STATE.FAIL);
    expect(phases[0].codes).to.deep.equal(['PREFLIGHT_ACTIVE_ORACLE_COUNT_LOW']);
    expect(phases[0].notes).to.deep.equal(['Active oracle count is too low.']);
    expect(phases[0].livePreflight.activeOracleGate.pass).to.equal(false);
  });
});
