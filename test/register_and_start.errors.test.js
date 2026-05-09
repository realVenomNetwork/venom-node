const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");

describe("Regression: operator startup guardrail messages", function () {
  const source = () => fs.readFileSync(path.resolve(__dirname, "../register_and_start.js"), "utf8");

  it("keeps deployer-key rejection actionable for operators", function () {
    // Regression: MAIN-FIX-7
    const text = source();

    expect(text).to.include("DEPLOYER_PRIVATE_KEY must not be set in the operator process");
    expect(text).to.include("Use OPERATOR_PRIVATE_KEY only");
    expect(text).to.include("comment out or remove DEPLOYER_PRIVATE_KEY");
  });

  it("keeps the private multiaddr escape hatch explicitly solo-only", function () {
    // Regression: MAIN-FIX-9
    const text = source();

    expect(text).to.include("VENOM_ALLOW_PRIVATE_MULTIADDR=true: registering a private or non-public multiaddr");
    expect(text).to.include("intended only for solo test setups");
    expect(text).to.include("must not be used for production pilots");
  });
});
