"use strict";

const { describeRuntimeMode, validateRuntimeModeConfig } = require("../../src/config/runtime-mode");

async function run() {
  const runtime = validateRuntimeModeConfig(process.env);

  if (!runtime.ok) {
    console.log("Runtime configuration: invalid");
    for (const error of runtime.errors) {
      console.log(`FAIL  ${error}`);
    }
    console.log("\nNext command: npm run doctor");
    return 1;
  }

  console.log("VENOM Status");
  console.log(`Runtime: ${describeRuntimeMode(runtime)}`);
  console.log(`Redis: ${process.env.REDIS_HOST || "127.0.0.1"}:${process.env.REDIS_PORT || "6379"}`);
  console.log(`ML service: ${process.env.ML_SERVICE_URL || "default local/service URL"}`);
  console.log(`Registry: ${process.env.VENOM_REGISTRY_ADDRESS || "not configured"}`);
  console.log(`Escrow: ${process.env.PILOT_ESCROW_ADDRESS || "not configured"}`);
  console.log("\nNext command: npm run start");
  return 0;
}

module.exports = { run };
