"use strict";

const {
  DEFAULT_OPERATOR_CARD_PATH,
  generateOperatorCard
} = require("../../src/operator/card");

function parseArgs(args) {
  const options = {
    regenerate: false,
    outputPath: null
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--regenerate") {
      options.regenerate = true;
    } else if (arg === "--out") {
      options.outputPath = args[++index];
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown card option: ${arg}`);
    }
  }

  return options;
}

function printUsage() {
  console.log(`Usage:
  venom card [--regenerate]

Options:
  --regenerate   Delete the existing local card and create a fresh one.
  --out <path>   Write to a custom path instead of ${DEFAULT_OPERATOR_CARD_PATH}.

The Operator Card is local-only, regenerable, and not a credential.`);
}

async function run({ args }) {
  const options = parseArgs(args);
  if (options.help) {
    printUsage();
    return 0;
  }

  const result = await generateOperatorCard({
    regenerate: options.regenerate,
    outputPath: options.outputPath
  });

  console.log(`Operator card written: ${result.path}`);
  console.log("This is a local operator setup card. It records configuration, not reputation.");
  console.log("Next command: npm run status");
  return 0;
}

module.exports = { run };
