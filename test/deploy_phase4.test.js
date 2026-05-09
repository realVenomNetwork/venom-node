const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");

describe("Regression: deployment bind finality", function () {
  it("waits for public-network confirmations and reads the bind back with retry", function () {
    // Regression: MAIN-FIX-4
    const text = fs.readFileSync(path.resolve(__dirname, "../scripts/deploy_phase4.js"), "utf8");

    expect(text).to.match(/const\s+bindConfirmations\s*=\s*hre\.network\.name\s*===\s*"hardhat"\s*\?\s*1\s*:\s*3\s*;/);
    expect(text).to.match(/await\s+bindTx\.wait\(\s*bindConfirmations\s*\)/);
    expect(text).to.include("readWithRetry(");
    expect(text).to.include('"Registry PilotEscrow bind"');
  });
});
