'use strict';

const { expect } = require('chai');
const { id } = require('ethers');

const {
  PHASE_INDEX,
  EXPECTED_CHAIN_ID_BY_MODE,
  SIGNATURES,
  SELECTORS,
  runChainBinding,
  hasSelector,
  normalizeChainId,
} = require('../phases/chain-binding');

const { STATE, validatePhaseResult } = require('../phases');

const ESCROW_ADDRESS = '0x1234567890123456789012345678901234567890';
const REGISTRY_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

const ESCROW_BYTECODE_WITH_OPERATOR_PAYOUT =
  `0x608060405234801561001057600080fd5b5063${SELECTORS.OPERATOR_PAYOUT.slice(2)}600052`;

const REGISTRY_BYTECODE_WITH_UNSTAKE =
  `0x608060405234801561001057600080fd5b5063${SELECTORS.UNSTAKE.slice(2)}600052`;

const BYTECODE_WITHOUT_SELECTORS =
  '0x608060405234801561001057600080fd5b5060005260206000f3';

describe('CIST Phase 2: Chain and contract binding', function () {
  function makeContext(overrides = {}) {
    return {
      runId: 'cist-20260427-143012-a83f9c1e',
      runDir: '/tmp/test-run',
      mode: 'fixture',
      scenario: 'all-agree',
      network: { chainId: null, name: null, rpcRedacted: true },
      contracts: {},
      ...overrides,
    };
  }

  function makeMockProvider(options = {}) {
    const {
      chainId = 31337,
      name = chainId === 31337 ? 'hardhat' : 'unknown',
      escrowCode = ESCROW_BYTECODE_WITH_OPERATOR_PAYOUT,
      registryCode = REGISTRY_BYTECODE_WITH_UNSTAKE,
    } = options;

    return {
      getNetwork: async () => ({ chainId, name }),
      getCode: async (address) => {
        if (address === ESCROW_ADDRESS) return escrowCode;
        if (address === REGISTRY_ADDRESS) return registryCode;
        return '0x';
      },
    };
  }

  describe('helper functions', function () {
    it('declares PHASE_INDEX as 2', function () {
      expect(PHASE_INDEX).to.equal(2);
    });

    it('declares expected chain IDs by mode', function () {
      expect(EXPECTED_CHAIN_ID_BY_MODE.fixture).to.equal(31337);
      expect(EXPECTED_CHAIN_ID_BY_MODE['live-testnet']).to.equal(84532);
    });

    it('hasSelector detects function selectors case-insensitively', function () {
      const bytecode = `0x1234${SELECTORS.OPERATOR_PAYOUT.slice(2).toUpperCase()}abcd`;

      expect(hasSelector(bytecode, SELECTORS.OPERATOR_PAYOUT)).to.equal(true);
      expect(hasSelector(bytecode, SELECTORS.UNSTAKE)).to.equal(false);
      expect(hasSelector('0x', SELECTORS.OPERATOR_PAYOUT)).to.equal(false);
      expect(hasSelector(null, SELECTORS.OPERATOR_PAYOUT)).to.equal(false);
    });

    it('normalizeChainId handles common provider responses', function () {
      expect(normalizeChainId(31337)).to.equal(31337);
      expect(normalizeChainId(31337n)).to.equal(31337);
      expect(normalizeChainId('31337')).to.equal(31337);
      expect(normalizeChainId('0x7a69')).to.equal(31337);
      expect(normalizeChainId({ chainId: 84532 })).to.equal(84532);
      expect(normalizeChainId({ chainId: 84532n })).to.equal(84532);
      expect(normalizeChainId({ chainId: '0x14a34' })).to.equal(84532);
    });

    it('normalizeChainId rejects unsupported values', function () {
      expect(() => normalizeChainId(null)).to.throw('Unable to normalize chain ID');
      expect(() => normalizeChainId({})).to.throw('Unable to normalize chain ID');
      expect(() => normalizeChainId('not-a-chain')).to.throw('Unable to normalize chain ID');
    });

    it('selectors are derived from the documented signatures and not withdraw()', function () {
      expect(SELECTORS.OPERATOR_PAYOUT).to.equal(id(SIGNATURES.OPERATOR_PAYOUT).slice(0, 10));
      expect(SELECTORS.UNSTAKE).to.equal(id(SIGNATURES.UNSTAKE).slice(0, 10));

      expect(SELECTORS.OPERATOR_PAYOUT).to.not.equal('0x3ccfd60b');
      expect(SELECTORS.UNSTAKE).to.not.equal('0x2e1a7d4d');
    });
  });

  describe('runChainBinding', function () {
    it('returns PASS in fixture mode with expected chain ID and required bytecode present', async function () {
      const result = await runChainBinding(makeContext(), {
        provider: makeMockProvider(),
        escrowAddress: ESCROW_ADDRESS,
        registryAddress: REGISTRY_ADDRESS,
      });

      expect(result.index).to.equal(2);
      expect(result.key).to.equal('chain');
      expect(result.name).to.equal('Chain and contract binding');
      expect(result.state).to.equal(STATE.PASS);
      expect(result.codes).to.deep.equal([]);
      expect(validatePhaseResult(result)).to.equal(true);

      expect(result.network).to.deep.equal({
        chainId: 31337,
        name: 'hardhat',
      });

      expect(result.contracts).to.deep.equal({
        pilotEscrow: {
          address: ESCROW_ADDRESS,
          hasBytecode: true,
          hasOperatorPayoutSelector: true,
        },
        venomRegistry: {
          address: REGISTRY_ADDRESS,
          hasBytecode: true,
          hasUnstakeSelector: true,
        },
      });

      expect(result.releaseReadiness).to.deep.equal({ unresolved: [] });
    });

    it('FAILs with CHAIN_ID_MISMATCH when provider returns wrong chain for selected mode', async function () {
      const result = await runChainBinding(makeContext({ mode: 'live-testnet' }), {
        provider: makeMockProvider({ chainId: 1, name: 'mainnet' }),
        escrowAddress: ESCROW_ADDRESS,
        registryAddress: REGISTRY_ADDRESS,
      });

      expect(result.state).to.equal(STATE.FAIL);
      expect(result.codes).to.include('CHAIN_ID_MISMATCH');
      expect(result.notes.join(' ')).to.include('Expected chain ID 84532');
      expect(result.network.chainId).to.equal(1);
    });

    it('FAILs with CONTRACT_ESCROW_UNREACHABLE when escrow bytecode is 0x', async function () {
      const result = await runChainBinding(makeContext(), {
        provider: makeMockProvider({ escrowCode: '0x' }),
        escrowAddress: ESCROW_ADDRESS,
        registryAddress: REGISTRY_ADDRESS,
      });

      expect(result.state).to.equal(STATE.FAIL);
      expect(result.codes).to.include('CONTRACT_ESCROW_UNREACHABLE');
      expect(result.contracts.pilotEscrow.hasBytecode).to.equal(false);
    });

    it('FAILs with CONTRACT_REGISTRY_UNREACHABLE when registry bytecode is 0x', async function () {
      const result = await runChainBinding(makeContext(), {
        provider: makeMockProvider({ registryCode: '0x' }),
        escrowAddress: ESCROW_ADDRESS,
        registryAddress: REGISTRY_ADDRESS,
      });

      expect(result.state).to.equal(STATE.FAIL);
      expect(result.codes).to.include('CONTRACT_REGISTRY_UNREACHABLE');
      expect(result.contracts.venomRegistry.hasBytecode).to.equal(false);
    });

    it('returns PASS plus releaseReadiness unresolved when operator payout selector is missing', async function () {
      const result = await runChainBinding(makeContext(), {
        provider: makeMockProvider({ escrowCode: BYTECODE_WITHOUT_SELECTORS }),
        escrowAddress: ESCROW_ADDRESS,
        registryAddress: REGISTRY_ADDRESS,
      });

      expect(result.state).to.equal(STATE.PASS);
      expect(result.codes).to.deep.equal([]);
      expect(result.contracts.pilotEscrow.hasOperatorPayoutSelector).to.equal(false);
      expect(result.releaseReadiness.unresolved).to.include('PROD_BLOCKER_OPERATOR_PAYOUT_MISSING');
    });

    it('returns PASS plus releaseReadiness unresolved when registry unstake selector is missing', async function () {
      const result = await runChainBinding(makeContext(), {
        provider: makeMockProvider({ registryCode: BYTECODE_WITHOUT_SELECTORS }),
        escrowAddress: ESCROW_ADDRESS,
        registryAddress: REGISTRY_ADDRESS,
      });

      expect(result.state).to.equal(STATE.PASS);
      expect(result.codes).to.deep.equal([]);
      expect(result.contracts.venomRegistry.hasUnstakeSelector).to.equal(false);
      expect(result.releaseReadiness.unresolved).to.include('PROD_BLOCKER_UNSTAKE_MISSING');
    });

    it('WARNs when provider is not configured', async function () {
      const result = await runChainBinding(makeContext(), {
        escrowAddress: ESCROW_ADDRESS,
        registryAddress: REGISTRY_ADDRESS,
      });

      expect(result.state).to.equal(STATE.WARN);
      expect(result.codes).to.deep.equal(['CHAIN_PROVIDER_NOT_CONFIGURED']);
      expect(result.notes).to.deep.equal([
        'Chain provider was not configured; chain and contract binding probes were not run.',
        'Run with a Hardhat/provider-backed CIST invocation for full chain binding checks.',
      ]);
      expect(result.network).to.deep.equal({
        chainId: null,
        name: null,
      });
      expect(result.contracts).to.deep.equal({});
      expect(result.releaseReadiness).to.deep.equal({ unresolved: [] });
    });

    it('FAILs with CONTRACT_ADDRESS_MISSING when addresses are missing', async function () {
      const result = await runChainBinding(makeContext(), {
        provider: makeMockProvider(),
      });

      expect(result.state).to.equal(STATE.FAIL);
      expect(result.codes).to.include('CONTRACT_ADDRESS_MISSING');
      expect(result.notes.join(' ')).to.match(/address/i);
    });

    it('stores only serializable primitives in result metadata', async function () {
      const result = await runChainBinding(makeContext(), {
        provider: makeMockProvider(),
        escrowAddress: ESCROW_ADDRESS,
        registryAddress: REGISTRY_ADDRESS,
      });

      expect(() => JSON.stringify(result)).to.not.throw();

      const serialized = JSON.stringify(result);
      expect(serialized).to.not.include('function');
      expect(serialized).to.not.include('Provider');
      expect(serialized).to.not.include('Contract');
    });

    it('does not store provider or contract instances on the result', async function () {
      const result = await runChainBinding(makeContext(), {
        provider: makeMockProvider(),
        escrowAddress: ESCROW_ADDRESS,
        registryAddress: REGISTRY_ADDRESS,
      });

      expect(result).to.not.have.property('provider');
      expect(result).to.not.have.property('escrowContract');
      expect(result).to.not.have.property('registryContract');
    });
  });
});
