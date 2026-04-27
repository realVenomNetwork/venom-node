const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Governance contracts", function () {
  let owner, signerA, signerB, signerC, recipient, treasury;

  beforeEach(async function () {
    [owner, signerA, signerB, signerC, recipient, treasury] = await ethers.getSigners();
  });

  describe("MinimalMultiSig", function () {
    it("requires distinct signer confirmations before execution", async function () {
      const MultiSig = await ethers.getContractFactory("MinimalMultiSig");
      const multisig = await MultiSig.deploy([signerA.address, signerB.address, signerC.address], 2);

      const target = recipient.address;
      const value = 0n;
      const data = "0x";
      const txHash = await multisig.getTransactionHash(target, value, data, 0);

      await expect(multisig.connect(signerB).confirmTransaction(txHash))
        .to.be.revertedWith("Not submitted");

      await multisig.connect(signerA).submitTransaction(target, value, data);

      await expect(multisig.connect(signerA).confirmTransaction(txHash))
        .to.be.revertedWith("Already confirmed");
      await expect(multisig.connect(signerA).executeTransaction(txHash))
        .to.be.revertedWith("Not enough confirmations");

      await multisig.connect(signerB).confirmTransaction(txHash);
      await expect(multisig.connect(signerB).executeTransaction(txHash))
        .to.emit(multisig, "Execution")
        .withArgs(txHash);

      expect(await multisig.executed(txHash)).to.equal(true);
      expect(await multisig.nonce()).to.equal(1n);
    });

    it("keeps concurrent submissions executable with distinct submission nonces", async function () {
      const MultiSig = await ethers.getContractFactory("MinimalMultiSig");
      const multisig = await MultiSig.deploy([signerA.address, signerB.address, signerC.address], 2);

      const txHashA = await multisig.getTransactionHash(recipient.address, 0, "0x", 0);
      const txHashB = await multisig.getTransactionHash(treasury.address, 0, "0x", 1);

      await multisig.connect(signerA).submitTransaction(recipient.address, 0, "0x");
      await multisig.connect(signerB).submitTransaction(treasury.address, 0, "0x");
      expect(await multisig.nonce()).to.equal(2n);

      await multisig.connect(signerB).confirmTransaction(txHashA);
      await multisig.connect(signerA).confirmTransaction(txHashB);

      await expect(multisig.connect(signerC).executeTransaction(txHashA))
        .to.emit(multisig, "Execution")
        .withArgs(txHashA);
      await expect(multisig.connect(signerC).executeTransaction(txHashB))
        .to.emit(multisig, "Execution")
        .withArgs(txHashB);
    });
  });

  describe("TitheManager", function () {
    it("removes recipients from the active array with swap-and-pop", async function () {
      const TitheManager = await ethers.getContractFactory("TitheManager");
      const titheManager = await TitheManager.deploy();

      await titheManager.addRecipient(signerA.address, 5000);
      await titheManager.addRecipient(signerB.address, 5000);

      expect(await titheManager.recipientCount()).to.equal(2n);

      await titheManager.removeRecipient(signerA.address);

      expect(await titheManager.recipientCount()).to.equal(1n);
      expect(await titheManager.recipients(0)).to.equal(signerB.address);
      expect(await titheManager.sharesBps(signerA.address)).to.equal(0n);

      const total = ethers.parseEther("1");
      const redirected = ethers.parseEther("0.1");
      const net = ethers.parseEther("0.9");

      await expect(titheManager.distribute(total, recipient.address, { value: total }))
        .to.emit(titheManager, "PaymentQueued")
        .withArgs(signerB.address, redirected)
        .and.to.emit(titheManager, "PaymentQueued")
        .withArgs(recipient.address, net);

      expect(await titheManager.pendingBalances(signerB.address)).to.equal(redirected);
      expect(await titheManager.pendingBalances(recipient.address)).to.equal(net);

      await expect(titheManager.claimFor(signerB.address))
        .to.changeEtherBalances([titheManager, signerB], [-redirected, redirected]);
      await expect(titheManager.claimFor(recipient.address))
        .to.changeEtherBalances([titheManager, recipient], [-net, net]);
    });

    it("supports presets and owner fallback when no recipients are configured", async function () {
      const TitheManager = await ethers.getContractFactory("TitheManager");
      const titheManager = await TitheManager.deploy();

      await expect(titheManager.useZakat())
        .to.emit(titheManager, "TitheRateUpdated")
        .withArgs(250, "zakat-2.5pct");

      await titheManager.useSecular(125);
      expect(await titheManager.titheBps()).to.equal(125n);
      expect(await titheManager.currentPresetLabel()).to.equal("secular-custom");

      await titheManager.setCustomRate(0, "none");
      expect(await titheManager.titheBps()).to.equal(0n);

      await titheManager.useTzedakah();
      const total = ethers.parseEther("1");
      const redirected = ethers.parseEther("0.1");
      const net = ethers.parseEther("0.9");
      await titheManager.connect(signerA).distribute(total, recipient.address, { value: total });
      expect(await titheManager.pendingBalances(owner.address)).to.equal(redirected);
      expect(await titheManager.pendingBalances(recipient.address)).to.equal(net);

      await expect(titheManager.claimFor(owner.address))
        .to.changeEtherBalances([titheManager, owner], [-redirected, redirected]);
      await expect(titheManager.claimFor(recipient.address))
        .to.changeEtherBalances([titheManager, recipient], [-net, net]);
    });

    it("does not revert distribution when a queued recipient rejects ETH", async function () {
      const TitheManager = await ethers.getContractFactory("TitheManager");
      const titheManager = await TitheManager.deploy();

      const CouncilRegistry = await ethers.getContractFactory("CouncilRegistry");
      const councilRegistry = await CouncilRegistry.deploy();
      const MultiSig = await ethers.getContractFactory("MinimalMultiSig");
      const template = await MultiSig.deploy([owner.address], 1);
      const AgreementFactory = await ethers.getContractFactory("AgreementFactory");
      const rejectingRecipient = await AgreementFactory.deploy(
        await councilRegistry.getAddress(),
        await template.getAddress()
      );

      const rejectingAddress = await rejectingRecipient.getAddress();
      await titheManager.addRecipient(rejectingAddress, 10000);

      const total = ethers.parseEther("1");
      const redirected = ethers.parseEther("0.1");
      await expect(titheManager.distribute(total, recipient.address, { value: total }))
        .to.emit(titheManager, "PaymentQueued")
        .withArgs(rejectingAddress, redirected);

      expect(await titheManager.pendingBalances(rejectingAddress)).to.equal(redirected);
      await expect(titheManager.claimFor(rejectingAddress))
        .to.be.revertedWith("Claim transfer failed");
    });
  });

  describe("AgreementFactory", function () {
    it("rejects accidental ETH transfers", async function () {
      const CouncilRegistry = await ethers.getContractFactory("CouncilRegistry");
      const councilRegistry = await CouncilRegistry.deploy();
      await councilRegistry.waitForDeployment();

      const MultiSig = await ethers.getContractFactory("MinimalMultiSig");
      const template = await MultiSig.deploy([owner.address], 1);
      await template.waitForDeployment();

      const AgreementFactory = await ethers.getContractFactory("AgreementFactory");
      const agreementFactory = await AgreementFactory.deploy(
        await councilRegistry.getAddress(),
        await template.getAddress()
      );

      await expect(owner.sendTransaction({
        to: await agreementFactory.getAddress(),
        value: 1n
      })).to.be.revertedWith("Not payable");
    });

    it("creates an agreement when branch top validators meet the overlap threshold", async function () {
      const CouncilRegistry = await ethers.getContractFactory("CouncilRegistry");
      const councilRegistry = await CouncilRegistry.deploy();

      const christianBranch = ethers.id("christian");
      const secularBranch = ethers.id("secular");
      await councilRegistry.registerBranch("christian");
      await councilRegistry.registerBranch("secular");

      await councilRegistry.addValidatorToBranch(christianBranch, signerA.address);
      await councilRegistry.addValidatorToBranch(christianBranch, signerB.address);
      await councilRegistry.addValidatorToBranch(secularBranch, signerC.address);
      await councilRegistry.addValidatorToBranch(secularBranch, recipient.address);

      await councilRegistry.setBranchTopValidators(christianBranch, [signerA.address, signerB.address]);
      await councilRegistry.setBranchTopValidators(secularBranch, [signerC.address, recipient.address]);

      await councilRegistry.connect(signerA).attestTrust(signerC.address);
      await councilRegistry.connect(signerB).attestTrust(recipient.address);

      const MultiSig = await ethers.getContractFactory("MinimalMultiSig");
      const template = await MultiSig.deploy([owner.address], 1);

      const AgreementFactory = await ethers.getContractFactory("AgreementFactory");
      const agreementFactory = await AgreementFactory.deploy(
        await councilRegistry.getAddress(),
        await template.getAddress()
      );

      await expect(agreementFactory.createAgreement(christianBranch, secularBranch))
        .to.emit(agreementFactory, "AgreementCreated");

      expect(await agreementFactory.agreementCount()).to.equal(1n);
      expect(await agreementFactory.branchAgreements(christianBranch, secularBranch))
        .to.not.equal(ethers.ZeroAddress);
    });

    it("enforces pause and owner-only manual agreement creation", async function () {
      const CouncilRegistry = await ethers.getContractFactory("CouncilRegistry");
      const councilRegistry = await CouncilRegistry.deploy();
      const MultiSig = await ethers.getContractFactory("MinimalMultiSig");
      const template = await MultiSig.deploy([owner.address], 1);
      const AgreementFactory = await ethers.getContractFactory("AgreementFactory");
      const agreementFactory = await AgreementFactory.deploy(
        await councilRegistry.getAddress(),
        await template.getAddress()
      );

      await agreementFactory.pause();
      await expect(agreementFactory.createAgreementWithParticipants([signerA.address, signerB.address], 2))
        .to.be.revertedWith("Paused");

      await agreementFactory.unpause();
      await expect(agreementFactory.connect(signerA).createAgreementWithParticipants([signerA.address, signerB.address], 2))
        .to.be.revertedWithCustomError(agreementFactory, "OwnableUnauthorizedAccount");

      await expect(agreementFactory.createAgreementWithParticipants([signerA.address, signerA.address], 1))
        .to.be.revertedWith("Duplicate participants");

      await agreementFactory.createAgreementWithParticipants([signerA.address, signerB.address], 2);
      expect(await agreementFactory.agreementCount()).to.equal(1n);
    });
  });

  describe("CouncilRegistry", function () {
    it("tracks branches, validators, trust, and current council", async function () {
      const CouncilRegistry = await ethers.getContractFactory("CouncilRegistry");
      const councilRegistry = await CouncilRegistry.deploy();

      const branchId = ethers.id("agnostic");
      await expect(councilRegistry.registerBranch("agnostic"))
        .to.emit(councilRegistry, "BranchRegistered")
        .withArgs(branchId, "agnostic");

      await councilRegistry.addValidatorToBranch(branchId, signerA.address);
      await councilRegistry.addValidatorToBranch(branchId, signerB.address);
      expect(await councilRegistry.getBranchValidators(branchId))
        .to.deep.equal([signerA.address, signerB.address]);

      await councilRegistry.connect(signerA).attestTrust(signerB.address);
      expect(await councilRegistry.getTrustScore(signerB.address)).to.equal(1n);

      await councilRegistry.setCurrentCouncil([signerA.address, signerB.address]);
      expect(await councilRegistry.getCurrentCouncil())
        .to.deep.equal([signerA.address, signerB.address]);

      await councilRegistry.removeValidatorFromBranch(branchId, signerA.address);
      await expect(councilRegistry.addValidatorToBranch(branchId, signerB.address))
        .to.be.revertedWith("Already in branch");
    });
  });

  describe("ConsentManager", function () {
    it("stores presets, custom rates, opt-outs, and owner clears", async function () {
      const ConsentManager = await ethers.getContractFactory("ConsentManager");
      const consentManager = await ConsentManager.deploy();

      const zakat = await consentManager.ZAKAT();
      await consentManager.connect(signerA).setPreset(zakat);
      expect(await consentManager.getEffectiveRate(signerA.address))
        .to.deep.equal([250n, "zakat-2.5pct"]);

      await consentManager.connect(signerA).setCustomRate(333);
      expect(await consentManager.getEffectiveRate(signerA.address))
        .to.deep.equal([333n, "secular-custom"]);

      await consentManager.connect(signerA).optOut();
      expect(await consentManager.getEffectiveRate(signerA.address))
        .to.deep.equal([0n, "none-0pct"]);

      await consentManager.connect(signerA).setCustomRate(100);
      await consentManager.clearPreset(signerA.address);
      expect(await consentManager.getEffectiveRate(signerA.address))
        .to.deep.equal([0n, ""]);

      await expect(consentManager.connect(signerA).setCustomRate(10001))
        .to.be.revertedWith("Invalid rate");

      await expect(consentManager.connect(signerA).setPreset(ethers.ZeroHash))
        .to.be.revertedWith("Unknown preset");
    });
  });

  describe("CreedValidator", function () {
    it("validates nodes through distinct attestations and supports opt-out", async function () {
      const CreedValidator = await ethers.getContractFactory("CreedValidator");
      const creedValidator = await CreedValidator.deploy();

      await creedValidator.setMinAttestations(2);
      const hashA = ethers.id("testimony-a");
      const hashB = ethers.id("testimony-b");

      await creedValidator.connect(signerA).attestNode(signerC.address, 0, hashA);
      await creedValidator.connect(signerA).attestNode(signerC.address, 1, hashB);
      let status = await creedValidator.getValidationStatus(signerC.address);
      expect(status.attestationCount).to.equal(1n);
      await expect(creedValidator.connect(signerA).attestNode(signerC.address, 1, hashB))
        .to.be.revertedWith("Already attested creed");

      await expect(creedValidator.connect(signerB).attestNode(signerC.address, 1, hashB))
        .to.emit(creedValidator, "NodeFullyValidated")
        .withArgs(signerC.address, 2);

      expect(await creedValidator.isValidated(signerC.address)).to.equal(true);

      await creedValidator.connect(recipient).toggleOptOut(recipient.address);
      expect(await creedValidator.isValidated(recipient.address)).to.equal(true);
      await expect(creedValidator.connect(signerA).attestNode(recipient.address, 0, hashA))
        .to.be.revertedWith("Node has opted out of validation");
    });

    it("batch attests multiple creed hashes as one attestation", async function () {
      const CreedValidator = await ethers.getContractFactory("CreedValidator");
      const creedValidator = await CreedValidator.deploy();
      await creedValidator.setMinAttestations(2);

      const hashes = [ethers.id("son"), ethers.id("lord")];
      await creedValidator.connect(signerA).batchAttestNode(signerC.address, [0, 3], hashes);

      let status = await creedValidator.getValidationStatus(signerC.address);
      expect(status.attestationCount).to.equal(1n);
      expect(status.creedHashes[0]).to.equal(hashes[0]);
      expect(status.creedHashes[3]).to.equal(hashes[1]);

      await creedValidator.connect(signerA).batchAttestNode(signerC.address, [1], [ethers.id("messiah-a")]);
      status = await creedValidator.getValidationStatus(signerC.address);
      expect(status.attestationCount).to.equal(1n);
      await expect(creedValidator.connect(signerA).batchAttestNode(signerC.address, [1], [ethers.id("again")]))
        .to.be.revertedWith("Already attested creed");

      await creedValidator.connect(signerB).attestNode(signerC.address, 1, ethers.id("messiah"));
      expect(await creedValidator.isValidated(signerC.address)).to.equal(true);

      await creedValidator.resetValidation(signerC.address);
      status = await creedValidator.getValidationStatus(signerC.address);
      expect(status.attestationCount).to.equal(0n);

      await creedValidator.connect(signerA).attestNode(signerC.address, 0, ethers.id("after-reset"));
      status = await creedValidator.getValidationStatus(signerC.address);
      expect(status.attestationCount).to.equal(1n);
    });
  });

  describe("VenomRegistry", function () {
    it("tracks slashed stake separately and allows owner treasury withdrawal", async function () {
      const Registry = await ethers.getContractFactory("VenomRegistry");
      const registry = await Registry.deploy();
      await registry.setPilotEscrow(owner.address);

      const stake = ethers.parseEther("1");
      await registry.connect(signerA).registerOracle("/ip4/127.0.0.1/tcp/4101", { value: stake });

      await registry.reportDeviation(signerA.address, 100, 50);

      const slashAmount = (stake * 5n) / 100n;
      expect(await registry.slashedStakeReserve()).to.equal(slashAmount);
      expect((await registry.oracles(signerA.address)).active).to.equal(false);

      await expect(registry.connect(signerA).registerOracle("/ip4/127.0.0.1/tcp/4102", { value: stake }))
        .to.be.revertedWith("Oracle already exists");

      await expect(registry.withdrawSlashedStake(treasury.address, slashAmount))
        .to.changeEtherBalances([registry, treasury], [-slashAmount, slashAmount]);
      expect(await registry.slashedStakeReserve()).to.equal(0n);
    });
  });
});
