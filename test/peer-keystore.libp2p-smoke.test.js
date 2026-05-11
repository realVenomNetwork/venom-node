'use strict';

const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadOrCreatePeerPrivateKey } = require('../aggregator/peer-keystore');

let libp2pModulesPromise = null;
function loadLibp2pModules() {
  if (!libp2pModulesPromise) {
    libp2pModulesPromise = (async () => {
      const [
        { createLibp2p },
        { tcp },
        { noise },
        { yamux },
      ] = await Promise.all([
        import('libp2p'),
        import('@libp2p/tcp'),
        import('@chainsafe/libp2p-noise'),
        import('@chainsafe/libp2p-yamux'),
      ]);
      return { createLibp2p, tcp, noise, yamux };
    })();
  }
  return libp2pModulesPromise;
}

async function startMinimalLibp2p({ keystorePath }) {
  const { createLibp2p, tcp, noise, yamux } = await loadLibp2pModules();
  const persistentPrivateKey = await loadOrCreatePeerPrivateKey(keystorePath);
  const config = {
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
  };
  if (persistentPrivateKey) {
    config.privateKey = persistentPrivateKey;
  }
  return createLibp2p(config);
}

describe('peer-keystore + libp2p integration', function () {
  this.timeout(15000);

  let tmpdir;

  beforeEach(function () {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-p2p-identity-smoke-'));
  });

  afterEach(function () {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  it('keeps the same peer ID across libp2p instances using the same keystore', async function () {
    const keystorePath = path.join(tmpdir, 'libp2p-key');

    const node1 = await startMinimalLibp2p({ keystorePath });
    const peerId1 = node1.peerId.toString();
    await node1.stop();

    const node2 = await startMinimalLibp2p({ keystorePath });
    const peerId2 = node2.peerId.toString();
    await node2.stop();

    expect(peerId1).to.equal(peerId2);
    expect(peerId1).to.match(/^(12D3Koo|Qm)/);
  });

  it('uses different peer IDs for different keystore paths', async function () {
    const node1 = await startMinimalLibp2p({ keystorePath: path.join(tmpdir, 'a') });
    const node2 = await startMinimalLibp2p({ keystorePath: path.join(tmpdir, 'b') });

    const peerId1 = node1.peerId.toString();
    const peerId2 = node2.peerId.toString();

    await node1.stop();
    await node2.stop();

    expect(peerId1).to.not.equal(peerId2);
  });

  it('preserves ephemeral peer IDs when no keystore path is configured', async function () {
    const node1 = await startMinimalLibp2p({ keystorePath: null });
    const node2 = await startMinimalLibp2p({ keystorePath: null });

    const peerId1 = node1.peerId.toString();
    const peerId2 = node2.peerId.toString();

    await node1.stop();
    await node2.stop();

    expect(peerId1).to.not.equal(peerId2);
  });
});
