import { ethers } from "ethers";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootEnv = readFileSync(resolve(__dirname, "..", ".env"), "utf-8");

function env(key) {
  const m = rootEnv.match(new RegExp(`^${key}=(.+)`, "m"));
  if (!m) throw new Error(`Missing ${key} in .env`);
  return m[1].trim();
}

const RPC_URL = (env("RPC_URLS") || env("RPC_URL")).split(",")[0].trim();
const PRIVATE_KEY = env("FUNDER_PRIVATE_KEY");
const ESCROW = env("PILOT_ESCROW_ADDRESS");
const CID = env("CAMPAIGN_CID");
const CONTENT_HASH = env("CAMPAIGN_CONTENT_HASH");
const BOUNTY = ethers.parseEther(env("CAMPAIGN_BOUNTY_ETH"));

const funder = new ethers.Wallet(PRIVATE_KEY, new ethers.JsonRpcProvider(RPC_URL));
const balance = await funder.provider.getBalance(funder.address);
console.log(`Funder: ${funder.address}`);
console.log(`Balance: ${ethers.formatEther(balance)} ETH`);
console.log(`Escrow: ${ESCROW}`);
console.log(`CID: ${CID}`);
console.log(`ContentHash: ${CONTENT_HASH}`);
console.log(`Bounty: ${ethers.formatEther(BOUNTY)} ETH\n`);

if (balance < BOUNTY + ethers.parseEther("0.001")) {
  console.log("Insufficient balance. Please top up the funder wallet first.");
  process.exit(1);
}

const abi = ["function fundCampaign(bytes32 campaignUid, string calldata _contentUri, bytes32 _contentHash) external payable"];
const escrow = new ethers.Contract(ESCROW, abi, funder);

const campaignUid = ethers.hexlify(ethers.randomBytes(32));
const contentUri = `ipfs://${CID}`;

console.log(`campaignUid: ${campaignUid}`);
console.log(`contentUri: ${contentUri}\n`);

const tx = await escrow.fundCampaign(campaignUid, contentUri, CONTENT_HASH, { value: BOUNTY });
console.log(`Tx sent: ${tx.hash}`);
const receipt = await tx.wait();
console.log(`Confirmed in block ${receipt.blockNumber}`);
console.log(`Campaign funded successfully!`);
