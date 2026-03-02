import type { EventMessage, RequestMessage } from '@/core/communication/types';
import { BaseWorker } from '../common/base-worker';
import { createLogger } from '@/utils';
import { CacheService } from '@/utils/cache-service';
import type { ChainConfig } from '@/config/models';
import { Blockchain } from './core/blockchain';
import { TokenManager } from './core/token-manager';
import { PoolStatesManager } from './core/pool-states-manager';
import { EventBus } from './core/event-bus';
import { DexRegistry } from './core/dex-registry';
import { BlockManager } from './core/block-manager';
import { WorkerDb } from './db';

class EVMWorker extends BaseWorker {
  private config!: ChainConfig;
  private db!: WorkerDb;
  private cache!: CacheService;
  private eventBus!: EventBus;

  private blockchain!: Blockchain;
  private tokenManager!: TokenManager;
  private dexRegistry!: DexRegistry;
  private blockManager!: BlockManager;
  private poolStatesManager!: PoolStatesManager;

  async handleRequest(message: RequestMessage) {
    this.sendResponseMessage({
      correlationId: message.correlationId,
      data: { success: true, timestamp: Date.now() },
    });
  }

  async handleEvent(event: EventMessage) {
    throw new Error(`EVMWorker does not handle events yet. Received event: ${event.name}`);
  }

  setupEventPipeline() {
    // send event to main thread
    this.eventBus.onTokenRegistered((data) => {
      // console.log(`Token ${data.symbol} (${data.address}) registered`);
      // this.sendEventMessage('token-registered', data);
    });

    this.eventBus.onTokenPairRegistered((data) => {
      this.logger.info(`Token pair ${data.key} registered:`);
      this.logger.info(` • ${data.token0.symbol} (${data.token0.address})`);
      this.logger.info(` • ${data.token1.symbol} (${data.token1.address})`);
    });

    this.eventBus.onPoolEventsBatch((data) => {
      try {
        // // events are already applied to poolStates by the time they are emitted => so send the updated pool states
        // const updatedPoolStates = data.events
        //   .map((event) => this.poolStatesManager.getPoolState(event.poolId))
        //   .filter((state) => state !== null);
        // this.sendEventMessage('pool-update-batch', {
        //   blockData: data.blockData,
        //   updatedPoolStates,
        // });
      } catch (error) {
        this.logger.error(`Error in poolEventsBatch handler: ${error instanceof Error ? error.stack : String(error)}`);
      }
    });
  }

  async init(config: ChainConfig) {
    this.config = config;

    // init cache
    this.cache = new CacheService(this.config.chainId);
    await this.cache.load();

    // init database
    this.db = new WorkerDb(this.config.databaseUrl, this.config.chainId);
    // await this.db.reset(); // for testing only, reset db on startup
    await this.db.createTables();

    // init blockchain
    this.blockchain = new Blockchain({
      chainId: this.config.chainId,
      chainName: this.config.name,
      providerURL: this.config.providerRpcUrl,
      cache: this.cache,
      logger: createLogger(`[${this.workerId}.blockchain]`),
    });

    // init event bus and setup event pipeline
    this.eventBus = new EventBus({ logger: createLogger(`[${this.workerId}.event-bus]`) });
    this.setupEventPipeline();

    // create token manager
    this.tokenManager = new TokenManager({
      logger: createLogger(`[${this.workerId}.token-manager]`),
      blockchain: this.blockchain,
      eventBus: this.eventBus,
      db: this.db,
    });
    await this.tokenManager.init(); // load tokens from DB and trusted tokens from coingecho
    await Promise.all(this.config.tokens.map((symbol) => this.tokenManager.ensureTokenRegistered(symbol, 'symbol')));

    // create dex registry and register adapters
    this.dexRegistry = new DexRegistry({
      blockchain: this.blockchain,
      tokenManager: this.tokenManager,
      logger: createLogger(`[${this.workerId}.dex-registry]`),
    });
    this.dexRegistry.init(this.config); // init contracts for dex venues

    // initialize PoolStatesManager
    this.poolStatesManager = new PoolStatesManager({
      chainId: this.config.chainId,
      eventBus: this.eventBus,
      dexRegistry: this.dexRegistry,
      tokenManager: this.tokenManager,
      logger: createLogger(`[${this.workerId}.pool-states-manager]`),
      db: this.db,
    });
    await this.poolStatesManager.init(); // load discovered pools from DB

    this.tokenManager.createTradingPairs(); // emit events with created trading pairs => this triggers pool discovery in PoolStatesManager

    // delay 10 seconds to allow initial token/pool registration before starting block manager
    // await new Promise((resolve) => setTimeout(resolve, 10_000));
    // throw new Error('EVMWorker stopped temp');

    // Initialize BlockManager
    this.blockManager = new BlockManager({
      chainId: this.config.chainId,
      blockchain: this.blockchain,
      eventBus: this.eventBus,
      poolStatesManager: this.poolStatesManager,
      logger: createLogger(`[${this.workerId}.block-manager]`),
    });
    await this.blockManager.init();

    // start listening for block and pool events
    this.blockManager.listenBlockEvents();
    this.blockManager.listenPoolEvents();
  }

  async stop() {
    this.logger.info('💾 Saving cache to disk...');
    await this.cache.save(); // do not force save if cache is not dirty

    // Cleanup Prisma
    // await this.storage.cleanup();

    // await this.flashArbitrageHandler.shutdown();

    // Cleanup all services
    this.eventBus.cleanup();

    // Cleanup BlockManager
    this.blockManager.cleanup();

    // Cleanup GasManager
    // this.gasManager.cleanup();

    // Cleanup Blockchain
    await this.blockchain.cleanup();

    // stop db connection
    await this.db.destroy();
    this.logger.info('Worker stopped gracefully');
  }
}

new EVMWorker();
