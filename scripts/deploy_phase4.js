// scripts/deploy_phase4.js
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying Phase 4 contracts with account:", deployer.address);

  // 1. Deploy VenomRegistry
  const VenomRegistry = await hre.ethers.getContractFactory("VenomRegistry");
  const venomRegistry = await VenomRegistry.deploy();
  await venomRegistry.waitForDeployment();
  console.log("VenomRegistry deployed to:", await venomRegistry.getAddress());

  // 2. Deploy PilotEscrow (passing registry address)
  const PilotEscrow = await hre.ethers.getContractFactory("PilotEscrow");
  const pilotEscrow = await PilotEscrow.deploy(await venomRegistry.getAddress());
  await pilotEscrow.waitForDeployment();
  console.log("PilotEscrow deployed to:", await pilotEscrow.getAddress());

  // 3. Set PilotEscrow in Registry
  await venomRegistry.setPilotEscrow(await pilotEscrow.getAddress());
  console.log("PilotEscrow address set in VenomRegistry");

  console.log("\n=== Phase 4 Deployment Complete ===");
  console.log("VENOM_REGISTRY_ADDRESS=", await venomRegistry.getAddress());
  console.log("PILOT_ESCROW_ADDRESS=", await pilotEscrow.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
