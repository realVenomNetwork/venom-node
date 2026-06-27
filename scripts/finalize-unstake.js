const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const rootEnv = fs.readFileSync(path.resolve(__dirname, "..", ".env"), "utf-8");
function env(key) {
  const m = rootEnv.match(new RegExp(`^${key}=(.+)`, "m"));
  return m ? m[1].trim() : null;
}

const RPC = (env("RPC_URLS") || env("RPC_URL") || "https://sepolia.base.org").split(",")[0].trim();
const provider = new ethers.JsonRpcProvider(RPC);
const REGISTRY = env("VENOM_REGISTRY_ADDRESS") || "0xab82be024Bde3f302537C5C6A50C1A86880bFc63";
const base = path.resolve(__dirname, "..", ".venom-canary-06");

const abi = [
  "function oracles(address) view returns (address operator, uint256 stake, uint256 scoreCount, uint256 lastActive, bool active, string multiaddr)",
  "function finalizeUnstake() external",
  "function unstakeRequestedAt(address) view returns (uint256)",
  "event UnstakeFinalized(address indexed operator, uint256 amount)"
];

async function main() {
  const registry = new ethers.Contract(REGISTRY, abi, provider);

  for (let i = 1; i <= 5; i++) {
    const env = fs.readFileSync(`${base}/operator-${i}/.env`, "utf-8");
    const pk = env.match(/PRIVATE_KEY=(0x[a-f0-9]+)/i);
    if (!pk) { console.log(`op${i}: no private key found`); continue; }

    const wallet = new ethers.Wallet(pk[1], provider);
    const info = await registry.oracles(wallet.address);
    const requestedAt = Number(await registry.unstakeRequestedAt(wallet.address));
    const cooldownEnd = requestedAt + 7 * 86400;
    const now = Math.floor(Date.now() / 1000);

    if (!info.active && requestedAt > 0 && now >= cooldownEnd) {
      try {
        const tx = await registry.connect(wallet).finalizeUnstake();
        console.log(`op${i} ${wallet.address}: finalizeUnstake submitted: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`op${i}: Confirmed in block ${receipt.blockNumber}`);
      } catch (e) {
        console.log(`op${i}: Error: ${e.message?.substring(0, 120)}`);
      }
    } else if (now < cooldownEnd) {
      const remaining = Math.ceil((cooldownEnd - now) / 3600);
      console.log(`op${i}: cooldown not yet elapsed (${remaining}h remaining)`);
    } else {
      console.log(`op${i}: nothing to finalize (active=${info.active}, requestedAt=${requestedAt})`);
    }
  }

  // Check final state
  console.log("\n=== Final state ===");
  for (let i = 1; i <= 5; i++) {
    const env = fs.readFileSync(`${base}/operator-${i}/.env`, "utf-8");
    const pk = env.match(/PRIVATE_KEY=(0x[a-f0-9]+)/i);
    if (!pk) continue;
    const wallet = new ethers.Wallet(pk[1], provider);
    const info = await registry.oracles(wallet.address);
    console.log(`op${i}: stake=${ethers.formatEther(info.stake)} ETH, active=${info.active}`);
  }

  // Check for UnstakeFinalized events
  const filter = registry.filters.UnstakeFinalized();
  const events = await registry.queryFilter(filter, "latest");
  if (events.length > 0) {
    console.log(`\n=== UnstakeFinalized events ===`);
    for (const e of events) {
      console.log(`  ${e.args.operator}: ${ethers.formatEther(e.args.amount)} ETH`);
    }
  }
}

main().catch(console.error);
