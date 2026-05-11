'use strict';

const { expect } = require('chai');
const MultiRpcProvider = require('../rpc/router');

function fakeProvider(url, calls, behavior = {}) {
  return {
    async getBlockNumber() {
      calls.push(`getBlockNumber:${url}`);
      if (behavior.fail) throw new Error(behavior.error || 'ECONNRESET');
      return behavior.blockNumber || 12345;
    },
    async getNetwork() {
      calls.push(`getNetwork:${url}`);
      if (behavior.fail) throw new Error(behavior.error || 'ECONNRESET');
      return { chainId: BigInt(behavior.chainId || 84532) };
    },
  };
}

describe('MultiRpcProvider', function () {
  let router;

  afterEach(function () {
    if (router) {
      router.close();
      router = null;
    }
  });

  it('fails over to the next provider after a failed call', async function () {
    const calls = [];
    router = new MultiRpcProvider(['bad-rpc', 'good-rpc'], {
      maxRetries: 2,
      timeout: 50,
      providerFactory: (url) => fakeProvider(url, calls, { fail: url === 'bad-rpc', blockNumber: 777 }),
    });

    expect(await router.getBlockNumber()).to.equal(777);
    expect(calls).to.deep.equal(['getBlockNumber:bad-rpc', 'getBlockNumber:good-rpc']);
  });

  it('routes getProvider proxy calls through the fallback wrapper', async function () {
    const calls = [];
    router = new MultiRpcProvider(['bad-rpc', 'good-rpc'], {
      maxRetries: 2,
      timeout: 50,
      providerFactory: (url) => fakeProvider(url, calls, { fail: url === 'bad-rpc', chainId: 31337 }),
    });

    const provider = router.getProvider();
    const network = await provider.getNetwork();

    expect(network.chainId).to.equal(31337n);
    expect(calls).to.deep.equal(['getNetwork:bad-rpc', 'getNetwork:good-rpc']);
  });
});
