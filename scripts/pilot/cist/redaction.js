'use strict';

const { performance } = require('node:perf_hooks');

const REDACTION_TIMEOUT_MS = 5000;

const REASON = Object.freeze({
  MATCH_FOUND: 'match_found',
  SCAN_TIMEOUT: 'scan_timeout',
  SCANNER_ERROR: 'scanner_error'
});

const PATTERNS = Object.freeze([
  Object.freeze({
    patternId: 'hex_private_key_64',
    label: '0x-prefixed 32-byte hex string',
    description: 'Potential Ethereum private-key-shaped value',
    severity: 'block',
    enabledByDefault: true,
    regex: /0x[a-fA-F0-9]{64}/g
  }),
  Object.freeze({
    patternId: 'bip39_mnemonic_12',
    label: '12-word mnemonic-shaped phrase',
    description: 'Potential 12-word seed phrase',
    severity: 'block',
    enabledByDefault: true,
    regex: /\b(?:[a-z]{3,8}\s+){11}[a-z]{3,8}\b/gi
  }),
  Object.freeze({
    patternId: 'bip39_mnemonic_24',
    label: '24-word mnemonic-shaped phrase',
    description: 'Potential 24-word seed phrase',
    severity: 'block',
    enabledByDefault: true,
    regex: /\b(?:[a-z]{3,8}\s+){23}[a-z]{3,8}\b/gi
  }),
  Object.freeze({
    patternId: 'jwt_compact',
    label: 'JWT compact token',
    description: 'Potential JSON Web Token',
    severity: 'block',
    enabledByDefault: true,
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
  }),
  Object.freeze({
    patternId: 'aws_access_key_id',
    label: 'AWS Access Key ID',
    description: 'Potential AWS access key ID',
    severity: 'block',
    enabledByDefault: true,
    regex: /\bAKIA[0-9A-Z]{16}\b/g
  }),
  Object.freeze({
    patternId: 'bearer_authorization_header',
    label: 'Bearer authorization header',
    description: 'Potential Authorization: Bearer token',
    severity: 'block',
    enabledByDefault: true,
    regex: /Authorization:\s*Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi
  }),
  Object.freeze({
    patternId: 'high_entropy_string',
    label: 'High-entropy string',
    description: 'Potential secret-shaped high-entropy value',
    severity: 'block',
    enabledByDefault: false,
    regex: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g
  })
]);

function normalizeInput(input) {
  if (Buffer.isBuffer(input)) return input.toString('utf8');
  if (typeof input === 'string') return input;
  if (input === null || input === undefined) return '';

  try {
    return JSON.stringify(input, (_key, value) => {
      if (Buffer.isBuffer(value)) return value.toString('hex');
      return value;
    });
  } catch {
    return String(input);
  }
}

function maskSample(value) {
  if (!value || value.length <= 12) return '[REDACTED]';
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function createMatch(pattern, source, match) {
  return {
    patternId: pattern.patternId,
    label: pattern.label,
    severity: pattern.severity,
    source,
    index: match.index,
    length: match[0].length,
    sample: maskSample(match[0])
  };
}

function scanContentForSecrets(input, options = {}) {
  const {
    timeoutMs = REDACTION_TIMEOUT_MS,
    enableHighEntropy = false,
    source = 'content'
  } = options;

  if (timeoutMs <= 0) {
    return {
      safe: false,
      reason: REASON.SCAN_TIMEOUT,
      matches: []
    };
  }

  const started = performance.now();
  const content = normalizeInput(input);
  const matches = [];

  function assertWithinTimeout() {
    if (performance.now() - started > timeoutMs) {
      const error = new Error(`Redaction scan exceeded ${timeoutMs}ms`);
      error.reason = REASON.SCAN_TIMEOUT;
      throw error;
    }
  }

  try {
    for (const pattern of PATTERNS) {
      assertWithinTimeout();

      if (!pattern.enabledByDefault && !(enableHighEntropy && pattern.patternId === 'high_entropy_string')) {
        continue;
      }

      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      let match;

      while ((match = regex.exec(content)) !== null) {
        assertWithinTimeout();
        matches.push(createMatch(pattern, source, match));

        if (match[0].length === 0) {
          regex.lastIndex += 1;
        }
      }
    }
  } catch (error) {
    if (error.reason === REASON.SCAN_TIMEOUT) {
      return {
        safe: false,
        reason: REASON.SCAN_TIMEOUT,
        matches: sortMatches(matches)
      };
    }

    return {
      safe: false,
      reason: REASON.SCANNER_ERROR,
      matches: sortMatches(matches),
      errorMessage: error.message
    };
  }

  const sortedMatches = sortMatches(matches);
  return {
    safe: sortedMatches.length === 0,
    reason: sortedMatches.length > 0 ? REASON.MATCH_FOUND : null,
    matches: sortedMatches
  };
}

function sortMatches(matches) {
  return [...matches].sort((a, b) => {
    if (a.index !== b.index) return a.index - b.index;
    return b.length - a.length;
  });
}

function assertContentIsSafe(input, options = {}) {
  const result = scanContentForSecrets(input, options);

  if (!result.safe) {
    const error = new Error('REPORT_REDACTION_FAILED: secret-shaped content detected');
    error.code = 'REPORT_REDACTION_FAILED';
    error.redaction = {
      blocked: true,
      reason: result.reason,
      matches: result.matches
    };
    error.matches = result.matches;
    if (result.errorMessage) {
      error.redaction.errorMessage = result.errorMessage;
    }
    throw error;
  }

  return true;
}

function redactForDisplay(input, options = {}) {
  const content = normalizeInput(input);
  const result = scanContentForSecrets(content, options);

  if (result.safe || !result.matches.length) {
    return content;
  }

  let output = content;
  const sorted = [...result.matches].sort((a, b) => b.index - a.index);

  for (const match of sorted) {
    output = `${output.slice(0, match.index)}[REDACTED:${match.patternId}]${output.slice(match.index + match.length)}`;
  }

  return output;
}

const scanForSecrets = scanContentForSecrets;
const assertNoSecrets = assertContentIsSafe;

module.exports = {
  REDACTION_TIMEOUT_MS,
  REASON,
  PATTERNS,
  scanContentForSecrets,
  assertContentIsSafe,
  redactForDisplay,
  scanForSecrets,
  assertNoSecrets,
  maskSample
};
