"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { validateRuntimeModeConfig } = require("../../src/config/runtime-mode");

const REQUIRED_ENV = Object.freeze([
  "RPC_URL",
  "VENOM_REGISTRY_ADDRESS",
  "PILOT_ESCROW_ADDRESS"
]);

function hasOperatorKey(env) {
  return Boolean(env.OPERATOR_PRIVATE_KEY || env.BROADCASTER_PRIVATE_KEY || env.DEPLOYER_PRIVATE_KEY);
}

function line(status, message) {
  console.log(`${status.padEnd(5)} ${message}`);
}

async function run() {
  let failures = 0;
  const root = path.resolve(__dirname, "../..");
  const pkg = require(path.join(root, "package.json"));

  line("INFO", `VENOM package ${pkg.name}@${pkg.version}`);
  line("INFO", `Node ${process.version}`);

  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) {
    line("PASS", "Node version satisfies >=20.0.0");
  } else {
    failures += 1;
    line("FAIL", "Node version must be >=20.0.0");
  }

  const runtime = validateRuntimeModeConfig(process.env);
  if (runtime.ok) {
    line("PASS", `Runtime mode: ${runtime.runtimeMode}; USE_TEST_PAYLOAD=${runtime.useTestPayload}`);
  } else {
    failures += 1;
    for (const error of runtime.errors) line("FAIL", error);
  }

  for (const key of REQUIRED_ENV) {
    if (process.env[key]) {
      line("PASS", `${key} is set`);
    } else {
      line("WARN", `${key} is not set`);
    }
  }

  if (hasOperatorKey(process.env)) {
    line("PASS", "Operator private key is configured");
  } else {
    line("WARN", "No OPERATOR_PRIVATE_KEY, BROADCASTER_PRIVATE_KEY, or DEPLOYER_PRIVATE_KEY is set");
  }

  const vocabularyPath = path.join(root, "vocabulary", "vocabulary.json");
  if (fs.existsSync(vocabularyPath)) {
    line("PASS", "vocabulary/vocabulary.json exists");
  } else {
    failures += 1;
    line("FAIL", "vocabulary/vocabulary.json is missing");
  }

  console.log(failures ? "\nNext command: fix the FAIL rows, then run npm run doctor" : "\nNext command: npm run status");
  return failures ? 1 : 0;
}

module.exports = { run };
