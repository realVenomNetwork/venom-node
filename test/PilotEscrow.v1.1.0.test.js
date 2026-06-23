const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("PilotEscrow v1.1.0-rc.1 — Quorum & Cancellation", function () {
    const REGISTRY_ARGS = [ethers.parseEther("1.0"), 5, 25];
    const ESCROW_ARGS = [5, 50, 67, 7200];
    let registry, escrow, owner, attacker, oracles;

    beforeEach(async function () {
        [owner, attacker, ...oracles] = await ethers.getSigners(); // Hardhat provides 20 signers by default

        const Registry = await ethers.getContractFactory("VenomRegistry");
        registry = await Registry.deploy(...REGISTRY_ARGS);

        const ConsentManager = await ethers.getContractFactory("ConsentManager");
        const TitheManager = await ethers.getContractFactory("TitheManager");
        const consentManager = await ConsentManager.deploy();
        const titheManager = await TitheManager.deploy();

        const Escrow = await ethers.getContractFactory("PilotEscrow");
        escrow = await Escrow.deploy(await registry.getAddress(), await consentManager.getAddress(), await titheManager.getAddress(), ...ESCROW_ARGS);
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

    function forceHighS(signature) {
        const secp256k1N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
        const parsed = ethers.Signature.from(signature);
        if (parsed.v !== 27 && parsed.v !== 28) {
            throw new Error(`Unexpected signature v: ${parsed.v}`);
        }
        const highS = secp256k1N - BigInt(parsed.s);
        const flippedV = parsed.v === 27 ? 28 : 27;
        return ethers.concat([
            parsed.r,
            ethers.toBeHex(highS, 32),
            ethers.toBeHex(flippedV, 1)
        ]);
    }

    it("1. Score quorum: 4 attacker scores + 6 honest abstains reverts (40% < 50% Quorum)", async function () {
        const uid = ethers.id("Q1");
        await escrow.connect(owner).fundCampaign(uid, "ipfs://test", ethers.id("test"), { value: ethers.parseEther("1.0") });

        const scores = [99, 99, 99, 99];
        const scoreSigs = await signEip712Score(oracles.slice(0, 4), uid, scores, escrow);
        
        const reasons = [0, 0, 0, 0, 0, 0]; // 6 Timeouts
        const abstainSigs = await signEip712Abstain(oracles.slice(4, 10), uid, reasons, escrow);

        await expect(escrow.closeCampaign(uid, scores, scoreSigs, reasons, abstainSigs))
            .to.be.revertedWith("Below absolute score floor");
    });

    it("2. Score quorum: 5 attacker scores + 5 honest abstains passes threshold gate (50% >= 50%)", async function () {
        const uid = ethers.id("Q2");
        await escrow.connect(owner).fundCampaign(uid, "ipfs://test", ethers.id("test"), { value: ethers.parseEther("1.0") });

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
        await escrow.connect(owner).fundCampaign(uid, "ipfs://test", ethers.id("test"), { value: ethers.parseEther("1.0") });

        const scores = [70, 70, 70, 70, 70];
        const scoreSigs = await signEip712Score(oracles.slice(0, 5), uid, scores, escrow);

        await expect(escrow.closeCampaign(uid, scores, scoreSigs, [], []))
            .to.be.revertedWith("Below participation floor");
    });

    it("4. Happy path: 6 scores near median + 4 abstains in 10-oracle network closes", async function () {
        const uid = ethers.id("Q4");
        await escrow.connect(owner).fundCampaign(uid, "ipfs://test", ethers.id("test"), { value: ethers.parseEther("1.0") });

        const scores = [74, 75, 75, 75, 75, 76];
        const scoreSigs = await signEip712Score(oracles.slice(0, 6), uid, scores, escrow);
        
        const reasons = [0, 1, 2, 0]; 
        const abstainSigs = await signEip712Abstain(oracles.slice(6, 10), uid, reasons, escrow);

        await escrow.closeCampaign(uid, scores, scoreSigs, reasons, abstainSigs);
        const campaign = await escrow.campaigns(uid);
        expect(campaign.closed).to.be.true;
    });

    it("4b. Happy path accepts unsorted score arrival order and computes the median on-chain", async function () {
        const uid = ethers.id("Q4B");
        await escrow.connect(owner).fundCampaign(uid, "ipfs://test", ethers.id("test"), { value: ethers.parseEther("1.0") });

        const scores = [90, 65, 81, 75, 70, 79];
        const scoreSigs = await signEip712Score(oracles.slice(0, 6), uid, scores, escrow);
        const reasons = [1];
        const abstainSigs = await signEip712Abstain(oracles.slice(6, 7), uid, reasons, escrow);

        await expect(escrow.closeCampaign(uid, scores, scoreSigs, reasons, abstainSigs))
            .to.emit(escrow, "CampaignClosed")
            .withArgs(uid, owner.address, ethers.parseEther("1.0"), 79);
        expect((await escrow.campaigns(uid)).closed).to.be.true;
    });

    it("4c. closeCampaign reports and slashes score outliers beyond MAX_DEVIATION", async function () {
        const uid = ethers.id("Q4C");
        await escrow.connect(owner).fundCampaign(uid, "ipfs://test", ethers.id("test"), { value: ethers.parseEther("1.0") });

        const scores = [70, 40, 70, 70, 70, 70];
        const scoreSigs = await signEip712Score(oracles.slice(0, 6), uid, scores, escrow);
        const reasons = [1];
        const abstainSigs = await signEip712Abstain(oracles.slice(6, 7), uid, reasons, escrow);
        const stakeBefore = (await registry.oracles(oracles[1].address)).stake;

        const closeTx = escrow.closeCampaign(uid, scores, scoreSigs, reasons, abstainSigs);

        await expect(closeTx)
            .to.emit(escrow, "DeviationReported")
            .withArgs(uid, oracles[1].address, 40, 70, 30);
        await expect(closeTx)
            .to.emit(registry, "OracleSlashed");

        const honestOracleAfter = await registry.oracles(oracles[0].address);
        const oracleAfter = await registry.oracles(oracles[1].address);
        const slashAmount = (stakeBefore * 5n) / 100n;
        expect(honestOracleAfter.active).to.be.true;
        expect(oracleAfter.stake).to.equal(stakeBefore - slashAmount);
        expect(oracleAfter.active).to.be.false;
        expect(await registry.slashedStakeReserve()).to.equal(slashAmount);
        expect(await registry.everSlashed(oracles[1].address)).to.be.true;
    });

    it("5. Score-and-abstain by same oracle: abstain is dropped, score counts", async function () {
        const uid = ethers.id("Q5");
        await escrow.connect(owner).fundCampaign(uid, "ipfs://test", ethers.id("test"), { value: ethers.parseEther("1.0") });

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

    it("5b. Duplicate abstains by one oracle do not inflate participation", async function () {
        const uid = ethers.id("Q5B");
        await escrow.connect(owner).fundCampaign(uid, "ipfs://test", ethers.id("test"), { value: ethers.parseEther("1.0") });

        const scores = [75, 75, 75, 75, 75];
        const scoreSigs = await signEip712Score(oracles.slice(0, 5), uid, scores, escrow);

        const reasons = [0, 0];
        const abstainSigs = await signEip712Abstain([oracles[5], oracles[5]], uid, reasons, escrow);

        await expect(escrow.closeCampaign(uid, scores, scoreSigs, reasons, abstainSigs))
            .to.be.revertedWith("Below participation floor");
    });

    it("6. Cancel before timeout reverts", async function () {
        const uid = ethers.id("C1");
        await escrow.connect(owner).fundCampaign(uid, "ipfs://test", ethers.id("test"), { value: ethers.parseEther("1.0") });
        await expect(escrow.connect(owner).cancelCampaign(uid))
            .to.be.revertedWith("Timeout not reached");
    });

    it("7. Cancel after timeout refunds 99% to funder, 1% to insurance pool", async function () {
        const uid = ethers.id("C2");
        const bounty = ethers.parseEther("1.0");
        await escrow.connect(owner).fundCampaign(uid, "ipfs://test", ethers.id("test"), { value: bounty });

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
        await escrow.connect(owner).fundCampaign(uid, "ipfs://test", ethers.id("test"), { value: ethers.parseEther("1.0") });
        await ethers.provider.send("hardhat_mine", ["0x1C20"]); 

        await expect(escrow.connect(attacker).cancelCampaign(uid))
            .to.be.revertedWith("Not funder");
    });

    it("9. EIP-712 abstain replay across deployments fails", async function () {
        const ConsentManager = await ethers.getContractFactory("ConsentManager");
        const TitheManager = await ethers.getContractFactory("TitheManager");
        const consentB = await ConsentManager.deploy();
        const titheB = await TitheManager.deploy();
        const Escrow = await ethers.getContractFactory("PilotEscrow");
        const escrowB = await Escrow.deploy(await registry.getAddress(), await consentB.getAddress(), await titheB.getAddress(), ...ESCROW_ARGS);

        const uid = ethers.id("R1");
        await escrowB.connect(owner).fundCampaign(uid, "ipfs://test", ethers.id("test"), { value: ethers.parseEther("1.0") });

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

    it("10. Rejects high-s malleable score signatures", async function () {
        const uid = ethers.id("R2");
        await escrow.connect(owner).fundCampaign(uid, "ipfs://test", ethers.id("test"), { value: ethers.parseEther("1.0") });

        const scores = [75, 75, 75, 75, 75];
        const scoreSigs = (await signEip712Score(oracles.slice(0, 5), uid, scores, escrow)).map(forceHighS);
        const reasons = [0, 0, 0, 0, 0];
        const abstainSigs = await signEip712Abstain(oracles.slice(5, 10), uid, reasons, escrow);

        await expect(escrow.closeCampaign(uid, scores, scoreSigs, reasons, abstainSigs))
            .to.be.revertedWith("Below absolute score floor");
    });

    it("11. Caps caller-provided score arrays to the active oracle count", async function () {
        const uid = ethers.id("CAP1");
        await escrow.connect(owner).fundCampaign(uid, "ipfs://test", ethers.id("test"), { value: ethers.parseEther("1.0") });

        const scoreSigners = [...oracles.slice(0, 10), oracles[0]];
        const scores = Array(11).fill(75);
        const scoreSigs = await signEip712Score(scoreSigners, uid, scores, escrow);

        await expect(escrow.closeCampaign(uid, scores, scoreSigs, [], []))
            .to.be.revertedWith("Too many scores");
    });

    it("12. Ignores signed scores outside the supported 0-100 range", async function () {
        const uid = ethers.id("CAP2");
        await escrow.connect(owner).fundCampaign(uid, "ipfs://test", ethers.id("test"), { value: ethers.parseEther("1.0") });

        const scores = [101, 75, 75, 75, 75];
        const scoreSigs = await signEip712Score(oracles.slice(0, 5), uid, scores, escrow);
        const reasons = [0, 0, 0, 0, 0];
        const abstainSigs = await signEip712Abstain(oracles.slice(5, 10), uid, reasons, escrow);

        await expect(escrow.closeCampaign(uid, scores, scoreSigs, reasons, abstainSigs))
            .to.be.revertedWith("Below absolute score floor");
    });

    it("13. Owner can pause funding and closing during an incident", async function () {
        const uid = ethers.id("P1");
        await escrow.pause();

        await expect(escrow.connect(owner).fundCampaign(uid, "ipfs://test", ethers.id("test"), { value: ethers.parseEther("1.0") }))
            .to.be.revertedWithCustomError(escrow, "EnforcedPause");

        await escrow.unpause();
        await escrow.connect(owner).fundCampaign(uid, "ipfs://test", ethers.id("test"), { value: ethers.parseEther("1.0") });
        await escrow.pause();

        await expect(escrow.closeCampaign(uid, [], [], [], []))
            .to.be.revertedWithCustomError(escrow, "EnforcedPause");
    });

    it("14. Owner pause also blocks timed-out campaign cancellation", async function () {
        const uid = ethers.id("P2");
        await escrow.connect(owner).fundCampaign(uid, "ipfs://test", ethers.id("test"), { value: ethers.parseEther("1.0") });
        await ethers.provider.send("hardhat_mine", ["0x1C20"]);

        await escrow.pause();
        await expect(escrow.connect(owner).cancelCampaign(uid))
            .to.be.revertedWithCustomError(escrow, "EnforcedPause");
    });
});
