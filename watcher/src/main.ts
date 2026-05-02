// ================================================================================================
// UNIVERSAL TRADER — Entry Point
// ================================================================================================
import { appConfig } from './config/index.ts';
import { startApiServer } from './api-server/index..ts';
import { logger } from './utils';
import type { ChainConfig } from './config/models.ts';
import { WorkerDb } from './db';
import { EventBus } from './core/event-bus.ts';
import { Blockchain } from './core/blockchain.ts';
import { TokenManager } from './core/token-manager.ts';
import { PriceOracle } from './core/price-oracle.ts';
import { DexManager } from './core/dex-manager.ts';
import { TokenPairManager } from './core/token-pair-manager.ts';
import { BlockManager } from './core/block-manager.ts';
import { WalletManager } from './core/wallet-manager.ts';
import { GasManager } from './core/gas-manager.ts';
import { ArbitrageOrchestrator } from './core/arbitrage/arbitrage-orchestrator.ts';
import { FlashArbitrageHandler } from './core/flash-arbitrage-handler/index.ts';
import { formatGwei } from './core/helpers';
import type { DexPoolState } from './shared/data-model/layer1.ts';

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

// ================================================================================================
// MAIN APPLICATION CLASS
// ================================================================================================
export class DexArbitrageApp {
  private readonly chainConfig: ChainConfig;
  private readonly db: WorkerDb;
  private readonly eventBus: EventBus;

  private readonly blockchain: Blockchain;
  private readonly tokenManager: TokenManager;
  private readonly tokenPairManager: TokenPairManager;
  private readonly priceOracle: PriceOracle;
  private readonly dexManager: DexManager;
  private readonly blockManager: BlockManager;
  private readonly gasManager: GasManager;
  private readonly walletManager: WalletManager;
  private readonly arbitrageOrchestrator: ArbitrageOrchestrator;
  private readonly flashArbitrageHandler: FlashArbitrageHandler;

  private displayStatsIntervalId?: NodeJS.Timeout;

  constructor() {
    this.chainConfig = appConfig.platforms['ethereum'] as ChainConfig;
    if (!this.chainConfig) throw new Error('Chain configuration for "ethereum" not found in appConfig');
    logger.info(`🌐 Initializing DEX Arbitrage App on chain ${this.chainConfig.name}`);

    // init database
    this.db = new WorkerDb(this.chainConfig.databaseUrl, this.chainConfig.chainId);

    this.eventBus = new EventBus(); // create event bus
    this.blockchain = new Blockchain({ chainConfig: this.chainConfig, eventBus: this.eventBus }); // create blockchain provider

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
    // await this.db.reset(); // for testing only, reset db on startup
    await this.db.createTables();
    const configEntry = await this.db.getConfig();

    // === Start API Server ===
    const { server } = startApiServer(appConfig.apiServerPort, {
      dexManager: this.dexManager,
      tokenManager: this.tokenManager,
    });

    // init
    this.setupEventPipeline();
    await this.tokenManager.init(); // load tokens from DB and trusted tokens from coingecko
    await this.walletManager.initAndValidateWallet();
    await this.flashArbitrageHandler.validateContract();
    await this.flashArbitrageHandler.init(); // initialize flashbots service if enabled

    await this.priceOracle.init(); // fetch initial anchor prices and start periodic updates
    await this.dexManager.init(); // init stored pools cache from DB
    await this.blockManager.init();

    const syncedBlockNumber = configEntry?.value?.syncedBlockNumber || 0;
    const latestBlockNumber = this.blockManager.getCurrentBlockNumber();
    const syncDiff = latestBlockNumber - syncedBlockNumber;
    logger.info(`Last synced block: ${syncedBlockNumber}, current block: ${latestBlockNumber} (diff: ${syncDiff})`);

    // === PHASE 0: Start listening to new blocks immediately (before syncing pools) to avoid missing events during startup ===
    this.blockManager.listenBlockEvents();

    // === PHASE 1: Load and sync all pools
    let pools: DexPoolState[] = [];
    if (syncDiff < 10) {
      pools = await this.dexManager.registerStoredPools(false); // init pools but without full full chain sync
      if (syncDiff > 0)
        await this.blockManager.backfillBlockEvents(syncedBlockNumber + 1, this.blockManager.getCurrentBlockNumber());
    } else {
      logger.warn(`⚠️ Block sync difference is bigger (${syncDiff} blocks) than 10 blocks, performing full sync`);
      pools = await this.dexManager.registerStoredPools(true); // init pools with full chain sync
    }

    // send pools data to TokenPairManager and ArbitrageOrchestrator to update their internal state before starting to listen to new blocks events
    await this.tokenPairManager.handlePoolsUpsertBatch({ pools, block: this.blockManager.getCurrentBlock() });
    await this.arbitrageOrchestrator.handlePoolsUpsertBatch({ pools, block: this.blockManager.getCurrentBlock(), silent: true });

    // === PHASE 2: Full scan with ticks ===
    await this.performFullScanForOpportunities();

    // initialization complete, emit application event
    this.eventBus.emitApplicationEvent({ name: 'initialized' });

    // set interval to display stats every minute
    this.displayStats(); // display initial stats immediately after startup
    this.displayStatsIntervalId = setInterval(() => this.displayStats(), 60_000);

    logger.info('═══════════════════════════════════════════════');
    logger.info('   Universal Trader — Running');
    logger.info(`   Admin API: http://localhost:${appConfig.apiServerPort}`);
    logger.info('═══════════════════════════════════════════════');
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
        await this.reconnect(payload.data.blockNumber);
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

  private async reconnect(fromBlock: number): Promise<void> {
    const MAX_RETRIES = 5;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        logger.info(`🔄 Reconnect attempt ${attempt}/${MAX_RETRIES} from block ${fromBlock}`);
        this.blockManager.cleanup(); // clear timers/buffer
        await this.blockchain.reconnect(); // new WS provider + rebuilt contracts
        await this.blockManager.init(); // set currentBlock to latest block from new provider

        // Backfill the gap
        const currentBlock = this.blockManager.getCurrentBlockNumber();
        logger.info(`Connection lost at ${fromBlock}, current block: ${currentBlock}`);
        if (currentBlock > fromBlock) {
          logger.info(`⏳ Backfilling ${currentBlock - fromBlock} blocks...`);
          await this.blockManager.backfillBlockEvents(fromBlock + 1, currentBlock);
        }

        // re-register 'block' listener on new provider
        this.blockManager.listenBlockEvents();

        logger.info('✅ Reconnected successfully, resuming real-time processing');
        return; // exit the retry loop on success
      } catch (error) {
        logger.error(`❌ Reconnect attempt ${attempt} failed:`, { error });
        if (attempt === MAX_RETRIES) {
          await this.stop();
          process.exit(2);
        }
        await new Promise((r) => setTimeout(r, 5000 * attempt)); // exponential backoff
      }
    }
  }

  async stop(): Promise<void> {
    try {
      logger.info('🛑 Stopping DEX Arbitrage Application...');
      this.db.setConfig({ syncedBlockNumber: this.blockManager.getCurrentBlockNumber() }); // persist latest block number to DB for resuming later
      this.blockManager.cleanup(); // Cleanup BlockManager
      await this.blockchain.cleanup(); // Cleanup Blockchain

      // clear stats display interval
      if (this.displayStatsIntervalId) clearInterval(this.displayStatsIntervalId);

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

// Catch unhandled rejections from ethers.js WebSocket internals (TimeoutError on dead connections)
// These escape try/catch because ethers schedules them as micro-tasks after provider.destroy()
// NOTE: Winston's rejectionHandlers was removed to prevent it from calling process.exit(1) before this handler.
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  // Suppress known benign errors from dead WebSocket teardown
  if (message.includes('timed out') || message.includes('connection closed') || message.includes('WebSocket was closed')) {
    logger.warn(`⚠️ Suppressed unhandled rejection (provider teardown): ${message}`);
    return;
  }
  logger.error('Uncaught rejection:', { error: reason });
  process.exit(2);
});

process.on('uncaughtException', (error: Error) => {
  logger.error(`Uncaught exception: `, { error });
  process.exit(3);
});

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
