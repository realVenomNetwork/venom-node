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

const RPC_URL = env("RPC_URLS").split(",")[0].trim();
const PRIVATE_KEY = env("FUNDER_PRIVATE_KEY");
const ESCROW = env("PILOT_ESCROW_ADDRESS");
const UID = env("CAMPAIGN_13_UID");
const DEADLINE = Number(env("CAMPAIGN_13_DEADLINE_BLOCK"));

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const currentBlock = await provider.getBlockNumber();

console.log(`Current block: ${currentBlock}`);
console.log(`Deadline block: ${DEADLINE}`);
console.log(`Blocks remaining: ${Math.max(0, DEADLINE - currentBlock)}`);
console.log(`Funder: ${wallet.address}`);
console.log(`Balance: ${ethers.formatEther(await provider.getBalance(wallet.address))} ETH`);
console.log(`Campaign UID: ${UID}`);

if (currentBlock < DEADLINE) {
  console.log("\nDeadline not yet reached. Cannot cancel.");
  console.log(`Wait until block ${DEADLINE} (est. ${((DEADLINE - currentBlock) * 2 / 60).toFixed(0)} min at 2s/block)`);
  process.exit(0);
}

const abi = ["function cancelCampaign(bytes32 campaignUid) external"];
const escrow = new ethers.Contract(ESCROW, abi, wallet);

console.log("\nCalling cancelCampaign...");
const tx = await escrow.cancelCampaign(UID, { gasLimit: 200000 });
console.log(`Tx sent: ${tx.hash}`);
const receipt = await tx.wait();
console.log(`Confirmed in block ${receipt.blockNumber}`);

const newBalance = await provider.getBalance(wallet.address);
console.log(`New balance: ${ethers.formatEther(newBalance)} ETH`);
console.log("Campaign cancelled successfully.");
