import type { ChainConfig } from '@/config/models';
import { BaseWorker } from '../common/base-worker';
import type { EventMessage, RequestMessage } from '@/core/communication/types';
import { CacheService } from '@/utils/cache-service';

class EVMWorker extends BaseWorker {
  private config!: ChainConfig;
  private cache!: CacheService;

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

    this.sendEventMessage('worker-initialized', { timestamp: Date.now() });
  }
}

new EVMWorker();
