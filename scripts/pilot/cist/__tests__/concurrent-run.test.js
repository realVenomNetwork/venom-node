'use strict';

const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCistPhases } = require('../../smoke-test');
const { buildRunContext } = require('../config');

function makeMockProvider() {
  return {
    getNetwork: async () => ({ chainId: 31337, name: 'hardhat' }),
    getCode: async () => '0x608060405234801561001057600080fd5b5060005260206000f3',
  };
}

describe('CIST Concurrent Run Isolation', function () {
  this.timeout(15_000);

  it('buildRunContext produces unique runIds and runDirs under rapid successive calls', function () {
    const contexts = Array.from({ length: 10 }, () =>
      buildRunContext({ argv: [], env: process.env })
    );

    const uniqueRunIds = new Set(contexts.map((c) => c.runId));
    const uniqueRunDirs = new Set(contexts.map((c) => c.runDir));

    expect(uniqueRunIds.size).to.equal(10);
    expect(uniqueRunDirs.size).to.equal(10);

    // Cleanup created directories
    for (const ctx of contexts) {
      if (fs.existsSync(ctx.runDir)) {
        fs.rmSync(ctx.runDir, { recursive: true, force: true });
      }
    }
  });

  it('two parallel runCistPhases calls complete without collision', async function () {
    async function runOne(label) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `cist-concurrent-${label}-`));
      const runDir = path.join(root, 'run');
      fs.mkdirSync(runDir, { recursive: true });

      const context = buildRunContext({
        argv: [],
        env: process.env,
      });

      const result = await runCistPhases(context, {
        env: {},
        provider: makeMockProvider(),
        escrowAddress: '0x1234567890123456789012345678901234567890',
        registryAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        payloadSource: async () => ({ campaignUid: `concurrent-${label}` }),
        worker: {
          process: async () => ({
            campaignUid: `concurrent-${label}`,
            decision: 'approve',
            score: 0.95,
            reason: 'concurrent test',
          }),
        },
        oracleFactory: { createOracles: async () => [] },
      });

      return { root, context, result };
    }

    const [runA, runB] = await Promise.all([runOne('A'), runOne('B')]);

    try {
      // Core isolation assertions
      expect(runA.context.runId).to.not.equal(runB.context.runId);
      expect(runA.context.runDir).to.not.equal(runB.context.runDir);

      // Both runs produced full phase results
      expect(runA.result.phases).to.have.length(8);
      expect(runB.result.phases).to.have.length(8);
    } finally {
      fs.rmSync(runA.root, { recursive: true, force: true });
      fs.rmSync(runB.root, { recursive: true, force: true });
    }
  });
});