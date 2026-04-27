// rpc/router.js
const { ethers } = require('ethers');

class MultiRpcProvider {
  constructor(urls = [], options = {}) {
    if (!Array.isArray(urls) || urls.length === 0) {
      throw new Error("MultiRpcProvider requires at least one RPC URL");
    }

    this.urls = urls;
    this.currentIndex = 0;
    this.maxRetries = options.maxRetries || 3;
    this.timeout = options.timeout || 15000; // 15 seconds

    this.providers = this.urls.map((url) => this._createProvider(url));
    this.provider = this.providers[0];
    
    console.log(`[MultiRPC] Initialized with ${urls.length} providers`);
  }

  _createProvider(url) {
    return new ethers.JsonRpcProvider(url, undefined, {
      polling: true,
      pollingInterval: 4000
    });
  }

  _getNextUrl() {
    this.currentIndex = (this.currentIndex + 1) % this.urls.length;
    this.provider = this.providers[this.currentIndex];
    return this.urls[this.currentIndex];
  }

  async _callWithFallback(method, ...args) {
    let lastError;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const url = this.urls[this.currentIndex];
        const provider = this.providers[this.currentIndex];

        // Add timeout protection
        const result = await Promise.race([
          provider[method](...args),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("RPC Timeout")), this.timeout)
          )
        ]);

        return result;
      } catch (err) {
        lastError = err;
        console.warn(`[MultiRPC] Attempt ${attempt + 1} failed on ${this.urls[this.currentIndex]}: ${err.message}`);

        // Switch to next provider on rate limit or timeout
        if (err.message.includes("429") || err.message.includes("Timeout") || err.message.includes("limit")) {
          this._getNextUrl();
        }
      }
    }

    throw new Error(`All RPC providers failed after ${this.maxRetries} attempts. Last error: ${lastError.message}`);
  }

  // Proxy common provider methods
  async getBlockNumber() {
    return this._callWithFallback("getBlockNumber");
  }

  async getTransactionCount(address, blockTag = "pending") {
    return this._callWithFallback("getTransactionCount", address, blockTag);
  }

  async sendTransaction(signedTx) {
    return this._callWithFallback("sendTransaction", signedTx);
  }

  async waitForTransaction(hash, confirmations = 1) {
    return this._callWithFallback("waitForTransaction", hash, confirmations);
  }

  // Expose the current provider for contract instantiation
  getProvider() {
    return this.provider;
  }

  async call(...args) {
    return this._callWithFallback("call", ...args);
  }
}

module.exports = MultiRpcProvider;
