"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  assertRuntimeModeConfig,
  describeRuntimeMode
} = require("../config/runtime-mode");

const OPERATOR_CARD_DISCLAIMER = "This is a local operator setup card. It records configuration, not reputation.";
const DEFAULT_OPERATOR_CARD_PATH = path.join(os.homedir(), ".venom", "operator-card.md");

class OperatorCardError extends Error {
  constructor(message) {
    super(message);
    this.name = "OperatorCardError";
  }
}

function getOperatorPrivateKey(env = process.env) {
  return env.OPERATOR_PRIVATE_KEY || env.BROADCASTER_PRIVATE_KEY || env.DEPLOYER_PRIVATE_KEY || "";
}

function tryDeriveOperatorAddress(env = process.env) {
  if (env.OPERATOR_ADDRESS) {
    return {
      address: env.OPERATOR_ADDRESS,
      source: "OPERATOR_ADDRESS"
    };
  }

  const privateKey = getOperatorPrivateKey(env);
  if (!privateKey) {
    return {
      address: "not configured",
      source: "no operator key configured"
    };
  }

  try {
    const { ethers } = require("ethers");
    const wallet = new ethers.Wallet(privateKey);
    return {
      address: wallet.address,
      source: "derived locally from configured operator key"
    };
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND") {
      return {
        address: "configured; address unavailable until npm dependencies are installed",
        source: "operator key configured"
      };
    }
    return {
      address: "configured; address could not be derived",
      source: "operator key configured"
    };
  }
}

function parseEnvFile(filePath) {
  const env = {};
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const value = match[2].replace(/^["']|["']$/g, "");
    env[match[1]] = value;
  }
  return env;
}

function buildOperatorCard(input = {}, options = {}) {
  const env = input.env || options.env || process.env;
  const runtimeConfig = input.runtimeConfig || assertRuntimeModeConfig(env);
  const operator = input.operator || tryDeriveOperatorAddress(env);
  const generatedAt = new Date(input.now || Date.now()).toISOString();

  // This card is intentionally local-only. It records configuration and mode
  // context for the operator; it is not a credential, reputation proof, or
  // portable attestation.
  return {
    generatedAt,
    disclaimer: OPERATOR_CARD_DISCLAIMER,
    runtimeMode: runtimeConfig.runtimeMode,
    useTestPayload: runtimeConfig.useTestPayload,
    runtimeSummary: describeRuntimeMode(runtimeConfig),
    artifactDirectory: runtimeConfig.artifactDirectory,
    postcardDirectory: runtimeConfig.postcardDirectory,
    operatorAddress: operator.address,
    operatorAddressSource: operator.source,
    registryAddress: env.VENOM_REGISTRY_ADDRESS || "not configured",
    escrowAddress: env.PILOT_ESCROW_ADDRESS || "not configured",
    redisEndpoint: `${env.REDIS_HOST || "127.0.0.1"}:${env.REDIS_PORT || "6379"}`,
    dashboardEndpoint: `http://${env.DASHBOARD_HOST || "127.0.0.1"}:${env.DASHBOARD_PORT || "8787"}`
  };
}

function renderOperatorCard(card) {
  return `# VENOM Operator Card

${card.disclaimer}

## Runtime

- VENOM_RUNTIME_MODE: ${card.runtimeMode}
- USE_TEST_PAYLOAD: ${card.useTestPayload}
- Runtime summary: ${card.runtimeSummary}
- Artifact directory: ${card.artifactDirectory}
- Postcard directory: ${card.postcardDirectory}

## Local Setup

- Registry: ${card.registryAddress}
- Escrow: ${card.escrowAddress}
- Redis: ${card.redisEndpoint}
- Dashboard: ${card.dashboardEndpoint}

## Operator Address

This address is included only as a setup reference and is not front-and-center because this card is not a credential.

- Address: ${card.operatorAddress}
- Source: ${card.operatorAddressSource}

## Notes

- Local-only: keep this file on the machine that runs the node.
- Regenerable: delete this file or run the CLI with --regenerate to create a fresh copy.
- Not reputation: do not present this card as proof of operator quality, governance approval, ranking, or verified status.

Generated at: ${card.generatedAt}
`;
}

async function removeExistingCard(filePath) {
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function writeOperatorCard(card, options = {}) {
  const filePath = path.resolve(options.outputPath || DEFAULT_OPERATOR_CARD_PATH);
  const regenerate = Boolean(options.regenerate);

  if (regenerate) {
    await removeExistingCard(filePath);
  }

  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

  try {
    // Exclusive create keeps normal writes non-destructive. Regeneration is an
    // explicit delete + fresh exclusive write, so there is no overwrite ceremony.
    await fs.promises.writeFile(filePath, renderOperatorCard(card), { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new OperatorCardError(`Operator card already exists: ${filePath}. Re-run with --regenerate to replace it.`);
    }
    throw error;
  }

  return { card, path: filePath };
}

async function generateOperatorCard(options = {}) {
  const card = buildOperatorCard({ env: options.env, runtimeConfig: options.runtimeConfig, now: options.now });
  return writeOperatorCard(card, {
    outputPath: options.outputPath,
    regenerate: options.regenerate
  });
}

module.exports = {
  DEFAULT_OPERATOR_CARD_PATH,
  OPERATOR_CARD_DISCLAIMER,
  OperatorCardError,
  buildOperatorCard,
  generateOperatorCard,
  parseEnvFile,
  renderOperatorCard,
  tryDeriveOperatorAddress,
  writeOperatorCard
};
