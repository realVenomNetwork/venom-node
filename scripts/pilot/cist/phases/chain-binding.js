'use strict';

const { performance } = require('node:perf_hooks');
const { id } = require('ethers');

const { STATE, createPhaseResult } = require('../phases');

const PHASE_INDEX = 2;

/**
 * KNOWN LIMITATION (v1.1):
 * These signatures are best-guess placeholders until the deployed ABIs are
 * verified against PilotEscrow and VenomRegistry.
 *
 * TODO: Replace with the exact contract signatures before trusting blocker
 * detection in release readiness.
 */
const SIGNATURES = Object.freeze({
  OPERATOR_PAYOUT: 'payOperatorBounty(address,uint256)',
  UNSTAKE: 'unstake(uint256)',
});

const EXPECTED_CHAIN_ID_BY_MODE = Object.freeze({
  fixture: 31337,
  'live-testnet': 84532, // Base Sepolia
});

const SELECTORS = Object.freeze({
  OPERATOR_PAYOUT: id(SIGNATURES.OPERATOR_PAYOUT).slice(0, 10),
  UNSTAKE: id(SIGNATURES.UNSTAKE).slice(0, 10),
});

function hasSelector(bytecode, selector) {
  if (!bytecode || typeof bytecode !== 'string' || bytecode.length < 10) {
    return false;
  }
  const normalized = bytecode.toLowerCase();
  const normalizedSelector = selector.toLowerCase();
  return normalized.includes(normalizedSelector.slice(2));
}

function normalizeChainId(input) {
  if (input === null || input === undefined) {
    throw new Error('Unable to normalize chain ID');
  }

  if (typeof input === 'number' || typeof input === 'bigint') {
    return Number(input);
  }

  if (typeof input === 'string') {
    if (input.startsWith('0x')) {
      return parseInt(input, 16);
    }
    const num = Number(input);
    if (!Number.isNaN(num)) return num;
  }

  if (typeof input === 'object' && input.chainId !== undefined) {
    return normalizeChainId(input.chainId);
  }

  throw new Error('Unable to normalize chain ID');
}

async function runChainBinding(context, options = {}) {
  const started = performance.now();
  const codes = [];
  const notes = [];
  const metadata = { chainId: null, name: null };
  const contracts = {
    pilotEscrow: { address: null, hasBytecode: false, hasOperatorPayoutSelector: false },
    venomRegistry: { address: null, hasBytecode: false, hasUnstakeSelector: false },
  };
  const releaseReadiness = { unresolved: [] };

  try {
    if (!options.provider) {
      return createPhaseResult(PHASE_INDEX, STATE.WARN, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes: ['CHAIN_PROVIDER_NOT_CONFIGURED'],
        notes: [
          'Chain provider was not configured; chain and contract binding probes were not run.',
          'Run with a Hardhat/provider-backed CIST invocation for full chain binding checks.',
        ],
        network: metadata,
        contracts: {},
        releaseReadiness,
      });
    }

    const { provider, escrowAddress, registryAddress } = options;

    if (!escrowAddress || !registryAddress) {
      codes.push('CONTRACT_ADDRESS_MISSING');
      notes.push('Both PilotEscrow and VenomRegistry addresses are required');
      return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes,
        notes,
        network: metadata,
        contracts,
        releaseReadiness,
      });
    }

    // 1. Get chain ID
    const network = await provider.getNetwork();
    const chainId = normalizeChainId(network);
    metadata.chainId = chainId;
    metadata.name = network.name || 'unknown';

    const expectedChainId = EXPECTED_CHAIN_ID_BY_MODE[context.mode] || 31337;

    if (chainId !== expectedChainId) {
      codes.push('CHAIN_ID_MISMATCH');
      notes.push(`Expected chain ID ${expectedChainId} but got ${chainId}`);
      return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes,
        notes,
        network: metadata,
        contracts,
        releaseReadiness,
      });
    }

    // 2. Check escrow bytecode
    const escrowCode = await provider.getCode(escrowAddress);
    contracts.pilotEscrow.address = escrowAddress;

    if (!escrowCode || escrowCode === '0x') {
      codes.push('CONTRACT_ESCROW_UNREACHABLE');
      notes.push('PilotEscrow contract has no bytecode');
      contracts.pilotEscrow.hasBytecode = false;
      return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes,
        notes,
        network: metadata,
        contracts,
        releaseReadiness,
      });
    }

    contracts.pilotEscrow.hasBytecode = true;
    contracts.pilotEscrow.hasOperatorPayoutSelector = hasSelector(escrowCode, SELECTORS.OPERATOR_PAYOUT);

    if (!contracts.pilotEscrow.hasOperatorPayoutSelector) {
      releaseReadiness.unresolved.push('PROD_BLOCKER_OPERATOR_PAYOUT_MISSING');
    }

    // 3. Check registry bytecode
    const registryCode = await provider.getCode(registryAddress);
    contracts.venomRegistry.address = registryAddress;

    if (!registryCode || registryCode === '0x') {
      codes.push('CONTRACT_REGISTRY_UNREACHABLE');
      notes.push('VenomRegistry contract has no bytecode');
      contracts.venomRegistry.hasBytecode = false;
      return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes,
        notes,
        network: metadata,
        contracts,
        releaseReadiness,
      });
    }

    contracts.venomRegistry.hasBytecode = true;
    contracts.venomRegistry.hasUnstakeSelector = hasSelector(registryCode, SELECTORS.UNSTAKE);

    if (!contracts.venomRegistry.hasUnstakeSelector) {
      releaseReadiness.unresolved.push('PROD_BLOCKER_UNSTAKE_MISSING');
    }

    return createPhaseResult(PHASE_INDEX, STATE.PASS, {
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      codes,
      notes,
      network: metadata,
      contracts,
      releaseReadiness,
    });
  } catch (error) {
    codes.push('CIST_UNEXPECTED_ERROR');
    notes.push(`Chain binding check failed: ${error.message}`);
    return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      codes,
      notes,
      network: metadata,
      contracts,
      releaseReadiness,
    });
  }
}

module.exports = {
  PHASE_INDEX,
  EXPECTED_CHAIN_ID_BY_MODE,
  SIGNATURES,
  SELECTORS,
  runChainBinding,
  hasSelector,
  normalizeChainId,
};
