const { expect } = require('chai');

const { CODES, SEVERITY, listCodes } = require('../codes');
const { PHASES } = require('../phases');
const { main } = require('../../smoke-test');

function parseExplain(stdout) {
  const phases = [];
  const codes = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('PHASE ')) {
      const [index, key, name, codesDeferred] = line.slice('PHASE '.length).split('|');
      phases.push({
        index: Number(index),
        key,
        name,
        codesDeferred: codesDeferred === 'codesDeferred=true',
      });
    }

    if (line.startsWith('CODE ')) {
      const [code, phase, severity, summary] = line.slice('CODE '.length).split('|');
      codes.push({
        code,
        phase: Number(phase.replace(/^phase=/, '')),
        severity: severity.replace(/^severity=/, ''),
        summary: summary.replace(/^summary=/, ''),
      });
    }
  }

  return { phases, codes };
}

describe('CIST explain parity', () => {
  let parsed;

  before(async () => {
    let stdout = '';
    const originalWrite = process.stdout.write;

    process.stdout.write = (chunk, encoding, callback) => {
      stdout += chunk.toString();
      if (typeof callback === 'function') callback();
      return true;
    };

    try {
      await main(['--explain']);
    } finally {
      process.stdout.write = originalWrite;
    }

    parsed = parseExplain(stdout);
  });

  it('includes every runtime phase in --explain output', () => {
    const explainedPhaseIndexes = new Set(parsed.phases.map((phase) => phase.index));
    const explainedPhaseNames = new Set(parsed.phases.map((phase) => phase.name));

    for (const phase of PHASES) {
      expect(explainedPhaseIndexes.has(phase.index)).to.equal(true);
      expect(explainedPhaseNames.has(phase.name)).to.equal(true);
    }
  });

  it('keeps codesDeferred in explain output aligned with runtime phase metadata', () => {
    const explainedByIndex = new Map(parsed.phases.map((phase) => [phase.index, phase]));

    for (const phase of PHASES) {
      expect(explainedByIndex.get(phase.index).codesDeferred).to.equal(Boolean(phase.codesDeferred));
    }
  });

  it('does not expose phases that are absent from runtime phase definitions', () => {
    const runtimePhaseIndexes = new Set(PHASES.map((phase) => phase.index));
    const runtimePhaseNames = new Set(PHASES.map((phase) => phase.name));

    for (const phase of parsed.phases) {
      expect(runtimePhaseIndexes.has(phase.index)).to.equal(true);
      expect(runtimePhaseNames.has(phase.name)).to.equal(true);
    }
  });

  it('includes every registry code in --explain output', () => {
    const explainedCodes = new Set(parsed.codes.map((entry) => entry.code));

    for (const code of Object.keys(CODES)) {
      expect(explainedCodes.has(code)).to.equal(true);
    }
  });

  it('keeps registry code metadata complete', () => {
    const severities = new Set(Object.values(SEVERITY));
    const phaseIndexes = new Set(PHASES.map((phase) => phase.index));

    for (const entry of listCodes()) {
      expect(entry.code).to.be.a('string').and.not.equal('');
      expect(entry.summary).to.be.a('string').and.not.equal('');
      expect(severities.has(entry.severity)).to.equal(true);
      expect(phaseIndexes.has(entry.phase)).to.equal(true);
    }
  });

  it('does not contain orphan codes', () => {
    const runtimePhaseIndexes = new Set(PHASES.map((phase) => phase.index));

    for (const entry of listCodes()) {
      expect(runtimePhaseIndexes.has(entry.phase)).to.equal(true);
    }
  });

  it('does not contain orphan phases unless intentionally marked', () => {
    const phaseIndexesWithCodes = new Set(listCodes().map((entry) => entry.phase));

    for (const phase of PHASES) {
      if (!phaseIndexesWithCodes.has(phase.index)) {
        expect(phase.codesDeferred).to.equal(true);
      }
    }
  });

  it('does not mark phases as codesDeferred when codes exist for them', () => {
    const phaseIndexesWithCodes = new Set(listCodes().map((entry) => entry.phase));

    for (const phase of PHASES) {
      if (phaseIndexesWithCodes.has(phase.index)) {
        expect(phase.codesDeferred).to.not.equal(true);
      }
    }
  });
});
