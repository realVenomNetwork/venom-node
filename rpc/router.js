// rpc/router.js
const { ethers } = require('ethers');

const HEALTH_CHECK_INTERVAL = 60000;
const PROVIDER_UNHEALTHY_THRESHOLD = 3;

class MultiRpcProvider {
  constructor(urls = [], options = {}) {
    if (!Array.isArray(urls) || urls.length === 0) {
      throw new Error("MultiRpcProvider requires at least one RPC URL");
    }

    this.urls = urls;
    this.maxRetries = options.maxRetries || 3;
    this.timeout = options.timeout || 15000;
    this.healthCheckInterval = options.healthCheckInterval || HEALTH_CHECK_INTERVAL;

    this.providerStatus = urls.map((url) => ({
      failures: 0,
      lastFailure: 0,
      healthy: true,
      url
    }));

    this.providers = this.urls.map((url, index) => {
      const provider = this._createProvider(url);
      this.providerStatus[index].url = url;
      return provider;
    });

    this.currentIndex = 0;
    this.provider = this.providers[0];

    this._startHealthChecks();

    console.log(`[MultiRPC] Initialized with ${urls.length} providers`);
  }

  _createProvider(url) {
    return new ethers.JsonRpcProvider(url, undefined, {
      polling: true,
      pollingInterval: 4000
    });
  }

  _getNextUrl() {
    for (let i = 1; i < this.urls.length; i++) {
      const nextIndex = (this.currentIndex + i) % this.urls.length;
      if (this.providerStatus[nextIndex].healthy) {
        this.currentIndex = nextIndex;
        this.provider = this.providers[this.currentIndex];
        return this.urls[this.currentIndex];
      }
    }
    this.currentIndex = (this.currentIndex + 1) % this.urls.length;
    this.provider = this.providers[this.currentIndex];
    return this.urls[this.currentIndex];
  }

  async _callWithFallback(method, ...args) {
    let lastError;
    const startTime = Date.now();

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const provider = this.providers[this.currentIndex];

        const result = await Promise.race([
          provider[method](...args),
          new Promise((_, reject) => {
            const id = setTimeout(() => reject(new Error("RPC Timeout")), this.timeout);
            return () => clearTimeout(id);
          })
        ]);

        this.providerStatus[this.currentIndex].failures = 0;
        this.providerStatus[this.currentIndex].healthy = true;

        const latency = Date.now() - startTime;
        if (latency > 5000) {
          console.warn(`[MultiRPC] Slow response from ${this.urls[this.currentIndex]}: ${latency}ms`);
        }

        return result;
      } catch (err) {
        lastError = err;

        this.providerStatus[this.currentIndex].failures++;
        this.providerStatus[this.currentIndex].lastFailure = Date.now();

        if (this.providerStatus[this.currentIndex].failures >= PROVIDER_UNHEALTHY_THRESHOLD) {
          this.providerStatus[this.currentIndex].healthy = false;
          console.warn(`[MultiRPC] Marked ${this.urls[this.currentIndex]} as unhealthy after ${PROVIDER_UNHEALTHY_THRESHOLD} failures`);
        }

        console.warn(`[MultiRPC] Attempt ${attempt + 1} failed on ${this.urls[this.currentIndex]}: ${err.message}`);

        if (err.message.includes("429") || err.message.includes("Timeout") || err.message.includes("limit")) {
          this._getNextUrl();
        }
      }
    }

    throw new Error(`All RPC providers failed after ${this.maxRetries} attempts. Last error: ${lastError.message}`);
  }

  _startHealthChecks() {
    setInterval(() => {
      const now = Date.now();
      for (let i = 0; i < this.providers.length; i++) {
        const status = this.providerStatus[i];
        if (!status.healthy && (now - status.lastFailure) > 60000) {
          this._checkProviderHealth(i);
        }
      }
    }, this.healthCheckInterval);
  }

  async _checkProviderHealth(index) {
    try {
      await Promise.race([
        this.providers[index].getBlockNumber(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Health check timeout")), 5000)
        )
      ]);
      this.providerStatus[index].failures = 0;
      this.providerStatus[index].healthy = true;
      console.log(`[MultiRPC] Provider ${this.urls[index]} recovered`);
    } catch {
      // Still unhealthy
    }
  }

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

  getProvider() {
    return this.provider;
  }

  async call(...args) {
    return this._callWithFallback("call", ...args);
  }
}

module.exports = MultiRpcProvider;
