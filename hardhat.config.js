require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config({ quiet: true });

const deployerPrivateKey = process.env.DEPLOYER_PRIVATE_KEY;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      chainId: 31337
    },
    "base-sepolia": {
      url: process.env.RPC_URL || "https://base-sepolia-rpc.publicnode.com",
      accounts: deployerPrivateKey ? [deployerPrivateKey] : []
    }
  },
  etherscan: {
    apiKey: {
      baseSepolia: process.env.BASESCAN_API_KEY || ""
    }
  },
  sourcify: {
    enabled: true
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD"
  }
};
