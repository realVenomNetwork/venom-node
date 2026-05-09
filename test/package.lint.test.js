const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");

describe("Regression: package runtime metadata", function () {
  it("requires Node 22+ for the runtime and Docker image", function () {
    // Regression: MAIN-FIX-5
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"));
    const dockerfile = fs.readFileSync(path.resolve(__dirname, "../Dockerfile"), "utf8");

    expect(pkg.name).to.equal("venom-network");
    expect(pkg.engines.node).to.equal(">=22.0.0");
    expect(dockerfile).to.match(/^FROM node:22-alpine/m);
  });
});
