'use strict';

const { expect } = require('chai');
const http = require('node:http');

const { startHealthServer, VERSION } = require('../register_and_start');

function fakeP2P({ peerId = '12D3KooWHttpTestPeer', peers = 2 } = {}) {
  return {
    peerId: { toString: () => peerId },
    getPeers: () => new Array(peers),
  };
}

function fakeWorker({ name = 'venom-campaigns', running = true } = {}) {
  return { name, isRunning: () => running };
}

function fakeProducer() {
  return { stop: () => {} };
}

function fakeQueueModule({ ping = async () => 'PONG', status = 'ready' } = {}) {
  return {
    getConnection: () => ({ status, ping }),
  };
}

function makeRequest(server, requestPath) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method: 'GET',
      headers: { Connection: 'close' },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body,
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function waitForListening(server) {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve) => server.once('listening', resolve));
}

function closeServer(server) {
  if (typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }
  return new Promise((resolve) => server.close(resolve));
}

function healthyDeps() {
  return {
    p2pNode: fakeP2P(),
    workerHandle: fakeWorker(),
    producerHandle: fakeProducer(),
    queueModule: fakeQueueModule(),
  };
}

describe('startHealthServer HTTP behavior', function () {
  this.timeout(5000);

  let server;

  afterEach(async function () {
    if (server) {
      await closeServer(server);
      server = null;
    }
  });

  it('responds 200 with readiness JSON on /healthz when all subsystems are healthy', async function () {
    server = startHealthServer({
      getDeps: healthyDeps,
      port: 0,
      host: '127.0.0.1',
      version: '4.5.6',
      logger: () => {},
    });
    await waitForListening(server);

    const res = await makeRequest(server, '/healthz');
    expect(res.statusCode).to.equal(200);
    expect(res.headers['content-type']).to.match(/application\/json/);

    const body = JSON.parse(res.body);
    expect(body.ok).to.equal(true);
    expect(body.version).to.equal('4.5.6');
    expect(body.checks).to.have.all.keys('libp2p', 'worker', 'producer', 'redis');
    expect(body.checks.libp2p.peers).to.equal(2);
  });

  it('returns legacy health JSON on /health when redis responds', async function () {
    server = startHealthServer({
      getDeps: healthyDeps,
      port: 0,
      host: '127.0.0.1',
      version: '4.5.6',
      logger: () => {},
    });
    await waitForListening(server);

    const res = await makeRequest(server, '/health');
    expect(res.statusCode).to.equal(200);
    const body = JSON.parse(res.body);
    expect(body).to.include({ status: 'ok', version: '4.5.6' });
    expect(body.timestamp).to.be.a('string');
    expect(body).to.not.have.property('checks');
  });

  it('returns legacy error JSON on /health when redis ping rejects', async function () {
    server = startHealthServer({
      getDeps: () => ({
        ...healthyDeps(),
        queueModule: fakeQueueModule({ ping: async () => { throw new Error('ECONNREFUSED'); } }),
      }),
      port: 0,
      host: '127.0.0.1',
      logger: () => {},
    });
    await waitForListening(server);

    const res = await makeRequest(server, '/health');
    expect(res.statusCode).to.equal(503);
    const body = JSON.parse(res.body);
    expect(body.status).to.equal('error');
    expect(body.error).to.match(/ECONNREFUSED/);
    expect(body).to.not.have.property('checks');
  });

  it('keeps /health liveness-compatible when redis is healthy but readiness is not', async function () {
    server = startHealthServer({
      getDeps: () => ({
        ...healthyDeps(),
        workerHandle: null,
      }),
      port: 0,
      host: '127.0.0.1',
      logger: () => {},
    });
    await waitForListening(server);

    const health = await makeRequest(server, '/health');
    const healthz = await makeRequest(server, '/healthz');
    expect(health.statusCode).to.equal(200);
    expect(JSON.parse(health.body).status).to.equal('ok');
    expect(healthz.statusCode).to.equal(503);
    expect(JSON.parse(healthz.body).checks.worker.ok).to.equal(false);
  });

  it('responds 503 on /healthz when redis ping rejects', async function () {
    server = startHealthServer({
      getDeps: () => ({
        ...healthyDeps(),
        queueModule: fakeQueueModule({ ping: async () => { throw new Error('ECONNREFUSED'); } }),
      }),
      port: 0,
      host: '127.0.0.1',
      logger: () => {},
    });
    await waitForListening(server);

    const res = await makeRequest(server, '/healthz');
    expect(res.statusCode).to.equal(503);

    const body = JSON.parse(res.body);
    expect(body.ok).to.equal(false);
    expect(body.checks.redis.ok).to.equal(false);
    expect(body.checks.redis.reason).to.match(/ECONNREFUSED/);
  });

  it('responds 503 on /healthz when worker handle is missing', async function () {
    server = startHealthServer({
      getDeps: () => ({
        ...healthyDeps(),
        workerHandle: null,
      }),
      port: 0,
      host: '127.0.0.1',
      logger: () => {},
    });
    await waitForListening(server);

    const res = await makeRequest(server, '/healthz');
    expect(res.statusCode).to.equal(503);
    expect(JSON.parse(res.body).checks.worker.ok).to.equal(false);
  });

  it('responds 200 plain text on /', async function () {
    server = startHealthServer({
      getDeps: () => ({}),
      port: 0,
      host: '127.0.0.1',
      version: '7.7.7',
      logger: () => {},
    });
    await waitForListening(server);

    const res = await makeRequest(server, '/');
    expect(res.statusCode).to.equal(200);
    expect(res.headers['content-type']).to.match(/text\/plain/);
    expect(res.body).to.include('VENOM Node v7.7.7');
  });

  it('responds 404 on unknown paths', async function () {
    server = startHealthServer({
      getDeps: healthyDeps,
      port: 0,
      host: '127.0.0.1',
      logger: () => {},
    });
    await waitForListening(server);

    const res = await makeRequest(server, '/does-not-exist');
    expect(res.statusCode).to.equal(404);
  });

  it('returns 503 with an error field when getDeps throws', async function () {
    server = startHealthServer({
      getDeps: () => { throw new Error('deps blew up'); },
      port: 0,
      host: '127.0.0.1',
      logger: () => {},
    });
    await waitForListening(server);

    const res = await makeRequest(server, '/healthz');
    expect(res.statusCode).to.equal(503);

    const body = JSON.parse(res.body);
    expect(body.ok).to.equal(false);
    expect(body.error).to.match(/deps blew up/);
  });

  it('calls getDeps freshly on each request', async function () {
    let deps = {
      p2pNode: null,
      workerHandle: null,
      producerHandle: null,
      queueModule: fakeQueueModule(),
    };
    server = startHealthServer({
      getDeps: () => deps,
      port: 0,
      host: '127.0.0.1',
      logger: () => {},
    });
    await waitForListening(server);

    let res = await makeRequest(server, '/healthz');
    expect(res.statusCode).to.equal(503);

    deps = healthyDeps();
    res = await makeRequest(server, '/healthz');
    expect(res.statusCode).to.equal(200);
    expect(JSON.parse(res.body).ok).to.equal(true);
  });

  it('exports VERSION as a string', function () {
    expect(VERSION).to.be.a('string').and.match(/^\d+\.\d+\.\d+/);
  });
});
