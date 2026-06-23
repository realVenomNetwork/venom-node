const { expect } = require("chai");
const { ethers } = require("hardhat");

const PRODUCTION_REGISTRY_ARGS = [ethers.parseEther("1.0"), 5, 25];
const PRODUCTION_ESCROW_ARGS = [5, 50, 67, 7200];
const CANARY_REGISTRY_ARGS = [ethers.parseEther("0.1"), 5, 25];
const CANARY_ESCROW_ARGS = [3, 50, 67, 3600];
const CANARY_03_REGISTRY_ARGS = [ethers.parseEther("0.25"), 5, 25];
const CANARY_03_ESCROW_ARGS = [4, 50, 67, 3600];

async function deployRegistry(args = PRODUCTION_REGISTRY_ARGS) {
  const Registry = await ethers.getContractFactory("VenomRegistry");
  return Registry.deploy(...args);
}

async function deployGovernance() {
  const ConsentManager = await ethers.getContractFactory("ConsentManager");
  const TitheManager = await ethers.getContractFactory("TitheManager");
  const consent = await ConsentManager.deploy();
  const tithe = await TitheManager.deploy();
  return { consent, tithe };
}

async function deployEscrow(registry, args = PRODUCTION_ESCROW_ARGS) {
  const gov = await deployGovernance();
  const Escrow = await ethers.getContractFactory("PilotEscrow");
  return Escrow.deploy(await registry.getAddress(), await gov.consent.getAddress(), await gov.tithe.getAddress(), ...args);
}

async function signEip712Score(signers, campaignUid, scores, escrowContract) {
  const net = await ethers.provider.getNetwork();
  const domain = {
    name: "VENOM PilotEscrow",
    version: "1",
    chainId: Number(net.chainId),
    verifyingContract: await escrowContract.getAddress()
  };
  const types = {
    Score: [
      { name: "campaignUid", type: "bytes32" },
      { name: "score", type: "uint256" }
    ]
  };
  return Promise.all(scores.map((score, index) => {
    return signers[index].signTypedData(domain, types, { campaignUid, score });
  }));
}

async function signEip712Abstain(signers, campaignUid, reasons, escrowContract) {
  const net = await ethers.provider.getNetwork();
  const domain = {
    name: "VENOM PilotEscrow",
    version: "1",
    chainId: Number(net.chainId),
    verifyingContract: await escrowContract.getAddress()
  };
  const types = {
    Abstain: [
      { name: "campaignUid", type: "bytes32" },
      { name: "reason", type: "uint8" }
    ]
  };
  return Promise.all(reasons.map((reason, index) => {
    return signers[index].signTypedData(domain, types, { campaignUid, reason });
  }));
}

describe("Configurable deployment constants", function () {
  it("preserves production profile values through public getters", async function () {
    const registry = await deployRegistry();
    const escrow = await deployEscrow(registry);

    expect(await registry.MIN_STAKE()).to.equal(ethers.parseEther("1.0"));
    expect(await registry.SLASH_PERCENT()).to.equal(5n);
    expect(await registry.MAX_DEVIATION()).to.equal(25n);
    expect(await escrow.REQUIRED_ORACLES()).to.equal(5n);
    expect(await escrow.SCORE_QUORUM_PCT()).to.equal(50n);
    expect(await escrow.PARTICIPATION_FLOOR_PCT()).to.equal(67n);
    expect(await escrow.CAMPAIGN_TIMEOUT_BLOCKS()).to.equal(7200n);
  });

  it("rejects invalid registry constructor constants", async function () {
    const Registry = await ethers.getContractFactory("VenomRegistry");

    await expect(Registry.deploy(ethers.parseEther("0.009"), 5, 25))
      .to.be.revertedWith("Invalid MIN_STAKE");
    await expect(Registry.deploy(ethers.parseEther("1.0"), 0, 25))
      .to.be.revertedWith("Invalid SLASH_PERCENT");
    await expect(Registry.deploy(ethers.parseEther("1.0"), 5, 0))
      .to.be.revertedWith("Invalid MAX_DEVIATION");
  });

  it("rejects invalid escrow constructor constants", async function () {
    const registry = await deployRegistry();
    const Escrow = await ethers.getContractFactory("PilotEscrow");
    const registryAddress = await registry.getAddress();
    const gov = await deployGovernance();

    await expect(Escrow.deploy(registryAddress, await gov.consent.getAddress(), await gov.tithe.getAddress(), 0, 50, 67, 7200))
      .to.be.revertedWith("Invalid REQUIRED_ORACLES");
    await expect(Escrow.deploy(registryAddress, await gov.consent.getAddress(), await gov.tithe.getAddress(), 5, 0, 67, 7200))
      .to.be.revertedWith("Invalid SCORE_QUORUM_PCT");
    await expect(Escrow.deploy(registryAddress, await gov.consent.getAddress(), await gov.tithe.getAddress(), 5, 50, 49, 7200))
      .to.be.revertedWith("Invalid PARTICIPATION_FLOOR_PCT");
    await expect(Escrow.deploy(registryAddress, await gov.consent.getAddress(), await gov.tithe.getAddress(), 5, 50, 67, 99))
      .to.be.revertedWith("Invalid CAMPAIGN_TIMEOUT_BLOCKS");
  });

  it("allows the Canary 01.5 profile to close with 3 score signers in a 5-oracle set", async function () {
    const [owner, ...oracles] = await ethers.getSigners();
    const registry = await deployRegistry(CANARY_REGISTRY_ARGS);
    const escrow = await deployEscrow(registry, CANARY_ESCROW_ARGS);
    await registry.setPilotEscrow(await escrow.getAddress());

    for (let i = 0; i < 5; i++) {
      await registry.connect(oracles[i]).registerOracle(`/ip4/127.0.0.1/tcp/50${i}`, {
        value: ethers.parseEther("0.1")
      });
    }

    const uid = ethers.id("canary-01-5-config");
    const bounty = ethers.parseEther("0.01");
    await escrow.connect(owner).fundCampaign(uid, "ipfs://canary", ethers.ZeroHash, { value: bounty });

    const scores = [80, 82, 84];
    const scoreSigs = await signEip712Score(oracles.slice(0, 3), uid, scores, escrow);
    const reasons = [1, 1];
    const abstainSigs = await signEip712Abstain(oracles.slice(3, 5), uid, reasons, escrow);

    await expect(escrow.closeCampaign(uid, scores, scoreSigs, reasons, abstainSigs))
      .to.emit(escrow, "CampaignClosed")
      .withArgs(uid, owner.address, bounty, 82);
  });

  describe("Canary 03 profile constants", function () {
    let owner, registry, escrow, oracles;

    beforeEach(async function () {
      [owner, ...oracles] = await ethers.getSigners();
      registry = await deployRegistry(CANARY_03_REGISTRY_ARGS);
      escrow = await deployEscrow(registry, CANARY_03_ESCROW_ARGS);
      await registry.setPilotEscrow(await escrow.getAddress());

      for (let i = 0; i < 5; i++) {
        await registry.connect(oracles[i]).registerOracle(`/ip4/127.0.0.1/tcp/60${i}`, {
          value: ethers.parseEther("0.25")
        });
      }
    });

    it("closes with 4 score signers and 1 abstain in a 5-oracle set", async function () {
      const uid = ethers.id("canary-03-four-score-one-abstain");
      const bounty = ethers.parseEther("0.01");
      await escrow.connect(owner).fundCampaign(uid, "ipfs://canary-03", ethers.ZeroHash, { value: bounty });

      const scores = [78, 80, 82, 84];
      const scoreSigs = await signEip712Score(oracles.slice(0, 4), uid, scores, escrow);
      const reasons = [6];
      const abstainSigs = await signEip712Abstain(oracles.slice(4, 5), uid, reasons, escrow);

      await expect(escrow.closeCampaign(uid, scores, scoreSigs, reasons, abstainSigs))
        .to.emit(escrow, "CampaignClosed")
        .withArgs(uid, owner.address, bounty, 82);
    });

    it("rejects 3 score signers even when 2 oracles abstain", async function () {
      const uid = ethers.id("canary-03-three-score-two-abstain");
      await escrow.connect(owner).fundCampaign(uid, "ipfs://canary-03", ethers.ZeroHash, { value: ethers.parseEther("0.01") });

      const scores = [78, 80, 82];
      const scoreSigs = await signEip712Score(oracles.slice(0, 3), uid, scores, escrow);
      const reasons = [5, 5];
      const abstainSigs = await signEip712Abstain(oracles.slice(3, 5), uid, reasons, escrow);

      await expect(escrow.closeCampaign(uid, scores, scoreSigs, reasons, abstainSigs))
        .to.be.revertedWith("Below absolute score floor");
    });

    it("slashes exactly one score outlier and preserves honest oracle stake", async function () {
      const uid = ethers.id("canary-03-outlier-slash");
      const bounty = ethers.parseEther("0.01");
      await escrow.connect(owner).fundCampaign(uid, "ipfs://canary-03", ethers.ZeroHash, { value: bounty });

      const scores = [75, 75, 75, 75, 25];
      const scoreSigs = await signEip712Score(oracles.slice(0, 5), uid, scores, escrow);
      const stakeBefore = (await registry.oracles(oracles[4].address)).stake;
      const expectedSlash = (stakeBefore * 5n) / 100n;

      const closeTx = escrow.closeCampaign(uid, scores, scoreSigs, [], []);
      await expect(closeTx)
        .to.emit(escrow, "CampaignClosed")
        .withArgs(uid, owner.address, bounty, 75);
      await expect(closeTx)
        .to.emit(escrow, "DeviationReported")
        .withArgs(uid, oracles[4].address, 25, 75, 50);
      await expect(closeTx)
        .to.emit(registry, "OracleSlashed")
        .withArgs(oracles[4].address, expectedSlash, "Score deviation too high");

      const slashedOracle = await registry.oracles(oracles[4].address);
      expect(slashedOracle.stake).to.equal(stakeBefore - expectedSlash);
      expect(slashedOracle.active).to.equal(false);
      expect(await registry.slashedStakeReserve()).to.equal(expectedSlash);

      for (let i = 0; i < 4; i++) {
        const honestOracle = await registry.oracles(oracles[i].address);
        expect(honestOracle.stake).to.equal(ethers.parseEther("0.25"));
        expect(honestOracle.active).to.equal(true);
      }
    });

    it("slashes each score outlier beyond MAX_DEVIATION", async function () {
      const uid = ethers.id("canary-03-two-outliers");
      await escrow.connect(owner).fundCampaign(uid, "ipfs://canary-03", ethers.ZeroHash, { value: ethers.parseEther("0.01") });

      const scores = [80, 80, 80, 28, 25];
      const scoreSigs = await signEip712Score(oracles.slice(0, 5), uid, scores, escrow);
      const stakeBefore = (await registry.oracles(oracles[3].address)).stake;
      const expectedSlash = (stakeBefore * 5n) / 100n;

      const closeTx = escrow.closeCampaign(uid, scores, scoreSigs, [], []);
      await expect(closeTx)
        .to.emit(registry, "OracleSlashed")
        .withArgs(oracles[3].address, expectedSlash, "Score deviation too high");
      await expect(closeTx)
        .to.emit(registry, "OracleSlashed")
        .withArgs(oracles[4].address, expectedSlash, "Score deviation too high");

      expect((await registry.oracles(oracles[3].address)).active).to.equal(false);
      expect((await registry.oracles(oracles[4].address)).active).to.equal(false);
      expect(await registry.slashedStakeReserve()).to.equal(expectedSlash * 2n);
    });

    it("does not slash a score at the MAX_DEVIATION boundary", async function () {
      const uid = ethers.id("canary-03-boundary-no-slash");
      const bounty = ethers.parseEther("0.01");
      await escrow.connect(owner).fundCampaign(uid, "ipfs://canary-03", ethers.ZeroHash, { value: bounty });

      const scores = [80, 80, 80, 80, 55];
      const scoreSigs = await signEip712Score(oracles.slice(0, 5), uid, scores, escrow);

      await expect(escrow.closeCampaign(uid, scores, scoreSigs, [], []))
        .to.emit(escrow, "CampaignClosed")
        .withArgs(uid, owner.address, bounty, 80);

      expect(await registry.slashedStakeReserve()).to.equal(0n);
      for (let i = 0; i < 5; i++) {
        expect((await registry.oracles(oracles[i].address)).active).to.equal(true);
      }
    });

    it("slashes a below-threshold individual score when the median passes", async function () {
      const uid = ethers.id("canary-03-below-threshold-individual-slash");
      const bounty = ethers.parseEther("0.01");
      await escrow.connect(owner).fundCampaign(uid, "ipfs://canary-03", ethers.ZeroHash, { value: bounty });

      const scores = [80, 80, 80, 80, 54];
      const scoreSigs = await signEip712Score(oracles.slice(0, 5), uid, scores, escrow);
      const stakeBefore = (await registry.oracles(oracles[4].address)).stake;
      const expectedSlash = (stakeBefore * 5n) / 100n;

      const closeTx = escrow.closeCampaign(uid, scores, scoreSigs, [], []);
      await expect(closeTx)
        .to.emit(escrow, "CampaignClosed")
        .withArgs(uid, owner.address, bounty, 80);
      await expect(closeTx)
        .to.emit(registry, "OracleSlashed")
        .withArgs(oracles[4].address, expectedSlash, "Score deviation too high");

      expect((await registry.oracles(oracles[4].address)).active).to.equal(false);
      expect(await registry.slashedStakeReserve()).to.equal(expectedSlash);
    });
  });
});
