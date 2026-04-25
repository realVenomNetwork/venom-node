const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("PilotEscrow v1.1.0-rc.1 — Quorum & Cancellation", function () {
    let registry, escrow, owner, attacker, oracles;

    beforeEach(async function () {
        [owner, attacker, ...oracles] = await ethers.getSigners(); // Hardhat provides 20 signers by default

        const Registry = await ethers.getContractFactory("VenomRegistry");
        registry = await Registry.deploy();

        const Escrow = await ethers.getContractFactory("PilotEscrow");
        escrow = await Escrow.deploy(await registry.getAddress());
        await registry.setPilotEscrow(await escrow.getAddress());

        // Register 10 active oracles for clean percentage math
        for (let i = 0; i < 10; i++) {
            await registry.connect(oracles[i]).registerOracle(`/ip4/127.0.0.1/tcp/400${i}`, { value: ethers.parseEther("1.0") });
        }
    });

    async function signEip712Score(signers, campaignUid, scores, escrowContract) {
        const net = await ethers.provider.getNetwork();
        const domain = { name: "VENOM PilotEscrow", version: "1", chainId: Number(net.chainId), verifyingContract: await escrowContract.getAddress() };
        const types = { Score: [{ name: "campaignUid", type: "bytes32" }, { name: "score", type: "uint256" }] };
        return Promise.all(scores.map((score, i) => signers[i].signTypedData(domain, types, { campaignUid, score })));
    }

    async function signEip712Abstain(signers, campaignUid, reasons, escrowContract) {
        const net = await ethers.provider.getNetwork();
        const domain = { name: "VENOM PilotEscrow", version: "1", chainId: Number(net.chainId), verifyingContract: await escrowContract.getAddress() };
        const types = { Abstain: [{ name: "campaignUid", type: "bytes32" }, { name: "reason", type: "uint8" }] };
        return Promise.all(reasons.map((reason, i) => signers[i].signTypedData(domain, types, { campaignUid, reason })));
    }

    it("1. Score quorum: 4 attacker scores + 6 honest abstains reverts (40% < 50% Quorum)", async function () {
        const uid = ethers.id("Q1");
        await escrow.connect(owner).fundCampaign(uid, { value: ethers.parseEther("1.0") });

        const scores = [99, 99, 99, 99];
        const scoreSigs = await signEip712Score(oracles.slice(0, 4), uid, scores, escrow);
        
        const reasons = [0, 0, 0, 0, 0, 0]; // 6 Timeouts
        const abstainSigs = await signEip712Abstain(oracles.slice(4, 10), uid, reasons, escrow);

        await expect(escrow.closeCampaign(uid, scores, scoreSigs, reasons, abstainSigs))
            .to.be.revertedWith("Below absolute score floor");
    });

    it("2. Score quorum: 5 attacker scores + 5 honest abstains passes threshold gate (50% >= 50%)", async function () {
        const uid = ethers.id("Q2");
        await escrow.connect(owner).fundCampaign(uid, { value: ethers.parseEther("1.0") });

        const scores = [99, 99, 99, 99, 99];
        const scoreSigs = await signEip712Score(oracles.slice(0, 5), uid, scores, escrow);
        
        const reasons = [0, 0, 0, 0, 0]; 
        const abstainSigs = await signEip712Abstain(oracles.slice(5, 10), uid, reasons, escrow);

        await escrow.closeCampaign(uid, scores, scoreSigs, reasons, abstainSigs);
        const campaign = await escrow.campaigns(uid);
        expect(campaign.closed).to.be.true;
    });

    it("3. Participation floor: 5 valid scores + 0 abstains in 10-oracle network reverts (50% < 67% Floor)", async function () {
        const uid = ethers.id("Q3");
        await escrow.connect(owner).fundCampaign(uid, { value: ethers.parseEther("1.0") });

        const scores = [70, 70, 70, 70, 70];
        const scoreSigs = await signEip712Score(oracles.slice(0, 5), uid, scores, escrow);

        await expect(escrow.closeCampaign(uid, scores, scoreSigs, [], []))
            .to.be.revertedWith("Below participation floor");
    });

    it("4. Happy path: 6 scores near median + 4 abstains in 10-oracle network closes", async function () {
        const uid = ethers.id("Q4");
        await escrow.connect(owner).fundCampaign(uid, { value: ethers.parseEther("1.0") });

        const scores = [75, 76, 74, 75, 75, 75];
        const scoreSigs = await signEip712Score(oracles.slice(0, 6), uid, scores, escrow);
        
        const reasons = [0, 1, 2, 0]; 
        const abstainSigs = await signEip712Abstain(oracles.slice(6, 10), uid, reasons, escrow);

        await escrow.closeCampaign(uid, scores, scoreSigs, reasons, abstainSigs);
        const campaign = await escrow.campaigns(uid);
        expect(campaign.closed).to.be.true;
    });

    it("5. Score-and-abstain by same oracle: abstain is dropped, score counts", async function () {
        const uid = ethers.id("Q5");
        await escrow.connect(owner).fundCampaign(uid, { value: ethers.parseEther("1.0") });

        const scores = [75, 75, 75, 75, 75, 75];
        const scoreSigs = await signEip712Score(oracles.slice(0, 6), uid, scores, escrow);
        
        // Oracle 0 tries to abstain AND score
        const reasons = [0, 0];
        const abstainSigs = await signEip712Abstain([oracles[0], oracles[6]], uid, reasons, escrow);

        await escrow.closeCampaign(uid, scores, scoreSigs, reasons, abstainSigs);
        // Should succeed because validScoreCount = 6, validAbstainCount = 1 (Oracle 0's abstain is dropped). 
        // Total participation = 7 (70% >= 67%)
        expect((await escrow.campaigns(uid)).closed).to.be.true;
    });

    it("6. Cancel before timeout reverts", async function () {
        const uid = ethers.id("C1");
        await escrow.connect(owner).fundCampaign(uid, { value: ethers.parseEther("1.0") });
        await expect(escrow.connect(owner).cancelCampaign(uid))
            .to.be.revertedWith("Timeout not reached");
    });

    it("7. Cancel after timeout refunds 99% to funder, 1% to insurance pool", async function () {
        const uid = ethers.id("C2");
        const bounty = ethers.parseEther("1.0");
        await escrow.connect(owner).fundCampaign(uid, { value: bounty });

        // Mine 7200 blocks to pass CAMPAIGN_TIMEOUT_BLOCKS
        await ethers.provider.send("hardhat_mine", ["0x1C20"]); 

        const ownerBefore = await ethers.provider.getBalance(owner.address);
        
        const tx = await escrow.connect(owner).cancelCampaign(uid);
        const rcpt = await tx.wait();
        const gasSpent = rcpt.gasUsed * rcpt.gasPrice;

        const ownerAfter = await ethers.provider.getBalance(owner.address);
        
        // 99% of 1 ETH = 0.99 ETH
        const expectedRefund = (bounty * 9900n) / 10000n;
        expect(ownerAfter - ownerBefore + gasSpent).to.equal(expectedRefund);
        
        // 1% to insurance pool
        expect(await escrow.insurancePool()).to.equal((bounty * 100n) / 10000n);
    });

    it("8. Cancel by non-funder reverts", async function () {
        const uid = ethers.id("C3");
        await escrow.connect(owner).fundCampaign(uid, { value: ethers.parseEther("1.0") });
        await ethers.provider.send("hardhat_mine", ["0x1C20"]); 

        await expect(escrow.connect(attacker).cancelCampaign(uid))
            .to.be.revertedWith("Not funder");
    });

    it("9. EIP-712 abstain replay across deployments fails", async function () {
        const Escrow = await ethers.getContractFactory("PilotEscrow");
        const escrowB = await Escrow.deploy(await registry.getAddress());

        const uid = ethers.id("R1");
        await escrowB.connect(owner).fundCampaign(uid, { value: ethers.parseEther("1.0") });

        const scores = [70, 70, 70, 70, 70];
        const scoreSigs = await signEip712Score(oracles.slice(0, 5), uid, scores, escrowB);

        const reasons = [0, 0];
        // Sign abstains against Escrow A's domain
        const abstainSigsForA = await signEip712Abstain(oracles.slice(5, 7), uid, reasons, escrow);

        // Submit to Escrow B. The score sigs are valid, but the abstain sigs will fail to recover to active oracles.
        // This drops the validAbstainCount to 0, resulting in 50% total participation, which fails the 67% floor.
        await expect(escrowB.closeCampaign(uid, scores, scoreSigs, reasons, abstainSigsForA))
            .to.be.revertedWith("Below participation floor");
    });
});