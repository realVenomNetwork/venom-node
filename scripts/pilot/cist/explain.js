'use strict';

const { PHASES, STATE } = require('./phases');
const { listCodes } = require('./codes');

function buildExplainModel() {
  return {
    phases: PHASES.map((phase) => ({
      index: phase.index,
      key: phase.key,
      name: phase.name,
      codesDeferred: Boolean(phase.codesDeferred)
    })),
    states: Object.values(STATE),
    codes: listCodes().map((code) => ({
      code: code.code,
      severity: code.severity,
      phase: code.phase,
      summary: code.summary
    }))
  };
}

function renderExplainText(model = buildExplainModel()) {
  const lines = [
    'VENOM CIST --explain',
    'Fixture mode is the canonical repeatable mode and does not touch live funds or live state.',
    '',
    'PHASES'
  ];

  for (const phase of model.phases) {
    lines.push(`PHASE ${phase.index}|${phase.key}|${phase.name}|codesDeferred=${phase.codesDeferred}`);
  }

  lines.push('', 'STATES');
  for (const state of model.states) {
    lines.push(`STATE ${state}`);
  }

  lines.push('', 'CODES');
  for (const code of model.codes) {
    lines.push(`CODE ${code.code}|phase=${code.phase}|severity=${code.severity}|summary=${code.summary}`);
  }

  return `${lines.join('\n')}\n`;
}

module.exports = {
  buildExplainModel,
  renderExplainText
};
