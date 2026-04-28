"use strict";

const SENTINEL_KEY = "venom:dashboard:acl-sentinel";

function isReadOnlyRedisError(error) {
  const message = String(error && error.message ? error.message : error).toLowerCase();
  return message.includes("noperm") ||
    message.includes("read only") ||
    message.includes("readonly") ||
    message.includes("permission");
}

async function assertRedisReadOnlyConnection(redisClient, options = {}) {
  if (!redisClient || typeof redisClient.set !== "function") {
    throw new Error("Dashboard Redis ACL sentinel requires a Redis client with a SET method.");
  }

  const key = options.key || `${SENTINEL_KEY}:${process.pid}`;

  try {
    await redisClient.set(key, "dashboard-write-check", "EX", 5);
  } catch (error) {
    if (isReadOnlyRedisError(error)) {
      return { ok: true, key, readOnly: true };
    }
    throw error;
  }

  throw new Error(
    "Dashboard Redis connection is writable. Refusing to start; use the Redis ACL read-only role venom_dash."
  );
}

module.exports = {
  SENTINEL_KEY,
  assertRedisReadOnlyConnection,
  isReadOnlyRedisError
};
