'use strict';

const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PeerKeystoreError,
  loadOrCreatePeerPrivateKey,
} = require('../aggregator/peer-keystore');

describe('aggregator/peer-keystore', function () {
  let tmpdir;

  beforeEach(function () {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-peer-keystore-'));
  });

  afterEach(function () {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  it('returns null when no keystore path is provided', async function () {
    expect(await loadOrCreatePeerPrivateKey(null)).to.equal(null);
    expect(await loadOrCreatePeerPrivateKey(undefined)).to.equal(null);
    expect(await loadOrCreatePeerPrivateKey('')).to.equal(null);
  });

  it('creates a new key file on first use', async function () {
    const keystorePath = path.join(tmpdir, 'libp2p-key');

    const key = await loadOrCreatePeerPrivateKey(keystorePath);

    expect(key).to.not.equal(null);
    expect(fs.existsSync(keystorePath)).to.equal(true);
    const stat = fs.statSync(keystorePath);
    expect(stat.size).to.be.greaterThan(0);
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).to.equal(0o600);
    }
  });

  it('reuses an existing key file without rewriting it', async function () {
    const keystorePath = path.join(tmpdir, 'libp2p-key');

    const firstKey = await loadOrCreatePeerPrivateKey(keystorePath);
    const firstBytes = fs.readFileSync(keystorePath);
    const firstMtime = fs.statSync(keystorePath).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 25));

    const secondKey = await loadOrCreatePeerPrivateKey(keystorePath);
    const secondBytes = fs.readFileSync(keystorePath);
    const secondMtime = fs.statSync(keystorePath).mtimeMs;

    expect(Buffer.compare(firstBytes, secondBytes)).to.equal(0);
    expect(secondMtime).to.equal(firstMtime);

    const keys = await import('@libp2p/crypto/keys');
    expect(Buffer.compare(
      Buffer.from(keys.privateKeyToProtobuf(firstKey)),
      Buffer.from(keys.privateKeyToProtobuf(secondKey))
    )).to.equal(0);
  });

  it('fails with an actionable error when the key file is malformed', async function () {
    const keystorePath = path.join(tmpdir, 'libp2p-key');
    fs.writeFileSync(keystorePath, Buffer.from('not-a-valid-protobuf-blob'));

    let caught;
    try {
      await loadOrCreatePeerPrivateKey(keystorePath);
    } catch (error) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(PeerKeystoreError);
    expect(caught.message).to.include(keystorePath);
    expect(caught.message).to.match(/remove the file/i);
    expect(caught.cause).to.be.instanceOf(Error);
  });

  it('fails with an actionable error when the key file is empty', async function () {
    const keystorePath = path.join(tmpdir, 'libp2p-key');
    fs.writeFileSync(keystorePath, Buffer.alloc(0));

    let caught;
    try {
      await loadOrCreatePeerPrivateKey(keystorePath);
    } catch (error) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(PeerKeystoreError);
    expect(caught.message).to.include(keystorePath);
    expect(caught.message).to.match(/empty/i);
    expect(caught.message).to.match(/remove the file/i);
  });
});
