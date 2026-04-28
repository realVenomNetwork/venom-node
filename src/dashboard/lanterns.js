"use strict";

const LANTERN_STATES = Object.freeze({
  OBSERVED: "Observed",
  DECIDED: "Decided",
  POSTCARD_READY: "Postcard ready",
  LOGGED: "Logged",
  STALE: "Stale"
});

const STALE_AFTER_MS = 30 * 60 * 1000;

// Lanterns are intentionally node-local. They describe what this node observed
// or reconstructed from its own Redis snapshots; they never claim global finality.
const EVENT_STATE_ORDER = Object.freeze({
  campaign_observed: 1,
  score_observed: 1,
  abstain_observed: 1,
  local_score: 2,
  local_abstain: 2,
  quorum_reached: 2,
  close_submitted: 2,
  close_observed: 2,
  postcard_ready: 3,
  postcard_logged: 4
});

const STATE_BY_ORDER = Object.freeze({
  1: LANTERN_STATES.OBSERVED,
  2: LANTERN_STATES.DECIDED,
  3: LANTERN_STATES.POSTCARD_READY,
  4: LANTERN_STATES.LOGGED
});

function eventTimeMs(event) {
  const parsed = Date.parse(event.observed_at || event.timestamp || "");
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function computeLanternState(events = [], options = {}) {
  const now = options.now || Date.now();
  const staleAfterMs = options.staleAfterMs || STALE_AFTER_MS;
  let highestOrder = 0;
  let lastObservedAt = 0;

  for (const event of events) {
    const order = EVENT_STATE_ORDER[event.type] || 0;
    if (order > highestOrder) highestOrder = order;
    const timestamp = eventTimeMs(event);
    if (timestamp > lastObservedAt) lastObservedAt = timestamp;
  }

  if (!highestOrder) {
    return {
      state: LANTERN_STATES.STALE,
      order: 0,
      node_local: true,
      last_observed_at: null,
      stale: true
    };
  }

  const stale = now - lastObservedAt > staleAfterMs;
  return {
    state: stale ? LANTERN_STATES.STALE : STATE_BY_ORDER[highestOrder],
    order: highestOrder,
    node_local: true,
    last_observed_at: new Date(lastObservedAt).toISOString(),
    stale
  };
}

function summarizeLantern(snapshot, options = {}) {
  const events = Array.isArray(snapshot.events) ? snapshot.events : [];
  const scores = events.filter((event) => event.type === "score_observed").length;
  const abstains = events.filter((event) => event.type === "abstain_observed").length;
  const latestEvent = events[events.length - 1] || null;

  return {
    campaign_uid: snapshot.campaign_uid,
    ...computeLanternState(events, options),
    score_observations: scores,
    abstain_observations: abstains,
    latest_event_type: latestEvent ? latestEvent.type : null,
    replay_available: events.length > 0
  };
}

module.exports = {
  LANTERN_STATES,
  STALE_AFTER_MS,
  computeLanternState,
  summarizeLantern
};
