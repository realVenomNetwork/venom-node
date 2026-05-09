const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");

describe("Regression: Docker runtime filesystem", function () {
  it("creates the runtime artifact directory for the node user", function () {
    // Regression: MAIN-FIX-12
    const text = fs.readFileSync(path.resolve(__dirname, "../Dockerfile"), "utf8");

    expect(text).to.match(/mkdir\s+-p\s+\/app\/\.venom-artifacts/);
    expect(text).to.match(/chown[^\n]*node[^\n]*\/app\/\.venom-artifacts/);
  });
});
