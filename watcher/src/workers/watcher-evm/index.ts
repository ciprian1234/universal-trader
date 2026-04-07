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
      // this.logger.debug(`🔄 Opportunity updated: ${opportunity.id}, new status: ${opportunity.status}`);
      if (opportunity.status === 'invalid') return;
      else await this.db.upsertArbitrageOpportunity(opportunity);
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
      this.logger.info(`✅ Backfilled block events from ${initBlockNumber + 1} to ${currentBlockNumber}`);
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
    this.logger.info(`💰 (#1) Found initial ${opportunities.length} initial opportunities (without ticks data)`);
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
    this.logger.info(`💰 (#2) Found ${opportunities.length} opportunities after resync (with ticks data)`);

    // 3. if any opportunities found => forward them for execution
    if (opportunities.length > 0) await this.flashArbitrageHandler.handleNewArbitrageOpportunitiesBatch(opportunities);
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
    this.blockManager.cleanup(); // Cleanup BlockManager
    await this.blockchain.cleanup(); // Cleanup Blockchain

    // clear stats display interval
    if (this.displayStatsIntervalId) clearInterval(this.displayStatsIntervalId);

    this.logger.info('💾 Saving cache to disk...');
    await this.cache.save(); // do not force save if cache is not dirty
    await this.dexManager.syncRegisteredPoolsToStorage();

    // await this.flashArbitrageHandler.shutdown();

    // Cleanup GasManager
    // this.gasManager.cleanup();

    // stop db connection
    await this.db.destroy();
    this.logger.info('Worker stopped gracefully');
  }
}

new EVMWorker();
