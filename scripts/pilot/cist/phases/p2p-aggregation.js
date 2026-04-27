'use strict';

const { performance } = require('node:perf_hooks');
const { verifyMessage } = require('ethers');

const { STATE, createPhaseResult } = require('../phases');

const PHASE_INDEX = 7;
const HARDHAT_CHAIN_ID = 31337;
const DEFAULT_QUORUM = 3;

function assertFixtureChain(chainId) {
  if (Number(chainId) !== HARDHAT_CHAIN_ID) {
    const error = new Error(
      `FIXTURE_KEY_MISUSE: fixture oracle keys can only be used on chain ${HARDHAT_CHAIN_ID}, got ${chainId}`
    );
    error.code = 'FIXTURE_KEY_MISUSE';
    throw error;
  }
  return true;
}

function assertOracleFactoryShape(factory) {
  if (!factory || typeof factory.createOracles !== 'function') {
    const error = new Error('Oracle factory must have a createOracles() method');
    error.code = 'P2P_ORACLE_FACTORY_INVALID';
    throw error;
  }
  return true;
}

function assertWorkerDecisionShape(decision) {
  if (!decision || typeof decision !== 'object') {
    throw new Error('Worker decision is required');
  }
  if (!['approve', 'reject', 'abstain'].includes(decision.decision)) {
    throw new Error('Worker decision is invalid');
  }
  if (typeof decision.score !== 'number' || decision.score < 0 || decision.score > 1) {
    throw new Error('Worker decision is invalid');
  }
  if (typeof decision.reason !== 'string' || decision.reason.length === 0) {
    throw new Error('Worker decision is invalid');
  }
  return true;
}

function buildAggregationMessage(context, { chainId, workerDecision }) {
  return JSON.stringify({
    runId: context.runId,
    chainId: Number(chainId),
    decision: workerDecision.decision,
    score: workerDecision.score,
    reason: workerDecision.reason,
  });
}

function normalizeOracleSignature(sig) {
  if (!sig || typeof sig !== 'object') {
    throw new Error('Oracle signature is invalid');
  }
  if (typeof sig.oracleId !== 'string' || sig.oracleId.length === 0) {
    throw new Error('Oracle signature is invalid');
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(sig.address)) {
    throw new Error('Oracle signature is invalid');
  }
  if (!/^0x[a-fA-F0-9]{130}$/.test(sig.signature)) {
    throw new Error('Oracle signature is invalid');
  }
  return sig;
}

async function runP2pAggregation(context, options = {}) {
  const started = performance.now();
  const codes = [];
  const notes = [];
  const p2p = { configured: false };
  const signatures = [];

  try {
    if (options.chainId === undefined || options.chainId === null) {
      codes.push('P2P_CHAIN_ID_MISSING');
      notes.push('Chain ID is required for P2P aggregation');
      return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes,
        notes,
        p2p,
        signatures,
      });
    }

    // Fixture keys are checked before worker decision validation because using them
    // on the wrong chain is a higher-risk condition than a missing decision.
    if (options.usesFixtureKeys !== false) {
      assertFixtureChain(options.chainId);
    }

    if (!options.workerDecision) {
      codes.push('P2P_WORKER_DECISION_MISSING');
      notes.push('Worker decision is required for P2P aggregation');
      return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes,
        notes,
        p2p,
        signatures,
      });
    }

    try {
      assertWorkerDecisionShape(options.workerDecision);
    } catch (error) {
      codes.push('P2P_WORKER_DECISION_INVALID');
      notes.push(error.message);
      return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes,
        notes,
        p2p,
        signatures,
      });
    }

    if (!options.oracleFactory) {
      return createPhaseResult(PHASE_INDEX, STATE.WARN, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes: ['P2P_NOT_CONFIGURED'],
        notes: [
          'No oracle factory was configured; P2P/signature aggregation probe was not run.',
          'Provide an oracleFactory with createOracles() for full P2P checks.',
        ],
        p2p,
        signatures,
      });
    }

    try {
      assertOracleFactoryShape(options.oracleFactory);
    } catch (error) {
      codes.push(error.code || 'P2P_ORACLE_FACTORY_INVALID');
      notes.push(error.message);
      return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes,
        notes,
        p2p,
        signatures,
      });
    }
    p2p.configured = true;

    const message = buildAggregationMessage(context, {
      chainId: options.chainId,
      workerDecision: options.workerDecision,
    });

    let oracles = [];
    try {
      oracles = await options.oracleFactory.createOracles({
        context,
        chainId: options.chainId,
        message,
      });
    } catch (error) {
      codes.push('P2P_ORACLE_THREW');
      notes.push(`Oracle factory threw: ${error.message}`);
      return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes,
        notes,
        p2p,
        signatures,
      });
    }
    const seenAddresses = new Set();

    for (const oracle of oracles) {
      try {
        const rawSig = await oracle.sign(message);
        const normalized = normalizeOracleSignature(rawSig);
        const recovered = verifyMessage(message, normalized.signature);

        if (recovered.toLowerCase() !== normalized.address.toLowerCase()) {
          codes.push('P2P_ORACLE_SIGNATURE_INVALID');
          notes.push(`Signature does not recover to oracle address: ${normalized.address}`);
          return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
            durationMs: Math.max(0, Math.round(performance.now() - started)),
            codes,
            notes,
            p2p,
            signatures,
          });
        }

        const addrLower = normalized.address.toLowerCase();
        if (!seenAddresses.has(addrLower)) {
          seenAddresses.add(addrLower);
          signatures.push(normalized);
        }
      } catch (error) {
        codes.push('P2P_ORACLE_SIGNATURE_INVALID');
        notes.push(`Failed to collect/verify signature: ${error.message}`);
        return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
          durationMs: Math.max(0, Math.round(performance.now() - started)),
          codes,
          notes,
          p2p,
          signatures,
        });
      }
    }

    p2p.validSignatures = signatures.length;
    p2p.quorum = options.quorum ?? DEFAULT_QUORUM;

    const quorum = options.quorum ?? DEFAULT_QUORUM;
    if (signatures.length < quorum) {
      codes.push('P2P_QUORUM_NOT_REACHED');
      notes.push(`Only ${signatures.length} unique valid signatures (quorum: ${quorum})`);
      return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        codes,
        notes,
        p2p,
        signatures,
      });
    }

    return createPhaseResult(PHASE_INDEX, STATE.PASS, {
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      codes,
      notes,
      p2p,
      signatures,
    });
  } catch (error) {
    if (error.code === 'FIXTURE_KEY_MISUSE') {
      codes.push('FIXTURE_KEY_MISUSE');
      notes.push(error.message);
    } else if (error.code === 'P2P_ORACLE_FACTORY_INVALID') {
      codes.push('P2P_ORACLE_FACTORY_INVALID');
      notes.push(error.message);
    } else {
      codes.push('CIST_UNEXPECTED_ERROR');
      notes.push(`P2P aggregation failed: ${error.message}`);
    }
    return createPhaseResult(PHASE_INDEX, STATE.FAIL, {
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      codes,
      notes,
      p2p,
      signatures,
    });
  }
}

module.exports = {
  PHASE_INDEX,
  HARDHAT_CHAIN_ID,
  DEFAULT_QUORUM,
  assertFixtureChain,
  assertOracleFactoryShape,
  assertWorkerDecisionShape,
  buildAggregationMessage,
  normalizeOracleSignature,
  runP2pAggregation,
};
