const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");

describe("Regression: Hardhat verification config", function () {
  it("uses one Etherscan V2 API key instead of per-chain V1 keys", function () {
    // Regression: MAIN-FIX-8
    const text = fs.readFileSync(path.resolve(__dirname, "../hardhat.config.js"), "utf8");

    expect(text).to.include("apiKey: process.env.ETHERSCAN_API_KEY");
    expect(text).to.not.match(/apiKey:\s*\{[^}]*baseSepolia/s);
    expect(text).to.not.include("BASESCAN_API_KEY");
  });
});
