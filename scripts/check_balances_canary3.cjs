require('dotenv').config();
const { ethers } = require('ethers');

async function checkBalances() {
    const rpcUrl = process.env.RPC_URL || "https://base-sepolia-rpc.publicnode.com";
    const provider = new ethers.JsonRpcProvider(rpcUrl);

    // Full addresses from latest state
    const accounts = {
        "Third Canary (Deployer)": "0xf1F993218429EB2c4135ecf79be3f1A160c335D4",
        "Second Canary (1.5)": "0x92846032a39602cbAA6b8BB653ba56C0641e2F51",
        
    };

    console.log("=== Canary Wallet Balances ===");
    console.log(`RPC: ${rpcUrl}`);
    console.log("================================\n");

    let totalWei = 0n;

    for (const [name, address] of Object.entries(accounts)) {
        if (!address || address.length < 42) {
            console.log(`${name.padEnd(28)}: [Invalid Address]`);
            continue;
        }

        try {
            const balanceWei = await provider.getBalance(address);
            const balanceEth = ethers.formatEther(balanceWei);
            totalWei += balanceWei;

            let status = "";
            const ethNum = parseFloat(balanceEth);

            if (ethNum < 0.01) {
                status = "  ⚠️  LOW GAS";
            } else if (ethNum < 0.05) {
                status = "  ⚠️  Very Low";
            }

            console.log(`${name.padEnd(28)}: ${balanceEth.padStart(12)} ETH${status}`);
        } catch (error) {
            console.error(`❌ Failed to fetch ${name}: ${error.message}`);
        }
    }

    const totalEth = ethers.formatEther(totalWei);
    console.log("\n========================================");
    console.log(`TOTAL ACROSS ALL WALLETS: ${totalEth} ETH`);
    console.log("========================================\n");

    // Final recommendation
    const canaryDeployerBalance = await provider.getBalance("0xf1F993218429EB2c4135ecf79be3f1A160c335D4");
    const canaryDeployerEth = parseFloat(ethers.formatEther(canaryDeployerBalance));

    if (canaryDeployerEth > 1.30) {
        console.log("✅ Third Canary has enough funds for consolidation + next canary.");
    } else {
        console.log("⚠️ Third Canary balance is low. Consider consolidating first.");
    }
}

checkBalances().catch(console.error);