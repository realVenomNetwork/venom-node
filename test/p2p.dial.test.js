const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");

describe("Regression: P2P dial guardrails", function () {
  it("skips re-dialing this node's own oracle multiaddr", function () {
    // Regression: MAIN-FIX-11
    const text = fs.readFileSync(path.resolve(__dirname, "../aggregator/p2p.js"), "utf8");

    expect(text).to.include("function isLocalOraclePeer(operator, addr)");
    expect(text).to.match(/if\s*\(\s*isLocalOraclePeer\(operators\[index\],\s*addr\)\s*\)\s*continue;/);
    expect(text).to.match(/await\s+libp2p\.dial\(multiaddr\(addr\)\)/);
  });

  it("enables mDNS discovery and allows registry-derived dialing to be disabled", function () {
    // Regression: MF-7
    const text = fs.readFileSync(path.resolve(__dirname, "../aggregator/p2p.js"), "utf8");

    expect(text).to.include("import('@libp2p/mdns')");
    expect(text).to.match(/peerDiscovery:\s*\[\s*mdns\(\)\s*\]/);
    const skipGuards = text.match(/process\.env\.VENOM_SKIP_REGISTRY_DIAL\s*===\s*'true'/g) || [];
    expect(skipGuards).to.have.lengthOf(2);
  });

  it("supports deterministic listen port via P2P_LISTEN_PORT", function () {
    // Regression: MF-7 partial - Module G bootstrap path
    const text = fs.readFileSync(path.resolve(__dirname, "../aggregator/p2p.js"), "utf8");

    expect(text).to.include("P2P_LISTEN_PORT");
    expect(text).to.match(/\/ip4\/0\.0\.0\.0\/tcp\/\$\{listenPort\}/);
  });

  it("dials bootstrap peers from P2P_BOOTSTRAP_PEERS", function () {
    // Regression: MF-7 partial - Module G bootstrap path
    const text = fs.readFileSync(path.resolve(__dirname, "../aggregator/p2p.js"), "utf8");

    expect(text).to.include("P2P_BOOTSTRAP_PEERS");
    expect(text).to.include("bootstrapPeerMultiaddr(peer)");
    expect(text).to.include("[P2P] Bootstrap dialed");
  });
});
