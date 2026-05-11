'use strict';

const fs = require('node:fs');
const path = require('node:path');

class PeerKeystoreError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'PeerKeystoreError';
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

async function loadKeysModule() {
  const keys = await import('@libp2p/crypto/keys');
  for (const fn of ['generateKeyPair', 'privateKeyFromProtobuf', 'privateKeyToProtobuf']) {
    if (typeof keys[fn] !== 'function') {
      throw new PeerKeystoreError(
        `@libp2p/crypto/keys.${fn} is not available. Check the installed @libp2p/crypto version.`
      );
    }
  }
  return keys;
}

async function loadOrCreatePeerPrivateKey(keystorePath) {
  if (!keystorePath || typeof keystorePath !== 'string') return null;

  const keys = await loadKeysModule();

  if (fs.existsSync(keystorePath)) {
    let bytes;
    try {
      bytes = fs.readFileSync(keystorePath);
    } catch (error) {
      throw new PeerKeystoreError(
        `Could not read persistent peer key at ${keystorePath}: ${error.message}. Check file permissions.`,
        { cause: error }
      );
    }

    if (bytes.length === 0) {
      throw new PeerKeystoreError(
        `Persistent peer key at ${keystorePath} is empty. Remove the file to regenerate, or restore it from backup.`
      );
    }

    try {
      const privateKey = keys.privateKeyFromProtobuf(bytes);
      console.log(`[P2P] Loaded persistent peer key from ${keystorePath}`);
      return privateKey;
    } catch (error) {
      throw new PeerKeystoreError(
        `Could not parse persistent peer key at ${keystorePath}: ${error.message}. Remove the file to regenerate, or restore it from backup.`,
        { cause: error }
      );
    }
  }

  const privateKey = await keys.generateKeyPair('Ed25519');
  const bytes = keys.privateKeyToProtobuf(privateKey);
  fs.mkdirSync(path.dirname(keystorePath), { recursive: true });
  fs.writeFileSync(keystorePath, Buffer.from(bytes), { mode: 0o600 });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(keystorePath, 0o600);
    } catch {
      // Best effort: some filesystems do not support POSIX mode updates.
    }
  }
  console.log(`[P2P] Generated and persisted new peer key at ${keystorePath}`);
  return privateKey;
}

module.exports = {
  PeerKeystoreError,
  loadOrCreatePeerPrivateKey,
};
