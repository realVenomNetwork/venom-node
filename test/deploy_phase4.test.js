const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");

describe("Regression: deployment bind finality", function () {
  it("waits for public-network confirmations and reads the bind back with retry", function () {
    // Regression: MAIN-FIX-4
    const text = fs.readFileSync(path.resolve(__dirname, "../scripts/deploy_phase4.js"), "utf8");

    expect(text).to.include("await bindTx.wait(3)");
    expect(text).to.include("readWithRetry(");
    expect(text).to.include('"Registry PilotEscrow bind"');
  });
});
