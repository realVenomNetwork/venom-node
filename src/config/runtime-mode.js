"use strict";

const path = require("node:path");

const ALLOWED_RUNTIME_MODES = Object.freeze(["mainnet", "testnet", "demo"]);
const RUNTIME_MODE_ENV = "VENOM_RUNTIME_MODE";
const TEST_PAYLOAD_ENV = "USE_TEST_PAYLOAD";
const DEFAULT_ARTIFACT_ROOT = ".venom-artifacts";

function normalizeRuntimeMode(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

function parseExplicitBoolean(name, value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return {
      value: null,
      error: `${name} must be explicitly set to true or false.`
    };
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true") return { value: true, error: null };
  if (normalized === "false") return { value: false, error: null };

  return {
    value: null,
    error: `${name} must be exactly true or false, received "${value}".`
  };
}

function getArtifactDirectory(runtimeMode, artifactRoot = DEFAULT_ARTIFACT_ROOT) {
  return path.join(artifactRoot, runtimeMode);
}

function validateRuntimeModeConfig(env = process.env) {
  const errors = [];
  const runtimeMode = normalizeRuntimeMode(env[RUNTIME_MODE_ENV]);
  const testPayload = parseExplicitBoolean(TEST_PAYLOAD_ENV, env[TEST_PAYLOAD_ENV]);

  if (!runtimeMode) {
    errors.push(`${RUNTIME_MODE_ENV} must be explicitly set to one of: ${ALLOWED_RUNTIME_MODES.join(", ")}.`);
  } else if (!ALLOWED_RUNTIME_MODES.includes(runtimeMode)) {
    errors.push(`${RUNTIME_MODE_ENV} must be one of: ${ALLOWED_RUNTIME_MODES.join(", ")}. Received "${env[RUNTIME_MODE_ENV]}".`);
  }

  if (testPayload.error) {
    errors.push(testPayload.error);
  }

  if (runtimeMode === "mainnet" && testPayload.value === true) {
    errors.push(`${RUNTIME_MODE_ENV}=mainnet cannot run with ${TEST_PAYLOAD_ENV}=true.`);
  }

  const artifactRoot = env.VENOM_ARTIFACT_ROOT || DEFAULT_ARTIFACT_ROOT;

  return {
    ok: errors.length === 0,
    errors,
    runtimeMode,
    useTestPayload: testPayload.value,
    artifactRoot,
    artifactDirectory: runtimeMode ? getArtifactDirectory(runtimeMode, artifactRoot) : null,
    postcardDirectory: runtimeMode ? path.join(getArtifactDirectory(runtimeMode, artifactRoot), "postcards") : null,
    demoPostcardDirectory: path.join(getArtifactDirectory("demo", artifactRoot), "postcards")
  };
}

function assertRuntimeModeConfig(env = process.env) {
  const result = validateRuntimeModeConfig(env);
  if (!result.ok) {
    const details = result.errors.map((error) => `- ${error}`).join("\n");
    throw new Error(`Invalid VENOM runtime configuration:\n${details}`);
  }
  return result;
}

function describeRuntimeMode(config) {
  const fixtureState = config.useTestPayload ? "test payload enabled" : "real payload path required";
  return `${config.runtimeMode} (${fixtureState}; artifacts: ${config.artifactDirectory})`;
}

module.exports = {
  ALLOWED_RUNTIME_MODES,
  RUNTIME_MODE_ENV,
  TEST_PAYLOAD_ENV,
  validateRuntimeModeConfig,
  assertRuntimeModeConfig,
  describeRuntimeMode,
  getArtifactDirectory
};
