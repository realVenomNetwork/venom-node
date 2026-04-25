const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("PilotEscrow v1.0.2 — Full Trust Root Verification", function () {
  let registry, escrow;
  let owner, funder, oracles;
  let domain;

  const REQUIRED_ORACLES = 5;
  const PASS_THRESHOLD = 60;
  const CAMPAIGN_UID_1 = ethers.id("campaign1");
  const CAMPAIGN_UID_2 = ethers.id("campaign2");

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    owner = signers[0];
    funder = signers[1];
    oracles = signers.slice(2, 2 + REQUIRED_ORACLES);

    const Registry = await ethers.getContractFactory("VenomRegistry");
    registry = await Registry.deploy();

    const Escrow = await ethers.getContractFactory("PilotEscrow");
    escrow = await Escrow.deploy(await registry.getAddress());

    await registry.setPilotEscrow(await escrow.getAddress());

    for (let oracle of oracles) {
      await registry.connect(oracle).registerOracle("/ip4/0.0.0.0/tcp/0", { value: ethers.parseEther("1") });
    }

    domain = {
      name: "VENOM PilotEscrow",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await escrow.getAddress()
    };
  });

  async function signScore(oracle, campaignUid, score) {
    const types = {
      Score: [
        { name: "campaignUid", type: "bytes32" },
        { name: "score", type: "uint256" }
      ]
    };
    return await oracle.signTypedData(domain, types, { campaignUid, score });
  }

  it("TEST 1: Drain attack on unfunded campaign reverts (with valid signatures)", async function () {
    const scores = oracles.map(() => 80);
    const signatures = await Promise.all(oracles.map(o => signScore(o, CAMPAIGN_UID_1, 80)));

    await expect(
      escrow.closeCampaign(CAMPAIGN_UID_1, owner.address, ethers.parseEther("1"), 0, scores, signatures)
    ).to.be.revertedWith("Campaign not funded");
  });

  it("TEST 2: Malicious outlier is slashed, honest oracles protected (index alignment)", async function () {
    await escrow.connect(funder).fundCampaign(CAMPAIGN_UID_1, { value: ethers.parseEther("1") });

    const scores = [80, 80, 80, 80, 10]; // 10 is the outlier
    const signatures = await Promise.all(oracles.map((o, i) => signScore(o, CAMPAIGN_UID_1, scores[i])));

    await escrow.closeCampaign(CAMPAIGN_UID_1, owner.address, ethers.parseEther("1"), 0, scores, signatures);

    const maliciousOracle = oracles[4];
    const honestOracle = oracles[0];

    const maliciousState = await registry.oracles(maliciousOracle.address);
    const honestState = await registry.oracles(honestOracle.address);

    expect(maliciousState.active).to.be.false;
    expect(honestState.active).to.be.true;
  });

  it("TEST 3: Median below threshold reverts", async function () {
    await escrow.connect(funder).fundCampaign(CAMPAIGN_UID_1, { value: ethers.parseEther("1") });

    const scores = oracles.map(() => 50); // Below threshold
    const signatures = await Promise.all(oracles.map(o => signScore(o, CAMPAIGN_UID_1, 50)));

    await expect(
      escrow.closeCampaign(CAMPAIGN_UID_1, owner.address, ethers.parseEther("1"), 0, scores, signatures)
    ).to.be.revertedWith("Median below threshold");
  });

  it("TEST 4: Caller-supplied recipient/bounty are ignored — funder gets stored bounty", async function () {
    await escrow.connect(funder).fundCampaign(CAMPAIGN_UID_1, { value: ethers.parseEther("1") });

    const scores = oracles.map(() => 80);
    const signatures = await Promise.all(oracles.map(o => signScore(o, CAMPAIGN_UID_1, 80)));

    const funderBalanceBefore = await ethers.provider.getBalance(funder.address);
    
    // Caller tries to send funds to owner instead of funder
    await escrow.closeCampaign(CAMPAIGN_UID_1, owner.address, ethers.parseEther("0.1"), 0, scores, signatures);

    const funderBalanceAfter = await ethers.provider.getBalance(funder.address);
    expect(funderBalanceAfter - funderBalanceBefore).to.equal(ethers.parseEther("1"));
  });

  it("TEST 5: Per-campaign isolation — closing A leaves B's funds untouched", async function () {
    await escrow.connect(funder).fundCampaign(CAMPAIGN_UID_1, { value: ethers.parseEther("1") });
    await escrow.connect(funder).fundCampaign(CAMPAIGN_UID_2, { value: ethers.parseEther("2") });

    const scores = oracles.map(() => 80);
    const signatures = await Promise.all(oracles.map(o => signScore(o, CAMPAIGN_UID_1, 80)));

    await escrow.closeCampaign(CAMPAIGN_UID_1, owner.address, 0, 0, scores, signatures);

    const campaign2 = await escrow.campaigns(CAMPAIGN_UID_2);
    expect(campaign2.closed).to.be.false;
    expect(campaign2.bounty).to.equal(ethers.parseEther("2"));
  });

  it("TEST 6: setPilotEscrow is owner-gated and one-shot", async function () {
    const Registry = await ethers.getContractFactory("VenomRegistry");
    const newRegistry = await Registry.deploy();

    await expect(
      newRegistry.connect(funder).setPilotEscrow(owner.address)
    ).to.be.revertedWithCustomError(newRegistry, "OwnableUnauthorizedAccount");

    await newRegistry.setPilotEscrow(owner.address);

    await expect(
      newRegistry.setPilotEscrow(funder.address)
    ).to.be.revertedWith("Already set");
  });

  it("TEST 7: EIP-712 — signatures from one PilotEscrow do not validate on another", async function () {
    await escrow.connect(funder).fundCampaign(CAMPAIGN_UID_1, { value: ethers.parseEther("1") });

    const Escrow2 = await ethers.getContractFactory("PilotEscrow");
    const escrow2 = await Escrow2.deploy(await registry.getAddress());

    const domain2 = {
      name: "VENOM PilotEscrow",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await escrow2.getAddress()
    };

    const types = {
      Score: [
        { name: "campaignUid", type: "bytes32" },
        { name: "score", type: "uint256" }
      ]
    };

    const scores = oracles.map(() => 80);
    // Sign for escrow2, but submit to escrow
    const signatures = await Promise.all(oracles.map(o => o.signTypedData(domain2, types, { campaignUid: CAMPAIGN_UID_1, score: 80 })));

    await expect(
      escrow.closeCampaign(CAMPAIGN_UID_1, owner.address, ethers.parseEther("1"), 0, scores, signatures)
    ).to.be.revertedWith("Not enough valid oracles");
  });
});