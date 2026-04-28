import type { ChainConfig } from '@/config/models';
import { createLogger, type Logger } from '@/utils';
import { ethers } from 'ethers';
import { MULTICALL3_ABI, MULTICALL3_ADDRESS } from './chain/abi';
import type { EventBus } from './event-bus';

type BlockchainInput = {
  chainConfig: ChainConfig;
  eventBus: EventBus;
};

export interface Multical3Input {
  target: string;
  allowFailure: boolean;
  callData: string;
}

export interface Multical3Result {
  success: boolean;
  returnData: string;
}

export class Blockchain {
  private readonly logger: Logger;
  private readonly chainConfig: ChainConfig;
  readonly chainId: number;
  provider: ethers.Provider;
  multicall3: ethers.Contract;

  private readonly eventBus: EventBus;
  private readonly contracts: Map<string, ethers.Contract> = new Map();

  // Connection health monitoring
  private lastBlockTime = Date.now();
  private lastBlockNumber = 0;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private readonly HEALTH_CHECK_INTERVAL = 15000; // Check every 15 seconds
  private readonly CONNECTION_TIMEOUT = 30000; // Alert after 30 seconds without blocks

  // rate limiter configuration
  private rateLimiter = {
    queue: [] as Array<() => Promise<any>>,
    processing: false,
    maxConcurrent: 3, // Max 3 parallel requests
    delayBetweenBatches: 200, // 200ms delay between batches
    requestsPerSecond: 20, // Max 20 requests per second
    activeRequests: 0,
    lastRequestTime: Date.now(),
  };

  constructor(input: BlockchainInput) {
    this.logger = createLogger(`[${input.chainConfig.name}.Blockchain]`);
    this.chainConfig = input.chainConfig;
    this.chainId = input.chainConfig.chainId;
    this.eventBus = input.eventBus;

    // init blockchain provider either WS or HTTP
    this.provider = this.initProvider();

    // init multicall3 contract for batch calls
    this.multicall3 = this.initContract(MULTICALL3_ADDRESS, MULTICALL3_ABI);

    // Monitor provider websocket connection
    if (process.env.NODE_ENV === 'production') this.setupConnectionMonitoring();
  }

  /* Init provider */
  initProvider() {
    // init blockchain provider either WS or HTTP
    let provider: ethers.Provider;
    const providerURL = this.chainConfig.providerRpcUrl;
    if (!providerURL) throw new Error(`Provider RPC URL is required for chain ${this.chainConfig.name}`);
    if (providerURL.startsWith('http')) {
      this.logger.info(`🌐 Initializing HTTP provider for ${this.chainConfig.name} (${this.chainId})`);
      provider = new ethers.JsonRpcProvider(providerURL, this.chainId, { staticNetwork: true });
    } else if (providerURL.startsWith('ws')) {
      this.logger.info(`🌐 Initializing WebSocket provider for ${this.chainConfig.name} (${this.chainId})`);
      provider = new ethers.WebSocketProvider(providerURL, this.chainId, { staticNetwork: true });
    } else throw new Error(`Unsupported provider URL: ${providerURL}`);

    // Log low-level WebSocket events
    provider.on('error', (error: Error) => {
      this.logger.error(`❌ WebSocket error`, error);
    });

    return provider;
  }

  async reconnect(): Promise<void> {
    // Rebuild contracts map with new provider
    const entries = Array.from(this.contracts.entries()).map(([, c]) => ({
      address: c.target as string,
      iface: c.interface,
    }));
    this.contracts.clear();

    // destroy old provider and cleanup listeners
    await this.cleanup();

    // New provider
    this.provider = this.initProvider();

    // Re-create all contracts (including multicall3)
    this.logger.info(`🔄 Re-initializing ${entries.length} contracts with new provider`);
    for (const { address, iface } of entries) this.initContract(address, iface);
    this.multicall3 = this.contracts.get(MULTICALL3_ADDRESS.toLowerCase())!;

    // Reset connection state & restart monitoring
    this.lastBlockTime = Date.now();
    if (process.env.NODE_ENV === 'production') this.setupConnectionMonitoring();

    this.logger.info('✅ Provider reconnected');
  }

  /**
   * 💓 SETUP CONNECTION MONITORING
   * Detect dead connections by monitoring block events
   */
  private setupConnectionMonitoring(): void {
    // ✅ Monitor block events as connection health indicator
    this.provider.on('block', (blockNumber: number) => {
      const now = Date.now();
      const timeSinceLastBlock = now - this.lastBlockTime;
      this.lastBlockTime = now;
      this.lastBlockNumber = blockNumber;

      // Log if blocks are delayed
      if (timeSinceLastBlock > 20000) this.logger.warn(`⏱️ Delayed block: ${timeSinceLastBlock}ms since last block`);
      this.logger.debug(`💓 Block ${blockNumber} (${timeSinceLastBlock}ms since last)`);
    });

    // ✅ Periodic health check
    this.healthCheckInterval = setInterval(() => {
      const timeSinceLastBlock = Date.now() - this.lastBlockTime;
      if (timeSinceLastBlock > this.CONNECTION_TIMEOUT) {
        this.logger.error(`💀 Connection dead for ${timeSinceLastBlock / 1000} seconds`);

        // clear interval before emiting connection-lost event
        if (this.healthCheckInterval) {
          clearInterval(this.healthCheckInterval);
          this.healthCheckInterval = null;
        }
        this.eventBus.emitApplicationEvent({ name: 'connection-lost', data: { blockNumber: this.lastBlockNumber } });
      }
    }, this.HEALTH_CHECK_INTERVAL);

    this.logger.info('💓 Connection health monitoring started');
  }

  // Known static methods (never change)
  private static readonly STATIC_METHODS = new Set([
    'name',
    'symbol',
    'decimals',
    'token0',
    'token1',
    'fee',
    'tickSpacing',
    'getPair',
    'getPool',
    'factory',
    'router',
  ]);

  /**
   * INIT CONTRACT: Create and cache contract instance
   */
  initContract(address: string, abi: ethers.InterfaceAbi | ethers.Interface): ethers.Contract {
    const key = address.toLowerCase();
    if (this.contracts.has(key)) return this.contracts.get(key)!;

    // Create base contract
    const contract = new ethers.Contract(address, abi, this.provider);

    // Wrap contract with caching proxy
    const cachedContract = this.createCachedContractProxy(contract);
    this.contracts.set(key, cachedContract);
    return cachedContract;
  }

  /**
   * GET CONTRACT: Return cached contract instance
   */
  getContract(address: string): ethers.Contract | null {
    const key = address.toLowerCase();
    return this.contracts.get(key) ?? null;
  }

  /**
   * 🎭 CREATE CACHED CONTRACT PROXY: Intercept static method calls
   */
  private createCachedContractProxy(contract: ethers.Contract): ethers.Contract {
    return new Proxy(contract, {
      get: (target, prop: string) => {
        const original = target[prop]; // original contract property/method

        // Pass through non-function properties
        if (typeof original !== 'function') {
          return original;
        }

        // For dynamic methods only intercept for caching, rate limiting, etc.
        if (!Blockchain.STATIC_METHODS.has(prop)) {
          // return original; // return reference to original method
          return new Proxy(original, {
            get: (methodTarget, subProp: string) => {
              const subProperty = (methodTarget as any)[subProp];

              if (typeof subProperty !== 'function') {
                return subProperty;
              }

              // ✅ CHECK IF PROPERTY IS CONFIGURABLE
              const descriptor = Object.getOwnPropertyDescriptor(methodTarget, subProp);

              // If property is non-configurable or non-writable, return original
              if (descriptor && (!descriptor.configurable || !descriptor.writable)) {
                // console.log(`[Blockchain] Property ${String(subProp)} is read-only, returning original`);
                return subProperty;
              }

              // ✅ Only wrap configurable properties
              return async (...args: any[]) => {
                // console.log(`[Blockchain] Throttled call: ${prop}.${String(subProp)}(...)`);
                return this.throttledCall(() => subProperty.apply(methodTarget, args));
              };
            },
            apply: async (methodTarget, thisArg, args: any[]) => {
              // ✅ Wrap with throttling
              return this.throttledCall(() => methodTarget.apply(thisArg, args));
            },
          });
        }

        // Return wrapped function
        return async (...args: any[]) => {
          // Call original method (with throttling
          return await this.throttledCall(() => original.apply(target, args)); // Execute original method immediately
        };
      },
    });
  }

  /**
   * 🔍 WRAP DYNAMIC METHOD: Intercept all calls and sub-properties
   */
  private wrapDynamicMethod(methodName: string, originalMethod: any): any {
    return new Proxy(originalMethod, {
      // Intercept property access (staticCall, estimateGas, etc.)
      get: (target, subProp: string) => {
        const subProperty = target[subProp];

        if (typeof subProperty !== 'function') {
          return subProperty;
        }

        // Wrap sub-property function
        return async (...args: any[]) => {
          const callId = `${methodName}.${String(subProp)}`;
          // return this.executeTrackedCall(callId, subProperty, target, args);
        };
      },

      // Intercept direct calls
      apply: async (target, thisArg, args: any[]) => {
        // return this.executeTrackedCall(methodName, target, thisArg, args);
      },
    });
  }

  /**
   * 📞 Direct provider access for non-contract calls
   */
  getProvider() {
    return this.provider;
  }

  getMulticall3Contract() {
    return this.getContract(MULTICALL3_ADDRESS);
  }

  async executeMulticall3(calls: Multical3Input[], chunkSize = 1000) {
    const results: Multical3Result[] = [];

    this.logger.info(`Executing multicall3 with ${calls.length} calls (chunk size: ${chunkSize})`);
    for (let i = 0; i < calls.length; i += chunkSize) {
      const chunk = calls.slice(i, i + chunkSize);
      const chunkResults = await this.multicall3.aggregate3.staticCall(chunk);
      this.logger.info(
        `   Multicall3 chunk ${i / chunkSize + 1}/${Math.ceil(calls.length / chunkSize)} executed with ${chunkResults.length} results`,
      );
      results.push(...chunkResults);
    }

    if (results?.length !== calls.length) throw new Error(`Multicall3 returned ${results?.length}/${calls.length}`);
    return results;
  }

  async getBlockNumber(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  async getBlock(blockNumber: number): Promise<ethers.Block | null> {
    return this.provider.getBlock(blockNumber);
  }

  async getLogs(filter: ethers.Filter): Promise<ethers.Log[]> {
    return this.provider.getLogs(filter);
  }

  async getBalance(address: string): Promise<bigint> {
    return this.provider.getBalance(address);
  }

  on(event: ethers.ProviderEvent, listener: ethers.Listener): this {
    this.provider.on(event, listener);
    return this;
  }

  removeAllListeners(event?: ethers.ProviderEvent): this {
    this.provider.removeAllListeners(event);
    return this;
  }

  // transactions
  async getTransaction(txHash: string) {
    return this.provider.getTransaction(txHash);
  }

  async getTransactionReceipt(txHash: string) {
    return this.provider.getTransactionReceipt(txHash);
  }

  async waitForTransaction(txHash: string, confirmations?: number, timeout?: number) {
    return this.provider.waitForTransaction(txHash, confirmations, timeout);
  }

  /**
   * 🚦 THROTTLED CALL: Execute function with rate limiting
   */
  private async throttledCall<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.rateLimiter.queue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });

      // Start processing if not already running
      if (!this.rateLimiter.processing) {
        this.processQueue();
      }
    });
  }
  /**
   * 📋 PROCESS QUEUE: Process requests with rate limiting
   */
  private async processQueue(): Promise<void> {
    if (this.rateLimiter.processing) return;
    this.rateLimiter.processing = true;

    while (this.rateLimiter.queue.length > 0) {
      // Calculate delay needed to respect rate limit
      const now = Date.now();
      const timeSinceLastRequest = now - this.rateLimiter.lastRequestTime;
      const minDelay = 1000 / this.rateLimiter.requestsPerSecond;

      if (timeSinceLastRequest < minDelay) {
        await new Promise((resolve) => setTimeout(resolve, minDelay - timeSinceLastRequest));
      }

      // Process a batch of concurrent requests
      const batch = this.rateLimiter.queue.splice(0, this.rateLimiter.maxConcurrent);

      // console.log(`[Blockchain] Processing batch of ${batch.length} requests ` + `(${this.rateLimiter.queue.length} remaining in queue)`);

      // Execute batch in parallel
      await Promise.all(batch.map((fn) => fn()));

      this.rateLimiter.lastRequestTime = Date.now();

      // Small delay between batches
      if (this.rateLimiter.queue.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.rateLimiter.delayBetweenBatches));
      }
    }

    this.rateLimiter.processing = false;
  }

  /**
   * 🧹 CLEANUP
   */
  async cleanup(): Promise<void> {
    this.logger.info('Cleaning up Blockchain service...');

    // Stop health monitoring
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Remove all event listeners
    this.provider.removeAllListeners();

    try {
      await this.provider.destroy();
      this.logger.info('✅ Provider destroyed');
    } catch (error) {
      this.logger.warn('⚠️ Error destroying provider', { error });
    }
  }
}
