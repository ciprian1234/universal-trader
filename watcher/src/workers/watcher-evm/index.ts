import type { EventMessage, RequestMessage } from '@/core/communication/types';
import { BaseWorker } from '../common/base-worker';
import { createLogger } from '@/utils';
import { CacheService } from '@/utils/cache-service';
import type { ChainConfig } from '@/config/models';
import { EventBus } from './core/event-bus';
import { Blockchain } from './core/blockchain';
import { TokenManager } from './core/token-manager';
import { PriceOracle } from './core/price-oracle';
import { DexManager } from './core/dex-manager';
import { BlockManager } from './core/block-manager';
import { WorkerDb } from './db';
import { TokenPairManager } from './core/token-pair-manager';

class EVMWorker extends BaseWorker {
  private chainConfig!: ChainConfig;
  private db!: WorkerDb;
  private cache!: CacheService;
  private eventBus!: EventBus;

  private blockchain!: Blockchain;
  private tokenManager!: TokenManager;
  private tokenPairManager!: TokenPairManager;
  private priceOracle!: PriceOracle;
  private dexManager!: DexManager;
  private blockManager!: BlockManager;

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
    // -- 1. "token-registered" ---------------------------------------------
    // For each new token: create trading pairs with DISCOVERY tokens and emit "token-pair-registered" events for those pairs
    this.eventBus.onTokenRegistered((token) => {
      this.logger.info(`✅ Registered token ${token.symbol} (addr: ${token.address})`);
      // this.sendEventMessage('token-registered', { token }); // send event to main thread
    });

    // -- 2. "token-pair-registered" ----------------------------------------
    // Only fired for meaningful pairs (preconfigured + anchor pairs)
    this.eventBus.onTokenPairRegistered((tokenPair) => {
      this.logger.info(`Token pair ${tokenPair.key} registered:`);
      this.logger.info(` • ${tokenPair.token0.symbol} (${tokenPair.token0.address})`);
      this.logger.info(` • ${tokenPair.token1.symbol} (${tokenPair.token1.address})`);
    });

    // -- 3. "pool-state-event" ---------------------------------------------
    this.eventBus.onPoolStateEvent((event) => {
      this.tokenPairManager.handlePoolStateEvent(event); // update token pair stats and trigger discovery if criteria met
      // TODO: notify main thread about pool state update (after processing the event and updating the state)
      // TODO: notify liquidity graph to update
      // this.sendEventMessage('pool-update', { pool });
    });

    // -- 4. "pool-events-batch" ---------------------------------------------
    // send updated pools to main thread
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

      // const updatedStates = data.events
      //   .map((e) => this.poolStatesManager.getPoolState(e.poolId))
      //   .filter(Boolean);

      // this.sendEventMessage('pool-update-batch', {
      //   blockData: data.blockData,
      //   updatedPoolStates: updatedStates,
      //   prices: this.priceOracle.getSnapshotForPools(updatedStates),
      // });
    });
  }

  async init(chainConfig: ChainConfig) {
    this.chainConfig = chainConfig;

    // init cache
    this.cache = new CacheService(this.chainConfig.chainId);
    await this.cache.load();

    // init database
    this.db = new WorkerDb(this.chainConfig.databaseUrl, this.chainConfig.chainId);
    // await this.db.reset(); // for testing only, reset db on startup
    await this.db.createTables();

    // init event bus and setup event pipeline
    this.eventBus = new EventBus({ logger: createLogger(`[${this.chainConfig.name}.event-bus]`) });
    this.setupEventPipeline();

    // init blockchain
    this.blockchain = new Blockchain({
      chainId: this.chainConfig.chainId,
      chainName: this.chainConfig.name,
      providerURL: this.chainConfig.providerRpcUrl,
      cache: this.cache,
      logger: createLogger(`[${this.chainConfig.name}.blockchain]`),
    });

    // create token manager
    this.tokenManager = new TokenManager({
      chainConfig: this.chainConfig,
      blockchain: this.blockchain,
      eventBus: this.eventBus,
      db: this.db,
    });
    await this.tokenManager.init(); // load tokens from DB and trusted tokens from coingecko

    // create price oracle
    this.priceOracle = new PriceOracle({
      chainConfig: this.chainConfig,
      tokenManager: this.tokenManager,
    });
    await this.priceOracle.init(); // fetch initial anchor prices and start periodic updates

    // create dex registry and register adapters
    this.dexManager = new DexManager({
      chainConfig: this.chainConfig,
      eventBus: this.eventBus,
      blockchain: this.blockchain,
      tokenManager: this.tokenManager,
      priceOracle: this.priceOracle,
      db: this.db,
    });
    await this.dexManager.init(); // init contracts for dex venues

    // TokenPairManager handles token pair discovery and management based config and pool state updates
    this.tokenPairManager = new TokenPairManager({
      chainConfig: this.chainConfig,
      db: this.db,
      eventBus: this.eventBus,
      tokenManager: this.tokenManager,
      dexManager: this.dexManager,
    });
    // await this.tokenPairManager.createTokenPairsBetweenDiscoveryTokens();
    this.logger.info('TokenPairManager initialized and discovery token pairs created');
    this.tokenPairManager.displayTokenPairs(); // display discovered token pairs after initialization

    // delay 10 seconds to allow initial token/pool registration before starting block manager
    // await new Promise((resolve) => setTimeout(resolve, 15_000));
    // throw new Error('EVMWorker stopped temp');

    // Initialize BlockManager
    this.blockManager = new BlockManager({
      chainId: this.chainConfig.chainId,
      blockchain: this.blockchain,
      eventBus: this.eventBus,
      dexManager: this.dexManager,
      logger: createLogger(`[${this.chainConfig.name}.block-manager]`),
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
