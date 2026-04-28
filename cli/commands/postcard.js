"use strict";

const {
  generatePostcard
} = require("../../src/postcard");

const PILOT_ESCROW_ABI = Object.freeze([
  "event CampaignClosed(bytes32 indexed campaignUid, address indexed recipient, uint256 bounty, uint256 medianScore)",
  "function campaigns(bytes32) view returns (address recipient, uint256 bounty, bool closed, uint256 fundedBlock)"
]);

function parseArgs(args) {
  const options = {
    campaignUid: null,
    txHash: null,
    submitter: null,
    fromBlock: null,
    toBlock: null,
    outputDirectory: null,
    routeTestPayloadToDemo: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!options.campaignUid && !arg.startsWith("--")) {
      options.campaignUid = arg;
      continue;
    }

    if (arg === "--tx" || arg === "--tx-hash") {
      options.txHash = args[++index];
    } else if (arg === "--submitter") {
      options.submitter = args[++index];
    } else if (arg === "--from-block") {
      options.fromBlock = Number(args[++index]);
    } else if (arg === "--to-block") {
      options.toBlock = Number(args[++index]);
    } else if (arg === "--out-dir") {
      options.outputDirectory = args[++index];
    } else if (arg === "--route-test-payload-to-demo") {
      options.routeTestPayloadToDemo = true;
    } else {
      throw new Error(`Unknown postcard option: ${arg}`);
    }
  }

  return options;
}

function printUsage() {
  console.log(`Usage:
  venom postcard <campaignUid> [--tx <hash>] [--from-block <n>] [--to-block <n>]

Examples:
  npm run venom -- postcard 0x... --tx 0x...
  npm run venom -- postcard 0x... --from-block 123456

Notes:
  The command writes both .json and .md files.
  Existing postcard files are never overwritten.
  If USE_TEST_PAYLOAD=true outside demo mode, generation refuses unless --route-test-payload-to-demo is passed.`);
}

function requireEnv(name) {
  if (!process.env[name]) throw new Error(`${name} is required for postcard generation.`);
  return process.env[name];
}

function requireEthers() {
  try {
    return require("ethers");
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND") {
      throw new Error("The postcard command requires installed npm dependencies. Run npm install first.");
    }
    throw error;
  }
}

function numberFromBigIntish(value) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

async function getReceiptSubmitter(provider, receipt, override) {
  if (override) return override;
  if (receipt.from) return receipt.from;

  const txHash = receipt.hash || receipt.transactionHash;
  const tx = await provider.getTransaction(txHash);
  if (!tx || !tx.from) {
    throw new Error(`Unable to determine submitter for close transaction ${txHash}.`);
  }
  return tx.from;
}

function parseCampaignClosedFromReceipt(ethers, receipt, campaignUid, escrowAddress) {
  const iface = new ethers.Interface(PILOT_ESCROW_ABI);
  const normalizedCampaign = campaignUid.toLowerCase();
  const normalizedEscrow = escrowAddress.toLowerCase();

  for (const log of receipt.logs || []) {
    if (log.address && log.address.toLowerCase() !== normalizedEscrow) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === "CampaignClosed" && String(parsed.args.campaignUid).toLowerCase() === normalizedCampaign) {
        return {
          median_score: numberFromBigIntish(parsed.args.medianScore),
          log_index: Number(log.index ?? log.logIndex ?? 0)
        };
      }
    } catch {
      // Ignore logs from other contracts or events.
    }
  }

  throw new Error(`Transaction receipt does not contain CampaignClosed for ${campaignUid}.`);
}

async function findCloseReceipt(ethers, provider, escrowAddress, campaignUid, options) {
  const contract = new ethers.Contract(escrowAddress, PILOT_ESCROW_ABI, provider);

  if (options.txHash) {
    const receipt = await provider.getTransactionReceipt(options.txHash);
    if (!receipt || receipt.status !== 1) {
      throw new Error(`No successful transaction receipt found for ${options.txHash}.`);
    }
    const event = parseCampaignClosedFromReceipt(ethers, receipt, campaignUid, escrowAddress);
    return { receipt, event, source: "transaction_receipt" };
  }

  const latest = options.toBlock ?? await provider.getBlockNumber();
  const lookback = Number(process.env.POSTCARD_LOOKBACK_BLOCKS || 20000);
  const fromBlock = options.fromBlock ?? Math.max(0, latest - lookback);
  const logs = await contract.queryFilter(contract.filters.CampaignClosed(campaignUid), fromBlock, latest);

  if (!logs.length) {
    const campaign = await contract.campaigns(campaignUid);
    if (campaign.closed) {
      throw new Error(
        `Campaign is closed, but no CampaignClosed event was found from block ${fromBlock} to ${latest}. Re-run with --tx <closeTransactionHash> or a wider --from-block.`
      );
    }
    throw new Error(`No observed CampaignClosed event found for ${campaignUid} from block ${fromBlock} to ${latest}.`);
  }

  const eventLog = logs[logs.length - 1];
  const receipt = await provider.getTransactionReceipt(eventLog.transactionHash);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`CampaignClosed event transaction did not resolve to a successful receipt: ${eventLog.transactionHash}`);
  }

  const event = {
    median_score: numberFromBigIntish(eventLog.args.medianScore),
    log_index: Number(eventLog.index ?? eventLog.logIndex ?? 0)
  };
  return { receipt, event, source: "event_log" };
}

async function run({ args }) {
  const options = parseArgs(args);
  if (!options.campaignUid) {
    printUsage();
    return 1;
  }

  const { ethers } = requireEthers();
  const rpcUrl = requireEnv("RPC_URL");
  const escrowAddress = requireEnv("PILOT_ESCROW_ADDRESS");
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const { receipt, event, source } = await findCloseReceipt(ethers, provider, escrowAddress, options.campaignUid, options);
  const submitter = await getReceiptSubmitter(provider, receipt, options.submitter);

  const result = await generatePostcard({
    campaignUid: options.campaignUid,
    submitter,
    closeObservation: {
      observed: true,
      source,
      event_name: "CampaignClosed",
      transaction_hash: receipt.hash || receipt.transactionHash,
      block_number: Number(receipt.blockNumber),
      transaction_index: Number(receipt.index ?? receipt.transactionIndex ?? 0),
      log_index: event.log_index,
      contract_address: escrowAddress
    },
    judgmentCapsule: {
      summary: "CampaignClosed was observed on-chain for this campaign.",
      median_score: event.median_score,
      score_count: 0,
      abstain_count: 0
    }
  }, {
    outputDirectory: options.outputDirectory,
    routeTestPayloadToDemo: options.routeTestPayloadToDemo
  });

  console.log("Campaign postcard written:");
  console.log(`JSON: ${result.paths.json}`);
  console.log(`Markdown: ${result.paths.markdown}`);
  console.log("Next command: npm run status");
  return 0;
}

module.exports = { run };
