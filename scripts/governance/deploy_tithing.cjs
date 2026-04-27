require('dotenv').config();
const { ethers } = require('hardhat');

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('Deployer:', deployer.address);
  console.log('Balance:', ethers.formatEther(await ethers.provider.getBalance(deployer.address)), 'ETH\n');

  // 1. Deploy ConsentManager
  const ConsentManager = await ethers.getContractFactory('ConsentManager');
  const consentManager = await ConsentManager.deploy();
  await consentManager.waitForDeployment();
  console.log('ConsentManager:', consentManager.target);

  // 2. Deploy TitheManager
  const TitheManager = await ethers.getContractFactory('TitheManager');
  const titheManager = await TitheManager.deploy();
  await titheManager.waitForDeployment();
  console.log('TitheManager:', titheManager.target);

  // 3. Print summary
  console.log('\n--- Deployment Summary ---');
  console.log('ConsentManager:', consentManager.target);
  console.log('TitheManager: ', titheManager.target);
  console.log('\nUpdate your .env or notes with these addresses.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});