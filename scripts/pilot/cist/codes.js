'use strict';

const SEVERITY = Object.freeze({
  WARN: 'WARN',
  FAIL: 'FAIL'
});

const PHASE = Object.freeze({
  CONFIG: 1,
  CHAIN: 2,
  REDIS: 3,
  ML: 4,
  PAYLOAD: 5,
  WORKER: 6,
  P2P: 7,
  REPORT: 8
});

const CODES = Object.freeze({
  CONFIG_ENV_MISSING: {
    code: 'CONFIG_ENV_MISSING',
    summary: 'Required CIST environment configuration is missing.',
    severity: SEVERITY.FAIL,
    phase: PHASE.CONFIG
  },
  CONFIG_RUNDIR_NOT_WRITABLE: {
    code: 'CONFIG_RUNDIR_NOT_WRITABLE',
    summary: 'CIST run directory is missing, invalid, or not writable.',
    severity: SEVERITY.FAIL,
    phase: PHASE.CONFIG
  },
  CONFIG_SECRET_LEAK_DETECTED: {
    code: 'CONFIG_SECRET_LEAK_DETECTED',
    summary: 'Secret-shaped material was detected before report writing.',
    severity: SEVERITY.FAIL,
    phase: PHASE.CONFIG
  },
  CHAIN_PROVIDER_NOT_CONFIGURED: {
    code: 'CHAIN_PROVIDER_NOT_CONFIGURED',
    summary: 'Chain provider was not configured for the chain binding check.',
    severity: SEVERITY.WARN,
    phase: PHASE.CHAIN
  },
  CONTRACT_ADDRESS_MISSING: {
    code: 'CONTRACT_ADDRESS_MISSING',
    summary: 'One or both contract addresses are missing.',
    severity: SEVERITY.FAIL,
    phase: PHASE.CHAIN
  },
  CHAIN_ID_MISMATCH: {
    code: 'CHAIN_ID_MISMATCH',
    summary: 'Connected chain ID does not match the selected CIST mode.',
    severity: SEVERITY.FAIL,
    phase: PHASE.CHAIN
  },
  CONTRACT_ESCROW_UNREACHABLE: {
    code: 'CONTRACT_ESCROW_UNREACHABLE',
    summary: 'PilotEscrow contract could not be reached or has no bytecode.',
    severity: SEVERITY.FAIL,
    phase: PHASE.CHAIN
  },
  CONTRACT_REGISTRY_UNREACHABLE: {
    code: 'CONTRACT_REGISTRY_UNREACHABLE',
    summary: 'VenomRegistry contract could not be reached or has no bytecode.',
    severity: SEVERITY.FAIL,
    phase: PHASE.CHAIN
  },
  PROD_BLOCKER_OPERATOR_PAYOUT_MISSING: {
    code: 'PROD_BLOCKER_OPERATOR_PAYOUT_MISSING',
    summary: 'PilotEscrow is missing the payOperatorBounty selector (production blocker).',
    severity: SEVERITY.WARN,
    phase: PHASE.CHAIN
  },
  PROD_BLOCKER_UNSTAKE_MISSING: {
    code: 'PROD_BLOCKER_UNSTAKE_MISSING',
    summary: 'VenomRegistry is missing the unstake selector (production blocker).',
    severity: SEVERITY.WARN,
    phase: PHASE.CHAIN
  },
  REDIS_NOT_CONFIGURED: {
    code: 'REDIS_NOT_CONFIGURED',
    summary: 'Redis client was not configured for the Redis and queue check.',
    severity: SEVERITY.WARN,
    phase: PHASE.REDIS
  },
  REDIS_UNREACHABLE: {
    code: 'REDIS_UNREACHABLE',
    summary: 'Redis is unreachable or did not respond to CIST preflight.',
    severity: SEVERITY.FAIL,
    phase: PHASE.REDIS
  },
  REDIS_NAMESPACE_COLLISION: {
    code: 'REDIS_NAMESPACE_COLLISION',
    summary: 'CIST Redis key namespace collided with an existing run.',
    severity: SEVERITY.FAIL,
    phase: PHASE.REDIS
  },
  QUEUE_NOT_CONFIGURED: {
    code: 'QUEUE_NOT_CONFIGURED',
    summary: 'Queue binding was not supplied for the Redis and queue check.',
    severity: SEVERITY.WARN,
    phase: PHASE.REDIS
  },
  QUEUE_BINDING_INVALID: {
    code: 'QUEUE_BINDING_INVALID',
    summary: 'Queue binding is missing required methods or a queue name.',
    severity: SEVERITY.FAIL,
    phase: PHASE.REDIS
  },
  ML_NOT_CONFIGURED: {
    code: 'ML_NOT_CONFIGURED',
    summary: 'ML service client was not configured; ML health probe was not run.',
    severity: SEVERITY.WARN,
    phase: PHASE.ML
  },
  ML_HEALTH_FAILED: {
    code: 'ML_HEALTH_FAILED',
    summary: 'ML service health check threw an error or was unreachable.',
    severity: SEVERITY.FAIL,
    phase: PHASE.ML
  },
  ML_HEALTH_SCHEMA_INVALID: {
    code: 'ML_HEALTH_SCHEMA_INVALID',
    summary: 'ML service health response did not match the expected schema.',
    severity: SEVERITY.FAIL,
    phase: PHASE.ML
  },
  PAYLOAD_NOT_CONFIGURED: {
    code: 'PAYLOAD_NOT_CONFIGURED',
    summary: 'Payload source was not configured for payload resolution.',
    severity: SEVERITY.WARN,
    phase: PHASE.PAYLOAD
  },
  PAYLOAD_LOAD_FAILED: {
    code: 'PAYLOAD_LOAD_FAILED',
    summary: 'Payload could not be loaded from the configured source.',
    severity: SEVERITY.FAIL,
    phase: PHASE.PAYLOAD
  },
  PAYLOAD_SCHEMA_INVALID: {
    code: 'PAYLOAD_SCHEMA_INVALID',
    summary: 'Loaded payload did not match the expected schema.',
    severity: SEVERITY.FAIL,
    phase: PHASE.PAYLOAD
  },
  WORKER_NOT_CONFIGURED: {
    code: 'WORKER_NOT_CONFIGURED',
    summary: 'Worker was not configured for the decision probe.',
    severity: SEVERITY.WARN,
    phase: PHASE.WORKER
  },
  WORKER_NO_PAYLOAD: {
    code: 'WORKER_NO_PAYLOAD',
    summary: 'No payload was available for the worker decision probe.',
    severity: SEVERITY.WARN,
    phase: PHASE.WORKER
  },
  WORKER_DECISION_TIMEOUT: {
    code: 'WORKER_DECISION_TIMEOUT',
    summary: 'Worker decision did not complete before the timeout.',
    severity: SEVERITY.FAIL,
    phase: PHASE.WORKER
  },
  WORKER_DECISION_INVALID: {
    code: 'WORKER_DECISION_INVALID',
    summary: 'Worker decision input or output did not match the expected schema.',
    severity: SEVERITY.FAIL,
    phase: PHASE.WORKER
  },
  WORKER_THREW: {
    code: 'WORKER_THREW',
    summary: 'Worker threw while producing a decision.',
    severity: SEVERITY.FAIL,
    phase: PHASE.WORKER
  },
  P2P_NOT_CONFIGURED: {
    code: 'P2P_NOT_CONFIGURED',
    summary: 'No oracle factory was configured for the P2P/signature aggregation probe.',
    severity: SEVERITY.WARN,
    phase: PHASE.P2P
  },
  FIXTURE_KEY_MISUSE: {
    code: 'FIXTURE_KEY_MISUSE',
    summary: 'Fixture oracle keys were used or requested on a non-fixture chain.',
    severity: SEVERITY.FAIL,
    phase: PHASE.P2P
  },
  P2P_CHAIN_ID_MISSING: {
    code: 'P2P_CHAIN_ID_MISSING',
    summary: 'P2P aggregation could not determine the chain ID.',
    severity: SEVERITY.FAIL,
    phase: PHASE.P2P
  },
  P2P_WORKER_DECISION_MISSING: {
    code: 'P2P_WORKER_DECISION_MISSING',
    summary: 'P2P aggregation could not find a valid worker decision to sign.',
    severity: SEVERITY.FAIL,
    phase: PHASE.P2P
  },
  P2P_WORKER_DECISION_INVALID: {
    code: 'P2P_WORKER_DECISION_INVALID',
    summary: 'P2P aggregation received a malformed worker decision.',
    severity: SEVERITY.FAIL,
    phase: PHASE.P2P
  },
  P2P_ORACLE_FACTORY_INVALID: {
    code: 'P2P_ORACLE_FACTORY_INVALID',
    summary: 'Oracle factory is missing required createOracles() behavior.',
    severity: SEVERITY.FAIL,
    phase: PHASE.P2P
  },
  P2P_ORACLE_SIGNATURE_INVALID: {
    code: 'P2P_ORACLE_SIGNATURE_INVALID',
    summary: 'One or more oracle signatures did not match the expected shape.',
    severity: SEVERITY.FAIL,
    phase: PHASE.P2P
  },
  P2P_QUORUM_NOT_REACHED: {
    code: 'P2P_QUORUM_NOT_REACHED',
    summary: 'Oracle signature quorum was not reached.',
    severity: SEVERITY.FAIL,
    phase: PHASE.P2P
  },
  P2P_ORACLE_THREW: {
    code: 'P2P_ORACLE_THREW',
    summary: 'Oracle factory threw during aggregation.',
    severity: SEVERITY.FAIL,
    phase: PHASE.P2P
  },
  REPORT_WRITE_FAILED: {
    code: 'REPORT_WRITE_FAILED',
    summary: 'CIST could not write one or more report artifacts.',
    severity: SEVERITY.FAIL,
    phase: PHASE.REPORT
  },
  REPORT_REDACTION_FAILED: {
    code: 'REPORT_REDACTION_FAILED',
    summary: 'Report redaction scan failed or detected secret-shaped content.',
    severity: SEVERITY.FAIL,
    phase: PHASE.REPORT
  },
  TEARDOWN_FORCE_CLOSE_USED: {
    code: 'TEARDOWN_FORCE_CLOSE_USED',
    summary: 'CIST used force-close during teardown after a timeout.',
    severity: SEVERITY.WARN,
    phase: PHASE.REPORT
  },
  TEARDOWN_OPEN_HANDLES: {
    code: 'TEARDOWN_OPEN_HANDLES',
    summary: 'CIST detected open handles after producing the run result.',
    severity: SEVERITY.WARN,
    phase: PHASE.REPORT
  },
  TEARDOWN_TIMEOUT: {
    code: 'TEARDOWN_TIMEOUT',
    summary: 'Teardown exceeded the hard timeout and force-close was used.',
    severity: SEVERITY.WARN,
    phase: PHASE.REPORT
  },
  CIST_UNEXPECTED_ERROR: {
    code: 'CIST_UNEXPECTED_ERROR',
    summary: 'CIST encountered an unexpected harness error.',
    severity: SEVERITY.FAIL,
    phase: PHASE.REPORT
  }
});

function getCode(code) {
  return CODES[code] || null;
}

function requireCode(code) {
  const entry = getCode(code);
  if (!entry) {
    throw new Error(`Unknown CIST code: ${code}`);
  }
  return entry;
}

function listCodes() {
  return Object.values(CODES);
}

module.exports = {
  SEVERITY,
  PHASE,
  CODES,
  getCode,
  requireCode,
  listCodes
};
