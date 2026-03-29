import type { EventMessage, RequestMessage } from '@/core/communication/types';
import { BaseWorker } from '../common/base-worker';
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
import { GasManager } from './core/gas-manager';
import { WalletManager } from './core/wallet-manager';
import { ArbitrageOrchestrator } from './core/arbitrage/arbitrage-orchestrator';
import { FlashArbitrageHandler } from './core/flash-arbitrage-handler';
import { formatGwei } from './core/helpers';

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
  private gasManager!: GasManager;
  private walletManager!: WalletManager;
  private arbitrageOrchestrator!: ArbitrageOrchestrator;
  private flashArbitrageHandler!: FlashArbitrageHandler;

  private displayStatsIntervalId?: NodeJS.Timeout;

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
    // "application-event" routing
    this.eventBus.onApplicationEvent((payload) => {
      this.arbitrageOrchestrator.handleApplicationEvent(payload);
    });

    // "new-block" routing => update GasManager
    this.eventBus.onNewBlock((payload) => {
      this.gasManager.handleNewBlockEvent(payload);
    });

    // "token-registered" routing
    // For each new token: create trading pairs with DISCOVERY tokens and emit "token-pair-registered" events for those pairs
    this.eventBus.onTokenRegistered((token) => {
      this.logger.debug(`✅ Registered token ${token.symbol} (addr: ${token.address}) (trusted: ${token.trusted})`);
      // this.sendEventMessage('token-registered', { token }); // send event to main thread
    });

    // "token-pair-registered" routing
    // Only fired for meaningful pairs (preconfigured + anchor pairs)
    this.eventBus.onTokenPairRegistered((tokenPair) => {
      // NOTE: emited only on discovery not on pool events
      this.logger.info(`Token pair ${tokenPair.key} registered:`);
      this.logger.info(` • ${tokenPair.token0.symbol} (${tokenPair.token0.address})`);
      this.logger.info(` • ${tokenPair.token1.symbol} (${tokenPair.token1.address})`);
    });

    // "pools-upsert-batch" routing
    this.eventBus.onPoolsUpsertBatch((payload) => {
      this.tokenPairManager.handlePoolsUpsertBatch(payload);
      this.arbitrageOrchestrator.handlePoolsUpsertBatch(payload);
      // TODO: notify main thread about pool state update (after processing the event and updating the state)
      // TODO: notify liquidity graph to update
      // this.sendEventMessage('pool-update', { pool });
    });

    // new "arbitrage-opportunity" routing
    this.eventBus.onArbitrageOpportunity(async (opportunity) => {
      opportunity.foundAtBlock = this.blockManager.getCurrentBlockNumber();
      await this.db.upsertArbitrageOpportunity(opportunity);
      this.flashArbitrageHandler.handleNewArbitrageOpportunityEvent(opportunity);
      // this.sendEventMessage('arbitrage-opportunity', { opportunity: payload }); // send event to main thread
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

    this.eventBus = new EventBus(); // create event bus
    this.blockchain = new Blockchain({ chainConfig: this.chainConfig, cache: this.cache }); // create blockchain provider

    // create token manager
    this.tokenManager = new TokenManager({
      chainConfig: this.chainConfig,
      blockchain: this.blockchain,
      eventBus: this.eventBus,
      db: this.db,
    });

    // create price oracle
    this.priceOracle = new PriceOracle({
      chainConfig: this.chainConfig,
      tokenManager: this.tokenManager,
    });

    // create dex registry and register adapters
    this.dexManager = new DexManager({
      chainConfig: this.chainConfig,
      eventBus: this.eventBus,
      blockchain: this.blockchain,
      tokenManager: this.tokenManager,
      priceOracle: this.priceOracle,
      db: this.db,
    });

    // TokenPairManager handles token pair discovery and management based config and pool state updates
    this.tokenPairManager = new TokenPairManager({
      chainConfig: this.chainConfig,
      db: this.db,
      eventBus: this.eventBus,
      tokenManager: this.tokenManager,
      dexManager: this.dexManager,
    });

    // Initialize BlockManager
    this.blockManager = new BlockManager({
      chainConfig: this.chainConfig,
      blockchain: this.blockchain,
      eventBus: this.eventBus,
      dexManager: this.dexManager,
    });

    // Initialize wallet manager
    this.walletManager = new WalletManager({
      chainConfig: this.chainConfig,
      blockchain: this.blockchain,
      tokenManager: this.tokenManager,
      priceOracle: this.priceOracle,
    });

    // Initialize GasManager
    this.gasManager = new GasManager({
      chainConfig: this.chainConfig,
      blockchain: this.blockchain,
      priceOracle: this.priceOracle,
      walletManager: this.walletManager,
    });

    // initialize arbitrage orchestrator
    this.arbitrageOrchestrator = new ArbitrageOrchestrator({
      chainConfig: this.chainConfig,
      eventBus: this.eventBus,
      dexManager: this.dexManager,
      gasManager: this.gasManager,
      tokenManager: this.tokenManager,
      priceOracle: this.priceOracle,
    });

    this.flashArbitrageHandler = new FlashArbitrageHandler({
      chainConfig: this.chainConfig,
      eventBus: this.eventBus,
      db: this.db,
      blockchain: this.blockchain,
      blockManager: this.blockManager,
      dexManager: this.dexManager,
      walletManager: this.walletManager,
    });

    // init
    this.setupEventPipeline();
    await this.tokenManager.init(); // load tokens from DB and trusted tokens from coingecko
    await this.walletManager.initAndValidateWallet();
    await this.flashArbitrageHandler.validateContract();
    await this.flashArbitrageHandler.init(); // initialize flashbots service if enabled

    await this.priceOracle.init(); // fetch initial anchor prices and start periodic updates
    await this.dexManager.init(); // init stored pools cache from DB

    // start listening for block and pool events
    await this.blockManager.init();
    this.blockManager.listenBlockEvents();
    // this.blockManager.listenPoolEvents_depracated();

    // optionally create trading pairs between discovery tokens at startup
    // await this.tokenPairManager.createTokenPairsBetweenDiscoveryTokens(); // issue: pool events may arrive while this its running
    // this.tokenPairManager.displayTokenPairs(); // display discovered token pairs after initialization

    // register and load fresh data for all cached stored pools
    await this.dexManager.registerStoredPools(); // FETCH + EMIT ALL POOLS

    // enable arbitrage orchstrator
    this.eventBus.emitApplicationEvent({ name: 'initialized' });

    // set interval to display stats every minute
    this.displayStats(); // display initial stats immediately after startup
    this.displayStatsIntervalId = setInterval(() => this.displayStats(), 60_000);
  }

  displayStats() {
    this.logger.info('================================ STATS ================================');
    const currentBlock = this.blockManager.getCurrentBlockNumber();
    const baseFeePerGas = this.gasManager.getBaseFeePerGas();
    const { registredTokens, storedTokens } = this.tokenManager.getStats();
    const { resolvedPrices, ethPriceUSD } = this.priceOracle.getStats();
    const tokenPairStats = this.tokenPairManager.getStats();
    const dexManagerStats = this.dexManager.getStats();
    const arbitrageStats = this.arbitrageOrchestrator.getStats();

    this.logger.info(`⛽ GasPrice: ${formatGwei(baseFeePerGas)} ETH price: ${ethPriceUSD?.toFixed(2)}$ (${currentBlock})`);
    this.logger.info(`📊 Resolved priceUSD: ${resolvedPrices} of ${registredTokens} registered tokens (stored: ${storedTokens})`);
    this.logger.info(`🔀 Registered token pairs: ${tokenPairStats.registredTokenPairs}`);
    this.logger.info(`🏦 Registered DEX pools: ${dexManagerStats.registredPools} (stored: ${dexManagerStats.storedPools})`);
    this.logger.info(`⚠️ Pools with errors: ${dexManagerStats.poolsWithErrors}`);
    this.logger.info(`🌐 Graph tokens: ${arbitrageStats.graph.tokenCount} graph edges: ${arbitrageStats.graph.edgeCount}`);
    this.logger.info(`💰 Arbitrage opportunities found: ${arbitrageStats.opportunitiesFound}`);
    this.logger.info(`=======================================================================`);
  }

  async stop() {
    this.logger.info('💾 Saving cache to disk...');
    await this.cache.save(); // do not force save if cache is not dirty
    // await this.dexManager.syncRegisteredPoolsToStorage();

    // clear stats display interval
    if (this.displayStatsIntervalId) clearInterval(this.displayStatsIntervalId);

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
