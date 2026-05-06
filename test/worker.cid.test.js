const { expect } = require("chai");

const { normalizeCid, isValidCid } = require("../aggregator/worker");

describe("worker CID normalization", function () {
  const rawV0 = "QmYwAPJzv5CZsnAzt8auVZRnriEwYFoTwkyRSyP1CCH5U8";
  const rawV1 = "bafybeigdyrzt5sfp7udm7hu76uh7y26v4tpv3z3c42qjhyvux2z7xidbza";
  const rawCodecV1 = "bafkreigh2akiscaildcvopksxwosqv7ozy2qnp3xm5z5qf4w5n6v5i5i5i";
  const otherV1 = "bafzbeicmqzj4h6jrlemzw5azksqklt5uw6peduct5fcfxhvjzcr63sva5e";

  it("accepts CIDv0 and common CIDv1 base32 prefixes", function () {
    expect(isValidCid(rawV0)).to.equal(true);
    expect(isValidCid(rawV1)).to.equal(true);
    expect(isValidCid(rawCodecV1)).to.equal(true);
    expect(isValidCid(otherV1)).to.equal(true);
  });

  it("extracts CIDs from common IPFS URI forms", function () {
    expect(normalizeCid(`ipfs://${rawV1}`)).to.equal(rawV1);
    expect(normalizeCid(`/ipfs/${rawV1}?filename=payload.json`)).to.equal(rawV1);
    expect(normalizeCid(`https://ipfs.io/ipfs/${rawV1}`)).to.equal(rawV1);
  });

  it("rejects malformed CIDs", function () {
    expect(isValidCid("not-a-cid")).to.equal(false);
    expect(isValidCid("bafy")).to.equal(false);
    expect(isValidCid("")).to.equal(false);
  });
});
