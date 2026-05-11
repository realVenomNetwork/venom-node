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
    this.healthCheckTimer = null;

    this.providerFactory = options.providerFactory || ((url) => new ethers.JsonRpcProvider(url, undefined, {
      polling: true,
      pollingInterval: 4000
    }));

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
    this.providerProxy = null;

    this._startHealthChecks();

    console.log(`[MultiRPC] Initialized with ${urls.length} providers`);
  }

  async _withTimeout(promise, timeoutMs, message) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  _createProvider(url) {
    return this.providerFactory(url);
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

        const result = await this._withTimeout(
          provider[method](...args),
          this.timeout,
          "RPC Timeout"
        );

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

        if (this.urls.length > 1) {
          this._getNextUrl();
        }
      }
    }

    throw new Error(`All RPC providers failed after ${this.maxRetries} attempts. Last error: ${lastError.message}`);
  }

  _startHealthChecks() {
    this.healthCheckTimer = setInterval(() => {
      const now = Date.now();
      for (let i = 0; i < this.providers.length; i++) {
        const status = this.providerStatus[i];
        if (!status.healthy && (now - status.lastFailure) > 60000) {
          this._checkProviderHealth(i);
        }
      }
    }, this.healthCheckInterval);
    if (typeof this.healthCheckTimer.unref === "function") {
      this.healthCheckTimer.unref();
    }
  }

  async _checkProviderHealth(index) {
    try {
      await this._withTimeout(
        this.providers[index].getBlockNumber(),
        5000,
        "Health check timeout"
      );
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
    if (!this.providerProxy) {
      this.providerProxy = new Proxy({}, {
        get: (_target, prop) => {
          if (prop in this && prop !== 'provider' && typeof this[prop] === 'function') {
            return this[prop].bind(this);
          }
          const value = this.provider[prop];
          if (typeof value === 'function') {
            return (...args) => this._callWithFallback(prop, ...args);
          }
          return value;
        },
        getPrototypeOf: () => Object.getPrototypeOf(this.provider),
        has: (_target, prop) => {
          return prop in this || prop in this.provider;
        }
      });
    }
    return this.providerProxy;
  }

  async call(...args) {
    return this._callWithFallback("call", ...args);
  }

  close() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  destroy() {
    this.close();
  }
}

module.exports = MultiRpcProvider;
