const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const {
    validateRuntimeModeConfig,
    RUNTIME_MODE_ENV,
    TEST_PAYLOAD_ENV
} = require("../src/config/runtime-mode");
const { isPrivateOrWildcardMultiaddr } = require("../src/utils/multiaddr");

describe("VenomRegistry — Unstake, Slash, and Timelock", function () {
    let registry, escrow, owner, oracle1, oracle2, attacker;

    beforeEach(async function () {
        [owner, oracle1, oracle2, attacker] = await ethers.getSigners();

        const Registry = await ethers.getContractFactory("VenomRegistry");
        registry = await Registry.deploy();

        const Escrow = await ethers.getContractFactory("PilotEscrow");
        escrow = await Escrow.deploy(await registry.getAddress());
        await registry.setPilotEscrow(await escrow.getAddress());
    });

    async function registerOracle(signer, multiaddr = "/ip4/127.0.0.1/tcp/4001") {
        await registry.connect(signer).registerOracle(multiaddr, { value: ethers.parseEther("1.0") });
    }

    describe("Unstake Cooldown", function () {
        it("rejects finalizeUnstake before 7-day cooldown", async function () {
            await registerOracle(oracle1);
            await registry.connect(oracle1).requestUnstake();

            await expect(registry.connect(oracle1).finalizeUnstake())
                .to.be.revertedWith("Cooldown active");
        });

        it("allows finalizeUnstake after 7-day cooldown", async function () {
            await registerOracle(oracle1);
            await registry.connect(oracle1).requestUnstake();

            const balanceBefore = await ethers.provider.getBalance(oracle1.address);

            await time.increase(7 * 24 * 60 * 60 + 1); // 7 days + 1 second

            const tx = await registry.connect(oracle1).finalizeUnstake();
            const rcpt = await tx.wait();
            const gasSpent = rcpt.gasUsed * rcpt.gasPrice;

            const balanceAfter = await ethers.provider.getBalance(oracle1.address);
            expect(balanceAfter - balanceBefore + gasSpent).to.equal(ethers.parseEther("1.0"));
        });

        it("rejects duplicate unstake requests", async function () {
            await registerOracle(oracle1);
            await registry.connect(oracle1).requestUnstake();

            await expect(registry.connect(oracle1).requestUnstake())
                .to.be.revertedWith("Already inactive");
        });

        it("rejects unstake if already inactive", async function () {
            await registerOracle(oracle1);
            await registry.connect(oracle1).requestUnstake();
            await time.increase(7 * 24 * 60 * 60 + 1);
            await registry.connect(oracle1).finalizeUnstake();

            await expect(registry.connect(oracle1).requestUnstake())
                .to.be.revertedWith("Not registered");
        });
    });

    describe("Slash During Unstake", function () {
        async function callReportDeviation(operator, submittedScore, medianScore) {
            const escrowAddress = await escrow.getAddress();
            await ethers.provider.send("hardhat_setBalance", [
                escrowAddress,
                ethers.toBeHex(ethers.parseEther("1.0"))
            ]);
            const escrowSigner = await ethers.getImpersonatedSigner(escrowAddress);
            return registry.connect(escrowSigner).reportDeviation(operator, submittedScore, medianScore);
        }

        it("slashes oracle during unstake cooldown", async function () {
            await registerOracle(oracle1);
            await registry.connect(oracle1).requestUnstake();

            const stakeBefore = (await registry.oracles(oracle1.address)).stake;
            expect(stakeBefore).to.equal(ethers.parseEther("1.0"));

            await callReportDeviation(oracle1.address, 100, 50);

            const stakeAfter = (await registry.oracles(oracle1.address)).stake;
            const slashAmount = (ethers.parseEther("1.0") * 5n) / 100n;
            expect(stakeAfter).to.equal(stakeBefore - slashAmount);

            expect(await registry.everSlashed(oracle1.address)).to.be.true;
        });

        it("slashed oracle cannot re-register after finalizeUnstake", async function () {
            await registerOracle(oracle1);
            await registry.connect(oracle1).requestUnstake();
            await callReportDeviation(oracle1.address, 100, 50);

            await time.increase(7 * 24 * 60 * 60 + 1);
            await registry.connect(oracle1).finalizeUnstake();

            await expect(registry.connect(oracle1).registerOracle("/ip4/127.0.0.1/tcp/4002", { value: ethers.parseEther("1.0") }))
                .to.be.revertedWith("Oracle already exists");
        });

        it("non-slashed oracle can re-register after finalizeUnstake", async function () {
            await registerOracle(oracle1);
            await registry.connect(oracle1).requestUnstake();

            await time.increase(7 * 24 * 60 * 60 + 1);
            await registry.connect(oracle1).finalizeUnstake();

            expect(await registry.hasRegistered(oracle1.address)).to.be.false;

            await registry.connect(oracle1).registerOracle("/ip4/127.0.0.1/tcp/4002", { value: ethers.parseEther("1.0") });
            expect(await registry.hasRegistered(oracle1.address)).to.be.true;
            expect((await registry.oracles(oracle1.address)).active).to.be.true;
        });

        it("skips slashing oracle with zero stake", async function () {
            await expect(callReportDeviation(oracle1.address, 100, 50))
                .to.emit(registry, "SlashSkipped")
                .withArgs(oracle1.address, "No stake to slash");
        });
    });

    describe("PilotEscrow Timelock Upgrade", function () {
        it("sets PilotEscrow immediately on first call", async function () {
            const Registry2 = await ethers.getContractFactory("VenomRegistry");
            const registry2 = await Registry2.deploy();

            const Escrow2 = await ethers.getContractFactory("PilotEscrow");
            const escrow2 = await Escrow2.deploy(await registry2.getAddress());

            expect(await registry2.pilotEscrow()).to.equal(ethers.ZeroAddress);

            await registry2.setPilotEscrow(await escrow2.getAddress());
            expect(await registry2.pilotEscrow()).to.equal(await escrow2.getAddress());
        });

        it("schedules upgrade with 48h timelock on subsequent calls", async function () {
            const Escrow2 = await ethers.getContractFactory("PilotEscrow");
            const escrow2 = await Escrow2.deploy(await registry.getAddress());

            const tx = await registry.setPilotEscrow(await escrow2.getAddress());
            const rcpt = await tx.wait();

            const upgradeEvent = rcpt.logs.find(
                (log) => log.fragment && log.fragment.name === "PilotEscrowUpgradeScheduled"
            );
            expect(upgradeEvent).to.not.be.undefined;

            expect(await registry.pendingPilotEscrow()).to.equal(await escrow2.getAddress());
            expect(await registry.pilotEscrow()).to.not.equal(await escrow2.getAddress());
        });

        it("rejects executePilotEscrowUpgrade before timelock", async function () {
            const Escrow2 = await ethers.getContractFactory("PilotEscrow");
            const escrow2 = await Escrow2.deploy(await registry.getAddress());

            await registry.setPilotEscrow(await escrow2.getAddress());

            await expect(registry.executePilotEscrowUpgrade())
                .to.be.revertedWith("Timelock active");
        });

        it("executes PilotEscrow upgrade after 48h timelock", async function () {
            const Escrow2 = await ethers.getContractFactory("PilotEscrow");
            const escrow2 = await Escrow2.deploy(await registry.getAddress());

            await registry.setPilotEscrow(await escrow2.getAddress());

            await time.increase(48 * 60 * 60 + 1); // 48 hours + 1 second

            await registry.executePilotEscrowUpgrade();
            expect(await registry.pilotEscrow()).to.equal(await escrow2.getAddress());
            expect(await registry.pendingPilotEscrow()).to.equal(ethers.ZeroAddress);
        });

        it("rejects upgrade with no pending upgrade", async function () {
            await expect(registry.executePilotEscrowUpgrade())
                .to.be.revertedWith("No pending upgrade");
        });
    });

    describe("Owner withdrawal timelocks", function () {
        async function callReportDeviation(operator, submittedScore, medianScore) {
            const escrowAddress = await escrow.getAddress();
            await ethers.provider.send("hardhat_setBalance", [
                escrowAddress,
                ethers.toBeHex(ethers.parseEther("1.0"))
            ]);
            const escrowSigner = await ethers.getImpersonatedSigner(escrowAddress);
            return registry.connect(escrowSigner).reportDeviation(operator, submittedScore, medianScore);
        }

        it("requires 48h timelock before withdrawing slashed stake reserve", async function () {
            await registerOracle(oracle1);
            await callReportDeviation(oracle1.address, 100, 50);

            const slashAmount = (ethers.parseEther("1.0") * 5n) / 100n;
            await expect(registry.scheduleSlashedStakeWithdrawal(owner.address, slashAmount))
                .to.emit(registry, "SlashedStakeWithdrawalScheduled");

            await expect(registry.withdrawSlashedStake(owner.address, slashAmount))
                .to.be.revertedWith("Withdrawal timelock active");

            await time.increase(48 * 60 * 60 + 1);

            await expect(registry.withdrawSlashedStake(owner.address, slashAmount))
                .to.emit(registry, "SlashedStakeWithdrawn")
                .withArgs(owner.address, slashAmount);
            expect(await registry.slashedStakeReserve()).to.equal(0n);
        });

        it("requires 48h timelock before withdrawing insurance pool", async function () {
            const uid = ethers.id("INSURANCE_TIMELOCK");
            const bounty = ethers.parseEther("1.0");
            await escrow.fundCampaign(uid, "ipfs://test", ethers.id("test"), { value: bounty });
            await ethers.provider.send("hardhat_mine", ["0x1C20"]);
            await escrow.cancelCampaign(uid);

            const fee = (bounty * 100n) / 10000n;
            expect(await escrow.insurancePool()).to.equal(fee);

            await expect(escrow.scheduleInsuranceWithdrawal(owner.address, fee))
                .to.emit(escrow, "InsuranceWithdrawalScheduled");

            await expect(escrow.withdrawInsurancePool(owner.address, fee))
                .to.be.revertedWith("Withdrawal timelock active");

            await time.increase(48 * 60 * 60 + 1);

            await expect(escrow.withdrawInsurancePool(owner.address, fee))
                .to.emit(escrow, "InsuranceWithdrawalExecuted")
                .withArgs(owner.address, fee);
            expect(await escrow.insurancePool()).to.equal(0n);
        });
    });
});

describe("Runtime Mode Config", function () {
    it("rejects testnet + USE_TEST_PAYLOAD=true", function () {
        const result = validateRuntimeModeConfig({
            [RUNTIME_MODE_ENV]: "testnet",
            [TEST_PAYLOAD_ENV]: "true"
        });
        expect(result.ok).to.be.false;
        expect(result.errors.some(e => e.includes("testnet") && e.includes("USE_TEST_PAYLOAD"))).to.be.true;
    });

    it("rejects mainnet + USE_TEST_PAYLOAD=true", function () {
        const result = validateRuntimeModeConfig({
            [RUNTIME_MODE_ENV]: "mainnet",
            [TEST_PAYLOAD_ENV]: "true"
        });
        expect(result.ok).to.be.false;
    });

    it("accepts testnet + USE_TEST_PAYLOAD=false", function () {
        const result = validateRuntimeModeConfig({
            [RUNTIME_MODE_ENV]: "testnet",
            [TEST_PAYLOAD_ENV]: "false"
        });
        expect(result.ok).to.be.true;
    });

    it("accepts mainnet + USE_TEST_PAYLOAD=false", function () {
        const result = validateRuntimeModeConfig({
            [RUNTIME_MODE_ENV]: "mainnet",
            [TEST_PAYLOAD_ENV]: "false"
        });
        expect(result.ok).to.be.true;
    });

    it("accepts demo + USE_TEST_PAYLOAD=true", function () {
        const result = validateRuntimeModeConfig({
            [RUNTIME_MODE_ENV]: "demo",
            [TEST_PAYLOAD_ENV]: "true"
        });
        expect(result.ok).to.be.true;
    });
});

describe("Multiaddr Validation", function () {
    it("rejects 0.0.0.0 wildcard", function () {
        expect(isPrivateOrWildcardMultiaddr("/ip4/0.0.0.0/tcp/4001/p2p/QmTest")).to.be.true;
    });

    it("rejects loopback 127.0.0.1", function () {
        expect(isPrivateOrWildcardMultiaddr("/ip4/127.0.0.1/tcp/4001/p2p/QmTest")).to.be.true;
    });

    it("rejects 10.x.x.x private range", function () {
        expect(isPrivateOrWildcardMultiaddr("/ip4/10.0.0.1/tcp/4001/p2p/QmTest")).to.be.true;
    });

    it("rejects 172.16-31.x.x private range", function () {
        expect(isPrivateOrWildcardMultiaddr("/ip4/172.16.0.1/tcp/4001/p2p/QmTest")).to.be.true;
        expect(isPrivateOrWildcardMultiaddr("/ip4/172.31.255.255/tcp/4001/p2p/QmTest")).to.be.true;
    });

    it("rejects 192.168.x.x private range", function () {
        expect(isPrivateOrWildcardMultiaddr("/ip4/192.168.1.1/tcp/4001/p2p/QmTest")).to.be.true;
    });

    it("accepts public IP", function () {
        expect(isPrivateOrWildcardMultiaddr("/ip4/203.0.113.1/tcp/4001/p2p/QmTest")).to.be.false;
    });

    it("accepts public IP in 100.x range", function () {
        expect(isPrivateOrWildcardMultiaddr("/ip4/100.64.0.1/tcp/4001/p2p/QmTest")).to.be.false;
    });
});
