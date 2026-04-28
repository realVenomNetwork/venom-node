#!/usr/bin/env node
"use strict";

try {
  require("dotenv").config({ quiet: true });
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
}

const commands = {
  card: require("./commands/card"),
  doctor: require("./commands/doctor"),
  init: require("./commands/init"),
  postcard: require("./commands/postcard"),
  status: require("./commands/status")
};

const EXPLANATIONS = Object.freeze({
  card: "Writes the local Operator Card at ~/.venom/operator-card.md. It records configuration only, not reputation.",
  doctor: "Checks local prerequisites, required environment shape, and runtime-mode guardrails without starting the node.",
  init: "Creates a local .env from .env.example if one does not already exist.",
  postcard: "Writes immutable Campaign Postcard v1 local field notes after observed on-chain close evidence.",
  status: "Prints node configuration state that can be inspected safely without network writes."
});

function printHelp() {
  console.log(`VENOM CLI

Usage:
  venom <command> [--explain]

Commands:
  card     Write the local Operator Card
  doctor   Check local setup and guardrails
  init     Create a starter .env without overwriting existing files
  postcard Write a Campaign Postcard v1 after observed close evidence
  status   Show local runtime configuration

Examples:
  npm run venom -- card
  npm run venom -- card --regenerate
  npm run venom -- doctor
  npm run venom -- postcard 0x... --tx 0x...
  npm run venom -- status --explain`);
}

async function main(argv = process.argv.slice(2)) {
  const args = argv.filter((arg) => arg !== "--explain");
  const explain = argv.includes("--explain");
  const commandName = args[0] || "help";

  if (commandName === "help" || commandName === "--help" || commandName === "-h") {
    printHelp();
    return 0;
  }

  const command = commands[commandName];
  if (!command) {
    console.error(`Unknown VENOM command: ${commandName}`);
    printHelp();
    return 1;
  }

  if (explain && EXPLANATIONS[commandName]) {
    console.log(`Explain: ${EXPLANATIONS[commandName]}\n`);
  }

  return command.run({ args: args.slice(1), explain });
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  EXPLANATIONS
};
