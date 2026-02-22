import type { EventMessage, RequestMessage } from '@/core/communication/types';
import { BaseWorker } from '../common/base-worker';
import { createLogger } from '@/utils';
import { CacheService } from '@/utils/cache-service';
import type { ChainConfig } from '@/config/models';
import { Blockchain } from './core/blockchain';
import { TokenManager } from './core/token-manager';

class EVMWorker extends BaseWorker {
  private config!: ChainConfig;
  private cache!: CacheService;
  private blockchain!: Blockchain;
  private tokenManager!: TokenManager;

  async handleRequest(message: RequestMessage) {
    this.sendResponseMessage({
      correlationId: message.correlationId,
      data: { success: true, timestamp: Date.now() },
    });
  }

  async handleEvent(event: EventMessage) {
    throw new Error(`EVMWorker does not handle events yet. Received event: ${event.name}`);
  }

  async init(config: ChainConfig) {
    this.config = config;
    this.log.info(`Initializing...`);

    // init cache
    this.cache = new CacheService(this.config.chainId);
    await this.cache.load();

    // init blockchain
    this.blockchain = new Blockchain({
      chainId: this.config.chainId,
      chainName: this.config.name,
      providerURL: this.config.providerRpcUrl,
      cache: this.cache,
      logger: createLogger(`[${this.workerId}.blockchain]`),
    });

    // create token manager
    this.tokenManager = new TokenManager({
      logger: createLogger(`[${this.workerId}.token-manager]`),
      blockchain: this.blockchain,
      inputTokens: this.config.tokens,
    });
    const registeredTokens = await this.tokenManager.batchRegisterTokens();
    console.log(`Registered ${registeredTokens.length} tokens at startup for chain ${this.config.name}`);

    this.sendEventMessage('worker-initialized', { timestamp: Date.now() });
  }
}

new EVMWorker();
