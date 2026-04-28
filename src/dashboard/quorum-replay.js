"use strict";

const crypto = require("node:crypto");
const { summarizeLantern } = require("./lanterns");

const DASHBOARD_EVENT_CHANNEL = "venom:dashboard:events";
const SNAPSHOT_KEY_PREFIX = "venom:dashboard:snapshot:";
const SNAPSHOT_TTL_SECONDS = 48 * 60 * 60;
const MAX_EVENTS_PER_CAMPAIGN = 250;

function getWritableRedisConnection() {
  const { getConnection } = require("../../aggregator/queue");
  return getConnection();
}

function normalizeCampaignUid(campaignUid) {
  const value = String(campaignUid || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(value)) {
    throw new Error("campaignUid must be a bytes32 hex string.");
  }
  return value;
}

function snapshotKey(campaignUid) {
  return `${SNAPSHOT_KEY_PREFIX}${normalizeCampaignUid(campaignUid)}`;
}

function makeEventId(event) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([
      event.campaign_uid,
      event.type,
      event.observed_at,
      event.signer,
      event.transaction_hash,
      event.score,
      event.reason_code
    ]))
    .digest("hex")
    .slice(0, 24);
}

function normalizeEvent(input) {
  const event = {
    id: input.id,
    type: String(input.type || ""),
    campaign_uid: normalizeCampaignUid(input.campaignUid || input.campaign_uid),
    observed_at: input.observed_at || new Date(input.timestamp || Date.now()).toISOString(),
    scope: "local_observation",
    node_local: true,
    source: input.source || "node_runtime",
    message: input.message || "",
    signer: input.signer ? String(input.signer).toLowerCase() : undefined,
    score: Number.isInteger(input.score) ? input.score : undefined,
    reason_code: Number.isInteger(input.reasonCode ?? input.reason_code) ? Number(input.reasonCode ?? input.reason_code) : undefined,
    submitter: input.submitter ? String(input.submitter).toLowerCase() : undefined,
    transaction_hash: input.transactionHash || input.transaction_hash,
    block_number: Number.isInteger(input.blockNumber ?? input.block_number) ? Number(input.blockNumber ?? input.block_number) : undefined,
    postcard_paths: input.postcardPaths || input.postcard_paths
  };

  if (!event.type) throw new Error("dashboard event type is required.");
  if (!event.id) event.id = makeEventId(event);
  return event;
}

function emptySnapshot(campaignUid) {
  return {
    campaign_uid: normalizeCampaignUid(campaignUid),
    scope: "local_observation",
    node_local: true,
    updated_at: null,
    events: [],
    lantern: null
  };
}

function applyEventToSnapshot(snapshot, event) {
  const next = snapshot || emptySnapshot(event.campaign_uid);
  const seen = new Set(next.events.map((item) => item.id));

  if (!seen.has(event.id)) {
    next.events.push(event);
  }

  next.events.sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
  if (next.events.length > MAX_EVENTS_PER_CAMPAIGN) {
    next.events = next.events.slice(next.events.length - MAX_EVENTS_PER_CAMPAIGN);
  }

  next.updated_at = event.observed_at;
  next.lantern = summarizeLantern(next);
  return next;
}

async function readSnapshot(redis, campaignUid) {
  const raw = await redis.get(snapshotKey(campaignUid));
  if (!raw) return emptySnapshot(campaignUid);
  return JSON.parse(raw);
}

async function writeSnapshot(redis, snapshot) {
  await redis.set(
    snapshotKey(snapshot.campaign_uid),
    JSON.stringify(snapshot),
    "EX",
    SNAPSHOT_TTL_SECONDS
  );
}

async function recordDashboardEvent(input, options = {}) {
  const redis = options.redis || getWritableRedisConnection();
  const event = normalizeEvent(input);
  const current = await readSnapshot(redis, event.campaign_uid);
  const snapshot = applyEventToSnapshot(current, event);

  await writeSnapshot(redis, snapshot);
  await redis.publish(DASHBOARD_EVENT_CHANNEL, JSON.stringify({ event, snapshot }));
  return { event, snapshot };
}

async function listSnapshots(redis) {
  const keys = [];
  let cursor = "0";
  do {
    const result = await redis.scan(cursor, "MATCH", `${SNAPSHOT_KEY_PREFIX}*`, "COUNT", 100);
    cursor = result[0];
    keys.push(...result[1]);
  } while (cursor !== "0");

  if (!keys.length) return [];
  const values = await redis.mget(keys);
  return values
    .filter(Boolean)
    .map((value) => JSON.parse(value))
    .sort((a, b) => Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0));
}

function buildReplayTimeline(snapshot, options = {}) {
  const durationMs = Math.min(
    Math.max(Number(options.durationMs || 45000), 30000),
    60000
  );
  const events = Array.isArray(snapshot.events) ? snapshot.events : [];
  if (!events.length) {
    return {
      campaign_uid: snapshot.campaign_uid,
      duration_ms: durationMs,
      disclaimer: "Reconstructed from this node's local observations only.",
      events: []
    };
  }

  const first = Date.parse(events[0].observed_at);
  const last = Date.parse(events[events.length - 1].observed_at);
  const span = Math.max(last - first, 1);

  return {
    campaign_uid: snapshot.campaign_uid,
    duration_ms: durationMs,
    disclaimer: "Reconstructed from this node's local observations only.",
    events: events.map((event) => ({
      ...event,
      replay_offset_ms: Math.round(((Date.parse(event.observed_at) - first) / span) * durationMs)
    }))
  };
}

module.exports = {
  DASHBOARD_EVENT_CHANNEL,
  SNAPSHOT_KEY_PREFIX,
  SNAPSHOT_TTL_SECONDS,
  normalizeEvent,
  recordDashboardEvent,
  readSnapshot,
  listSnapshots,
  buildReplayTimeline,
  applyEventToSnapshot,
  snapshotKey
};
