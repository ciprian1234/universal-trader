// ================================================================================================
// UNIVERSAL TRADER — Entry Point
// ================================================================================================
import { appConfig } from './config/index.ts';
import { WorkerManager } from './core/communication/worker-manager.ts';
import { startApiServer } from './api-server/index..ts';
import { logger } from './utils';
import type { ChainConfig } from './config/models.ts';

// ================================================================================================
// MAIN ENTRY POINT
// ================================================================================================
main().catch((error) => {
  logger.error('Fatal error:', { error });
  process.exit(1);
});

async function main() {
  const app = new DexArbitrageApp();
  try {
    // Start the application
    await app.start();

    let isShuttingDown = false;
    const shutdown = async () => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      logger.info('🛑 Shutting down application...');
      await app.stop();
      logger.info('👋 Goodbye!');
      process.exit(0);
    };
    // Graceful shutdown on SIGINT and SIGTERM
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    logger.error('❌ Application failed to start:', { error });
    await app.stop();
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error('Fatal error:', { error });
  process.exit(1);
});

// ================================================================================================
// MAIN APPLICATION CLASS
// ================================================================================================
export class DexArbitrageApp {
  private readonly chainConfig!: ChainConfig;
  private readonly db!: WorkerDb;
  private readonly cache!: CacheService;
  private readonly eventBus!: EventBus;

  private readonly blockchain!: Blockchain;
  private readonly tokenManager!: TokenManager;
  private readonly tokenPairManager!: TokenPairManager;
  private readonly priceOracle!: PriceOracle;
  private readonly dexManager!: DexManager;
  private readonly blockManager!: BlockManager;
  private readonly gasManager!: GasManager;
  private readonly walletManager!: WalletManager;
  private readonly arbitrageOrchestrator!: ArbitrageOrchestrator;
  private readonly flashArbitrageHandler!: FlashArbitrageHandler;

  private displayStatsIntervalId?: NodeJS.Timeout;

  constructor() {
    logger.info(`🌐 Initializing DEX Arbitrage App on chain ${chainId}`);
    this.chainConfig = chainConfig;

    // init cache
    this.cache = new CacheService(this.chainConfig.chainId);

    // init database
    this.db = new WorkerDb(this.chainConfig.databaseUrl, this.chainConfig.chainId);

    this.eventBus = new EventBus(); // create event bus
    this.blockchain = new Blockchain({ chainConfig: this.chainConfig, cache: this.cache, eventBus: this.eventBus }); // create blockchain provider

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
      eventBus: this.eventBus,
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
      blockchain: this.blockchain,
      blockManager: this.blockManager,
      dexManager: this.dexManager,
      walletManager: this.walletManager,
      priceOracle: this.priceOracle,
      arbitrageOrchestrator: this.arbitrageOrchestrator,
    });

    logger.info('✅ All services initialized\n');
  }

  // ================================================================================================
  // 🚀 MAIN APPLICATION FLOW
  // ================================================================================================
  async start(): Promise<void> {
    await this.cache.load();

    // await this.db.reset(); // for testing only, reset db on startup
    await this.db.createTables();

    // init
    this.setupEventPipeline();
    await this.tokenManager.init(); // load tokens from DB and trusted tokens from coingecko
    await this.walletManager.initAndValidateWallet();
    await this.flashArbitrageHandler.validateContract();
    await this.flashArbitrageHandler.init(); // initialize flashbots service if enabled

    await this.priceOracle.init(); // fetch initial anchor prices and start periodic updates
    await this.dexManager.init(); // init stored pools cache from DB
    await this.blockManager.init();

    // this.blockManager.listenPoolEvents_depracated();

    // optionally create trading pairs between discovery tokens at startup
    // await this.tokenPairManager.createTokenPairsBetweenDiscoveryTokens(); // issue: pool events may arrive while this its running
    // this.tokenPairManager.displayTokenPairs(); // display discovered token pairs after initialization

    // === PHASE 1: Load and sync all pools (no real-time events yet) ===
    const initBlockNumber = this.blockManager.getCurrentBlockNumber();
    const pools = await this.dexManager.registerStoredPools(); // init and update all cached pools
    await this.tokenPairManager.handlePoolsUpsertBatch({ pools, block: this.blockManager.getCurrentBlock() });
    await this.arbitrageOrchestrator.handlePoolsUpsertBatch({ pools, block: this.blockManager.getCurrentBlock() });

    // === PHASE 2: Full scan with ticks ===
    await this.performFullScanForOpportunities();

    // === PHASE 3: Fill missed events during init and full scan ===
    const currentBlockNumber = await this.blockchain.getBlockNumber();
    if (currentBlockNumber > initBlockNumber) {
      await this.blockManager.backfillBlockEvents(initBlockNumber + 1, currentBlockNumber);
      logger.info(`✅ Backfilled block events from ${initBlockNumber + 1} to ${currentBlockNumber}`);
    }

    // === PHASE 4: Enable real-time event processing ===
    this.eventBus.emitApplicationEvent({ name: 'initialized' });
    this.blockManager.listenBlockEvents(); // ← NOW start listening

    // set interval to display stats every minute
    this.displayStats(); // display initial stats immediately after startup
    this.displayStatsIntervalId = setInterval(() => this.displayStats(), 60_000);
  }

  async performFullScanForOpportunities() {
    // # 1. find initial opportunities based on current pools data (without ticks data)
    const currentBlock = this.blockManager.getCurrentBlock();
    const startTokenAddresses = new Set(this.tokenManager.anchorTokens.map((token) => token.address));
    let opportunities = await this.arbitrageOrchestrator.findOpportunities(startTokenAddresses, currentBlock);
    logger.info(`💰 (#1) Found initial ${opportunities.length} initial opportunities (without ticks data)`);
    if (opportunities.length === 0) return;

    // go through all found opportunities and extract pool ids
    const poolIds = new Set<string>();
    opportunities.forEach((o) => o.steps.forEach((s) => poolIds.add(s.pool.id)));

    // re-sync all involved pools from found opportunities with fresh data including ticks
    const updatedPools = await this.dexManager.updatePoolsByIds(poolIds, 4); // update pools with ticks data
    await this.tokenPairManager.handlePoolsUpsertBatch({ pools: updatedPools, block: currentBlock });
    await this.arbitrageOrchestrator.handlePoolsUpsertBatch({ pools: updatedPools, block: currentBlock });
    // ==============================================================================

    // # 2. find again opportunities after updating pools with ticks data
    opportunities = await this.arbitrageOrchestrator.findOpportunities(startTokenAddresses, currentBlock); // find initial opportunities based on cached pools
    logger.info(`💰 (#2) Found ${opportunities.length} opportunities after resync (with ticks data)`);

    // 3. if any opportunities found => forward them for execution
    if (opportunities.length > 0) await this.flashArbitrageHandler.handleNewArbitrageOpportunitiesBatch(opportunities);
  }

  setupEventPipeline() {
    // "application-event" routing
    this.eventBus.onApplicationEvent(async (payload) => {
      if (payload.name === 'connection-lost') {
        const msg = `Connection lost at block ${payload.data.blockNumber}`;
        logger.error(`${msg} - stopping worker gracefully before exit...`);
        await this.stop();
        process.exit(2); // exit with error code after stopping the application
      } else {
        this.arbitrageOrchestrator.handleApplicationEvent(payload);
      }
    });

    // "new-block" routing => update GasManager
    this.eventBus.onNewBlock((payload) => this.gasManager.handleNewBlockEvent(payload));

    // "token-registered" routing
    // For each new token: create trading pairs with DISCOVERY tokens and emit "token-pair-registered" events for those pairs
    this.eventBus.onTokenRegistered((token) => {
      logger.debug(`✅ Registered token ${token.symbol} (addr: ${token.address}) (trusted: ${token.trusted})`);
      // this.sendEventMessage('token-registered', { token }); // send event to main thread
    });

    // "token-pair-registered" routing
    // Only fired for meaningful pairs (preconfigured + anchor pairs)
    this.eventBus.onTokenPairRegistered((tokenPair) => {
      // NOTE: emited only on discovery not on pool events
      logger.info(`Token pair ${tokenPair.key} registered:`);
      logger.info(` • ${tokenPair.token0.symbol} (${tokenPair.token0.address})`);
      logger.info(` • ${tokenPair.token1.symbol} (${tokenPair.token1.address})`);
    });

    // "native-token-price-updated" routing
    this.eventBus.onNativeTokenPriceUpdated((price) => {
      this.gasManager.setNativeTokenPriceUSD(price); // update native token price in GasManager
    });

    // "pools-upsert-batch" routing
    this.eventBus.onPoolsUpsertBatch(async (payload) => {
      await this.arbitrageOrchestrator.handlePoolsUpsertBatch(payload);
      await this.tokenPairManager.handlePoolsUpsertBatch(payload);
      // TODO: notify main thread about pool state update (after processing the event and updating the state)
      // TODO: notify liquidity graph to update
      // this.sendEventMessage('pool-update', { pool });
    });

    this.eventBus.onNewArbitrageOpportunitiesBatch(async (opportunities) => {
      await this.flashArbitrageHandler.handleNewArbitrageOpportunitiesBatch(opportunities);
    });

    // new "arbitrage-opportunity" routing
    this.eventBus.onArbitrageOpportunityEvent(async (opportunity) => {
      // logger.debug(`🔄 Opportunity updated: ${opportunity.id}, new status: ${opportunity.status}`);
      if (opportunity.status === 'invalid') return;
      else await this.db.upsertArbitrageOpportunity(opportunity);
      // this.sendEventMessage('arbitrage-opportunity', { opportunity: payload }); // send event to main thread
    });
  }

  async stop(): Promise<void> {
    try {
      logger.info('🛑 Stopping DEX Arbitrage Application...');
      this.blockManager.cleanup(); // Cleanup BlockManager
      await this.blockchain.cleanup(); // Cleanup Blockchain

      // clear stats display interval
      if (this.displayStatsIntervalId) clearInterval(this.displayStatsIntervalId);

      logger.info('💾 Saving cache to disk...');
      await this.cache.save(); // do not force save if cache is not dirty
      await this.dexManager.syncRegisteredPoolsToStorage();

      // await this.flashArbitrageHandler.shutdown();

      // Cleanup GasManager
      // this.gasManager.cleanup();

      // stop db connection
      await this.db.destroy();
      logger.info('✅ Application stopped gracefully');
    } catch (error) {
      logger.error('❌ Error stopping application:', { error });
    }
  }

  // ================================================================================================
  // MONITORING AND ANALYTICS
  // ================================================================================================
  displayStats() {
    logger.info('================================ STATS ================================');
    const currentBlock = this.blockManager.getCurrentBlockNumber();
    const baseFeePerGas = this.gasManager.getBaseFeePerGas();
    const { registredTokens, storedTokens } = this.tokenManager.getStats();
    const { resolvedPrices, ethPriceUSD } = this.priceOracle.getStats();
    const tokenPairStats = this.tokenPairManager.getStats();
    const dexManagerStats = this.dexManager.getStats();
    const arbitrageStats = this.arbitrageOrchestrator.getStats();

    logger.info(`⛽ GasPrice: ${formatGwei(baseFeePerGas)} ETH price: ${ethPriceUSD?.toFixed(2)}$ (${currentBlock})`);
    logger.info(`📊 Resolved priceUSD: ${resolvedPrices} of ${registredTokens} registered tokens (stored: ${storedTokens})`);
    logger.info(`🔀 Registered token pairs: ${tokenPairStats.registredTokenPairs}`);
    logger.info(`🏦 Registered DEX pools: ${dexManagerStats.registredPools} (stored: ${dexManagerStats.storedPools})`);
    logger.info(`⚠️ Pools with errors: ${dexManagerStats.poolsWithErrors}`);
    logger.info(`🌐 Graph tokens: ${arbitrageStats.graph.tokenCount} graph edges: ${arbitrageStats.graph.edgeCount}`);
    logger.info(`💰 Arbitrage opportunities found: ${arbitrageStats.opportunitiesFound}`);
    logger.info(`=======================================================================`);
  }
}

// async function main(): Promise<void> {
//   // const workerManager = new WorkerManager({ eventBus });

//   // === 3. Start API Server ===
//   const { server } = startApiServer(appConfig.apiServerPort, {
//     store,
//     workerManager,
//     // crossChainDetector,
//   });

//   // go through each enabled platform and spawn corresponding workers
//   for (const [_, platformConfig] of Object.entries(appConfig.platforms)) {
//     if (!platformConfig.enabled) continue;
//     workerManager.spawnWorker(platformConfig.name, path.resolve(__dirname, './workers/watcher-evm/index.ts'));
//     await workerManager.sendRequest(platformConfig.name, 'init', platformConfig);
//     logger.info(`✅ Worker "${platformConfig.name}" (${platformConfig.name}) initialized`);
//   }

//   // log.info('═══════════════════════════════════════════════');
//   // log.info('   Universal Trader — Running');
//   // log.info(`   Admin API: http://localhost:${appConfig.apiServerPort}`);
//   // log.info(`   Chains: ${appConfig.enabledPlatforms.join(', ')}`);
//   // log.info(`   Pools: ${store.size}`);
//   // log.info('═══════════════════════════════════════════════');
// }

// main().catch((err) => {
//   logger.error('Fatal error:', err);
//   process.exit(1);
// });
