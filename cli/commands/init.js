"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  generateOperatorCard,
  parseEnvFile
} = require("../../src/operator/card");

function parseArgs(args) {
  return {
    noCard: args.includes("--no-card"),
    regenerateCard: args.includes("--regenerate-card")
  };
}

async function maybeGenerateOperatorCard(envPath, options) {
  if (options.noCard) return;

  try {
    const env = { ...process.env, ...parseEnvFile(envPath) };
    const result = await generateOperatorCard({
      env,
      regenerate: options.regenerateCard
    });
    console.log(`Created local operator card: ${result.path}`);
  } catch (error) {
    console.warn(`Operator card not created: ${error.message}`);
    console.warn("Next command: npm run venom -- card --regenerate");
  }
}

async function run({ args = [] } = {}) {
  const options = parseArgs(args);
  const root = path.resolve(__dirname, "../..");
  const envPath = path.join(root, ".env");
  const examplePath = path.join(root, ".env.example");

  if (fs.existsSync(envPath)) {
    console.log(".env already exists; leaving it unchanged.");
    if (!options.noCard) {
      await maybeGenerateOperatorCard(envPath, options);
    }
    console.log("Next command: npm run doctor");
    return 0;
  }

  if (!fs.existsSync(examplePath)) {
    console.error(".env.example is missing; cannot initialize .env.");
    return 1;
  }

  fs.copyFileSync(examplePath, envPath, fs.constants.COPYFILE_EXCL);
  console.log("Created .env from .env.example.");
  await maybeGenerateOperatorCard(envPath, options);
  console.log("Next command: edit .env, then run npm run doctor");
  return 0;
}

module.exports = { run };
