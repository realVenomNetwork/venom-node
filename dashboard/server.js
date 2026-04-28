#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

require("dotenv").config({ quiet: true });

const IORedis = require("ioredis");
const { assertRuntimeModeConfig } = require("../src/config/runtime-mode");
const { assertRedisReadOnlyConnection } = require("./redis-acl-sentinel");
const {
  DASHBOARD_EVENT_CHANNEL,
  readSnapshot,
  listSnapshots,
  buildReplayTimeline
} = require("../src/dashboard/quorum-replay");

const PUBLIC_DIR = path.join(__dirname, "public");
const HOST = process.env.DASHBOARD_HOST || "127.0.0.1";
const PORT = Number(process.env.DASHBOARD_PORT || 8787);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
});

const clients = new Set();
let redis = null;
let subscriber = null;
let runtimeConfig = null;

function assertLoopbackHost(host) {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("Dashboard must bind to localhost only. Set DASHBOARD_HOST=127.0.0.1.");
  }
}

function redisOptions() {
  return {
    host: process.env.DASHBOARD_REDIS_HOST || process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.DASHBOARD_REDIS_PORT || process.env.REDIS_PORT || 6379),
    username: process.env.DASHBOARD_REDIS_USERNAME || "venom_dash",
    password: process.env.DASHBOARD_REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: 2,
    lazyConnect: true
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const client of clients) {
    sendSse(client, event, data);
  }
}

async function latestPostcard() {
  const directory = path.resolve(runtimeConfig.postcardDirectory);
  try {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    const jsonFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(directory, entry.name));

    if (!jsonFiles.length) return null;

    const parsed = [];
    for (const file of jsonFiles) {
      try {
        const stat = await fs.promises.stat(file);
        const data = JSON.parse(await fs.promises.readFile(file, "utf8"));
        parsed.push({
          path: file,
          campaign_uid: data.campaign_uid,
          submitter: data.submitter,
          generated_at: data.generated_at,
          runtime_mode: data.runtime?.mode,
          mtime_ms: stat.mtimeMs
        });
      } catch {
        // Skip malformed local files; the generator validates new postcards.
      }
    }

    return parsed.sort((a, b) => b.mtime_ms - a.mtime_ms)[0] || null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function buildHeartbeat() {
  const snapshots = await listSnapshots(redis);
  const recentEvents = snapshots.flatMap((snapshot) => snapshot.events || []).slice(0, 500);
  const uniqueObservedSigners = new Set(
    recentEvents
      .filter((event) => event.signer)
      .map((event) => event.signer)
  );
  const redisPing = await redis.ping();

  return {
    local: {
      redis: redisPing === "PONG" ? "healthy" : "unknown",
      dashboard: "read-only",
      snapshots: snapshots.length,
      scope: "local_observation"
    },
    on_chain: {
      registry: process.env.VENOM_REGISTRY_ADDRESS ? "configured" : "not configured",
      escrow: process.env.PILOT_ESCROW_ADDRESS ? "configured" : "not configured",
      source: "local configuration"
    },
    p2p_mesh: {
      state: uniqueObservedSigners.size ? "observed peer messages" : "no recent local peer messages",
      observed_oracles: uniqueObservedSigners.size,
      source: "this node's Redis snapshots"
    }
  };
}

async function statusPayload() {
  return {
    runtime: {
      mode: runtimeConfig.runtimeMode,
      use_test_payload: runtimeConfig.useTestPayload,
      artifact_directory: runtimeConfig.artifactDirectory,
      postcard_directory: runtimeConfig.postcardDirectory
    },
    disclaimer: "Dashboard data is node-local. Quorum Replay is UI-only and reconstructed from this node's local observations only.",
    heartbeat: await buildHeartbeat(),
    latest_postcard: await latestPostcard()
  };
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/status") {
    sendJson(res, 200, await statusPayload());
    return;
  }

  if (url.pathname === "/api/campaigns") {
    const snapshots = await listSnapshots(redis);
    sendJson(res, 200, {
      scope: "local_observation",
      campaigns: snapshots.map((snapshot) => ({
        campaign_uid: snapshot.campaign_uid,
        updated_at: snapshot.updated_at,
        lantern: snapshot.lantern,
        event_count: Array.isArray(snapshot.events) ? snapshot.events.length : 0
      }))
    });
    return;
  }

  if (url.pathname.startsWith("/api/campaigns/") && url.pathname.endsWith("/replay")) {
    const campaignUid = decodeURIComponent(url.pathname.split("/")[3] || "");
    const durationMs = Number(url.searchParams.get("durationMs") || 45000);
    const snapshot = await readSnapshot(redis, campaignUid);
    sendJson(res, 200, buildReplayTimeline(snapshot, { durationMs }));
    return;
  }

  if (url.pathname === "/api/latest-postcard") {
    sendJson(res, 200, { latest_postcard: await latestPostcard() });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

function handleEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  clients.add(res);
  sendSse(res, "hello", {
    scope: "local_observation",
    message: "Connected to VENOM Oracle Hearth events."
  });
  req.on("close", () => {
    clients.delete(res);
  });
}

function serveStatic(res, pathname) {
  const requestPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(PUBLIC_DIR, `.${requestPath}`);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    const contentType = MIME_TYPES[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

async function requestHandler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (url.pathname === "/events") {
      handleEvents(req, res);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

async function start() {
  assertLoopbackHost(HOST);
  runtimeConfig = assertRuntimeModeConfig(process.env);

  redis = new IORedis(redisOptions());
  subscriber = new IORedis(redisOptions());
  await redis.connect();
  await subscriber.connect();

  await assertRedisReadOnlyConnection(redis);
  await subscriber.subscribe(DASHBOARD_EVENT_CHANNEL);
  subscriber.on("message", (_channel, message) => {
    try {
      broadcast("dashboard-event", JSON.parse(message));
    } catch {
      broadcast("dashboard-event", { malformed: true, raw: message });
    }
  });

  setInterval(async () => {
    try {
      broadcast("status", await statusPayload());
    } catch (error) {
      broadcast("health-error", { error: error.message });
    }
  }, 10000).unref();

  const server = http.createServer((req, res) => {
    requestHandler(req, res);
  });

  server.listen(PORT, HOST, () => {
    console.log(`VENOM Oracle Hearth dashboard listening at http://${HOST}:${PORT}`);
    console.log("Dashboard Redis connection verified read-only by ACL sentinel.");
  });

  async function shutdown(signal) {
    console.log(`\n${signal} received, shutting down dashboard...`);
    server.close();
    for (const client of clients) client.end();
    if (subscriber) await subscriber.quit();
    if (redis) await redis.quit();
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (require.main === module) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  start,
  buildHeartbeat,
  statusPayload
};
