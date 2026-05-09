const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");

describe("Regression: Redis queue configuration", function () {
  it("defaults Redis node auth to the venom_node ACL user", function () {
    // Regression: MAIN-FIX-6
    const text = fs.readFileSync(path.resolve(__dirname, "../aggregator/queue.js"), "utf8");

    expect(text).to.include("process.env.REDIS_USERNAME || 'venom_node'");
    expect(text).to.match(/username:\s*REDIS_USERNAME/);
  });
});
