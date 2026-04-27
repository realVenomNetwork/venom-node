// scripts/governance/demo-full-flow.js
// Full end-to-end demo of the consolidated governance architecture.
// Demo-only script for local Hardhat runs; do not use it as a production deployment script.
// Run with: npm run demo:governance

const { ethers } = require("hardhat");

async function main() {
  console.log("Starting VENOM governance v0.3 full-flow demo\n");

  const [deployer, user1, validatorA, validatorB, validatorC, validatorD] =
    await ethers.getSigners();

  // ============================================
  // 1. DEPLOY ALL CONTRACTS
  // ============================================
  console.log("📦 Deploying contracts...");

  const TitheManager = await ethers.getContractFactory("TitheManager");
  const titheManager = await TitheManager.deploy();
  await titheManager.waitForDeployment();
  console.log(`   TitheManager: ${titheManager.target}`);

  const CouncilRegistry = await ethers.getContractFactory("CouncilRegistry");
  const councilRegistry = await CouncilRegistry.deploy();
  await councilRegistry.waitForDeployment();
  console.log(`   CouncilRegistry: ${councilRegistry.target}`);

  const MinimalMultiSig = await ethers.getContractFactory("MinimalMultiSig");
  const multisigTemplate = await MinimalMultiSig.deploy([deployer.address], 1);
  await multisigTemplate.waitForDeployment();
  console.log(`   MinimalMultiSig (template): ${multisigTemplate.target}`);

  const AgreementFactory = await ethers.getContractFactory("AgreementFactory");
  const agreementFactory = await AgreementFactory.deploy(
    councilRegistry.target,
    multisigTemplate.target
  );
  await agreementFactory.waitForDeployment();
  console.log(`   AgreementFactory: ${agreementFactory.target}`);

  await agreementFactory.setOverlapThreshold(5000);
  console.log("   ✓ Overlap threshold set to 50%\n");

  const ConsentManager = await ethers.getContractFactory("ConsentManager");
  const consentManager = await ConsentManager.deploy();
  await consentManager.waitForDeployment();
  console.log(`   ConsentManager: ${consentManager.target}\n`);

  // ============================================
  // 2. REGISTER BRANCHES
  // ============================================
  console.log("🌍 Registering worldview branches...");

  const christianBranch = ethers.keccak256(ethers.toUtf8Bytes("christian"));
  const secularBranch = ethers.keccak256(ethers.toUtf8Bytes("secular"));

  await councilRegistry.registerBranch("christian");
  await councilRegistry.registerBranch("secular");
  console.log("   ✓ Branches registered: christian, secular\n");

  // ============================================
  // 3. ADD VALIDATORS
  // ============================================
  console.log("👥 Adding validators...");

  await councilRegistry.addValidatorToBranch(christianBranch, validatorA.address);
  await councilRegistry.addValidatorToBranch(christianBranch, validatorB.address);
  await councilRegistry.addValidatorToBranch(secularBranch, validatorC.address);
  await councilRegistry.addValidatorToBranch(secularBranch, validatorD.address);
  console.log("   ✓ 4 validators added\n");

  // ============================================
  // 4. SET TOP VALIDATORS
  // ============================================
  console.log("🏆 Setting top validators...");

  await councilRegistry.setBranchTopValidators(christianBranch, [validatorA.address, validatorB.address]);
  await councilRegistry.setBranchTopValidators(secularBranch, [validatorC.address, validatorD.address]);
  console.log("   ✓ Top validators set\n");

  // ============================================
  // 5. CROSS-BRANCH ATTESTATIONS
  // ============================================
  console.log("🤝 Cross-branch attestations...");

  await councilRegistry.connect(validatorA).attestTrust(validatorC.address);
  await councilRegistry.connect(validatorC).attestTrust(validatorA.address);
  await councilRegistry.connect(validatorB).attestTrust(validatorD.address);
  await councilRegistry.connect(validatorD).attestTrust(validatorB.address);
  console.log("   ✓ Cross-attestations complete\n");

  // ============================================
  // 6. CREATE AGREEMENT
  // ============================================
  console.log("🤝 Creating agreement...");

  const agreementTx = await agreementFactory.createAgreement(christianBranch, secularBranch);
  const receipt = await agreementTx.wait();

  let agreementAddress = null;
  for (const log of receipt.logs) {
    try {
      const parsed = agreementFactory.interface.parseLog(log);
      if (parsed?.name === "AgreementCreated") {
        agreementAddress = parsed.args.agreementContract;
        break;
      }
    } catch (e) {}
  }

  if (!agreementAddress) throw new Error("AgreementCreated event not found");
  console.log(`   ✓ Agreement created at: ${agreementAddress}\n`);

  // ============================================
  // 7. SET TITHING CONSENT
  // ============================================
  console.log("💰 Setting tithing consent...");

  const CHRISTIAN_TITHE = await consentManager.CHRISTIAN_TITHE();
  await consentManager.connect(user1).setPreset(CHRISTIAN_TITHE);
  const [bps, label] = await consentManager.getEffectiveRate(user1.address);
  console.log(`   ✓ User1 preset: ${label} (${Number(bps) / 100}%)\n`);

  // ============================================
  // 8. SIMULATE CAMPAIGN CLOSE WITH TITHING
  // ============================================
  console.log("📤 Campaign close simulation...");

  const campaignBounty = ethers.parseEther("1.0");
  const [titheBps] = await consentManager.getEffectiveRate(user1.address);

  if (titheBps > 0n) {
    await titheManager.connect(deployer).distribute(campaignBounty, user1.address, { value: campaignBounty });
    await titheManager.claimFor(user1.address);
    await titheManager.claimFor(deployer.address);
    console.log("   ✓ Tithing queued and claimed\n");
  }

  // ============================================
  // FINAL VERIFICATION
  // ============================================
  const agreementCount = await agreementFactory.agreementCount();

  console.log("✅ Demo completed successfully!");
  console.log(`   Total agreements created: ${agreementCount}\n`);
}

main().catch((error) => {
  console.error("Demo failed:", error);
  process.exitCode = 1;
});
