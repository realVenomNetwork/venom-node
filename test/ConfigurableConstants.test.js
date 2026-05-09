const { expect } = require("chai");
const { ethers } = require("hardhat");

const PRODUCTION_REGISTRY_ARGS = [ethers.parseEther("1.0"), 5, 25];
const PRODUCTION_ESCROW_ARGS = [5, 50, 67, 7200];
const CANARY_REGISTRY_ARGS = [ethers.parseEther("0.1"), 5, 25];
const CANARY_ESCROW_ARGS = [3, 50, 67, 3600];

async function deployRegistry(args = PRODUCTION_REGISTRY_ARGS) {
  const Registry = await ethers.getContractFactory("VenomRegistry");
  return Registry.deploy(...args);
}

async function deployEscrow(registry, args = PRODUCTION_ESCROW_ARGS) {
  const Escrow = await ethers.getContractFactory("PilotEscrow");
  return Escrow.deploy(await registry.getAddress(), ...args);
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

    await expect(Escrow.deploy(registryAddress, 0, 50, 67, 7200))
      .to.be.revertedWith("Invalid REQUIRED_ORACLES");
    await expect(Escrow.deploy(registryAddress, 5, 0, 67, 7200))
      .to.be.revertedWith("Invalid SCORE_QUORUM_PCT");
    await expect(Escrow.deploy(registryAddress, 5, 50, 49, 7200))
      .to.be.revertedWith("Invalid PARTICIPATION_FLOOR_PCT");
    await expect(Escrow.deploy(registryAddress, 5, 50, 67, 99))
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
});
