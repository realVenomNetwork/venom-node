const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  leaderForRound,
  quorumMet,
  isAlreadyClosedError,
  __setActiveOracleCountForTesting
} = require("../aggregator/p2p");

describe("P2P leader election", function () {
  const SIGNERS = [
    `0x${"1".repeat(40)}`,
    `0x${"2".repeat(40)}`,
    `0x${"3".repeat(40)}`,
    `0x${"4".repeat(40)}`,
    `0x${"5".repeat(40)}`
  ];
  const UID = ethers.id("campaign-1");

  describe("leaderForRound", function () {
    it("returns null for an empty signer set", function () {
      expect(leaderForRound(UID, [], 0)).to.equal(null);
      expect(leaderForRound(UID, null, 0)).to.equal(null);
    });

    it("is deterministic and independent of gossip arrival order", function () {
      const forward = leaderForRound(UID, SIGNERS, 0);
      const reversed = leaderForRound(UID, [...SIGNERS].reverse(), 0);
      const shuffled = leaderForRound(UID, [SIGNERS[2], SIGNERS[0], SIGNERS[4], SIGNERS[1], SIGNERS[3]], 0);

      expect(leaderForRound(UID, SIGNERS, 0)).to.equal(forward);
      expect(reversed).to.equal(forward);
      expect(shuffled).to.equal(forward);
    });

    it("normalizes signer case", function () {
      const lower = SIGNERS.map((signer) => signer.toLowerCase());
      const upper = SIGNERS.map((signer) => `0x${signer.slice(2).toUpperCase()}`);
      expect(leaderForRound(UID, lower, 0)).to.equal(leaderForRound(UID, upper, 0));
    });

    it("returns a member of the signer set", function () {
      const leader = leaderForRound(UID, SIGNERS, 0);
      expect(SIGNERS.map((signer) => signer.toLowerCase())).to.include(leader);
    });

    it("rotates by one signer per round and wraps", function () {
      const sorted = [...SIGNERS].map((signer) => signer.toLowerCase()).sort();
      const round0 = leaderForRound(UID, SIGNERS, 0);
      const round1 = leaderForRound(UID, SIGNERS, 1);
      const round2 = leaderForRound(UID, SIGNERS, 2);
      const round0Index = sorted.indexOf(round0);

      expect(sorted.indexOf(round1)).to.equal((round0Index + 1) % sorted.length);
      expect(sorted.indexOf(round2)).to.equal((round0Index + 2) % sorted.length);
      expect(leaderForRound(UID, SIGNERS, sorted.length)).to.equal(round0);
    });

    it("varies across different campaign UIDs", function () {
      const seen = new Set();
      for (let i = 0; i < 50; i++) {
        seen.add(leaderForRound(ethers.id(`campaign-${i}`), SIGNERS, 0));
      }
      expect(seen.size).to.be.greaterThan(1);
    });

    it("with one signer always returns that signer", function () {
      const single = [`0x${"a".repeat(40)}`];
      expect(leaderForRound(UID, single, 0)).to.equal(single[0]);
      expect(leaderForRound(UID, single, 999)).to.equal(single[0]);
    });
  });

  describe("quorumMet", function () {
    function entryWith(scoreSigners, abstainSigners) {
      return {
        signers: scoreSigners,
        abstainSigners
      };
    }

    it("requires the absolute score floor", function () {
      __setActiveOracleCountForTesting(10);
      expect(quorumMet(entryWith(["a", "b", "c", "d"], ["e", "f", "g", "h", "i", "j"]))).to.equal(false);
    });

    it("requires the score quorum percentage", function () {
      __setActiveOracleCountForTesting(20);
      expect(quorumMet(entryWith(["a", "b", "c", "d", "e"], ["f", "g", "h", "i", "j", "k", "l", "m", "n", "o"]))).to.equal(false);
    });

    it("requires the participation floor", function () {
      __setActiveOracleCountForTesting(10);
      expect(quorumMet(entryWith(["a", "b", "c", "d", "e"], ["f"]))).to.equal(false);
    });

    it("passes when all three quorum gates are satisfied", function () {
      __setActiveOracleCountForTesting(10);
      expect(quorumMet(entryWith(["a", "b", "c", "d", "e"], ["f", "g"]))).to.equal(true);
    });

    it("passes with all-score quorum when active count permits", function () {
      __setActiveOracleCountForTesting(7);
      expect(quorumMet(entryWith(["a", "b", "c", "d", "e"], []))).to.equal(true);
    });
  });

  describe("isAlreadyClosedError", function () {
    it("detects already-closed errors across common ethers error fields", function () {
      expect(isAlreadyClosedError({ message: "execution reverted: Campaign already closed" })).to.equal(true);
      expect(isAlreadyClosedError({ reason: "Already closed" })).to.equal(true);
      expect(isAlreadyClosedError({ shortMessage: "execution reverted: Already closed" })).to.equal(true);
      expect(isAlreadyClosedError({ info: { error: { message: "VM Exception: Campaign already closed" } } })).to.equal(true);
      expect(isAlreadyClosedError({ message: "Below participation floor" })).to.equal(false);
    });
  });
});
