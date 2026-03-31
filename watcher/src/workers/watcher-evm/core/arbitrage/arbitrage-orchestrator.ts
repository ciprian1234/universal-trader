import { createLogger } from '@/utils';
import type { ArbitrageOpportunity } from '../interfaces';
import type { ArbitragePath, IPathFinder } from './interfaces';
import { EventBus, type ApplicationEvent, type PoolsUpsertBatchPayload } from '../event-bus';
import { LiquidityGraph } from './liquidity-graph';
import { PathFinder } from './path-finder';
import { PathEvaluator } from './path-evaluator';
import { formatUnits } from 'ethers';
import { TokenManager } from '../token-manager';
import { GasManager } from '../gas-manager';
import { DexManager } from '../dex-manager';
import { BellmanFordPathFinder } from './bellman-ford-path-finder';
import type { ChainConfig } from '@/config/models';
import type { PriceOracle } from '../price-oracle';
import type { DexPoolState } from '@/shared/data-model/layer1';
import { deltaMs } from '../helpers';
import type { BlockEntry } from '../block-manager';

// ============================================
// CONFIGURATION
// ============================================

export interface ArbitrageOrchestratorInput {
  chainConfig: ChainConfig;
  eventBus: EventBus;
  dexManager: DexManager;
  gasManager: GasManager;
  tokenManager: TokenManager;
  priceOracle: PriceOracle;
}

export interface ArbitrageStatistics {
  opportunitiesFound: number;
}

// ============================================
// ARBITRAGE SERVICE (Multi-Hop)
// ============================================

export class ArbitrageOrchestrator {
  private readonly logger;
  private enabled = false;

  // Core dependencies
  private readonly chainConfig: ChainConfig;
  private readonly eventBus: EventBus;
  private readonly dexManager: DexManager;
  private readonly gasManager: GasManager;
  private readonly tokenManager: TokenManager;
  private readonly priceOracle: PriceOracle;

  // Sub-services
  private readonly graph: LiquidityGraph;
  private readonly pathFinder: IPathFinder;
  private readonly pathEvaluator: PathEvaluator;

  // Statistics
  private stats: ArbitrageStatistics = {
    opportunitiesFound: 0,
  };

  constructor(input: ArbitrageOrchestratorInput) {
    this.logger = createLogger(`[${input.chainConfig.name}.Orchestrator]`);
    this.chainConfig = input.chainConfig;
    this.eventBus = input.eventBus;
    this.gasManager = input.gasManager;
    this.dexManager = input.dexManager;
    this.tokenManager = input.tokenManager;
    this.priceOracle = input.priceOracle;

    this.graph = new LiquidityGraph({
      logger: createLogger(`[${input.chainConfig.name}.LiquidityGraph]`),
      dexManager: this.dexManager,
      config: {
        minLiquidityUSD: input.chainConfig.arbitrage.minLiquidityUSD,
        wrappedNativeTokenAddress: input.chainConfig.wrappedNativeTokenAddress,
      },
    });

    // Initialize path finder (PathFinder or BellmanFordPathFinder)
    this.pathFinder = new PathFinder({
      logger: createLogger(`[${input.chainConfig.name}.PathFinder]`),
      graph: this.graph,
      tokenManager: this.tokenManager,
      config: {
        profitThreshold: 1.001, // 0.1% profit threshold (TODO: review this)
        maxHops: input.chainConfig.arbitrage.maxHops,
        maxPathsPerToken: 10000,
        preferredBorrowTokens: this.chainConfig.priceAnchorTokens, // WE CONSIDER DISCOVERY TOKENS AS PREFFERRED BORROW TOKENS
      },
    });

    // Initialize evaluator
    this.pathEvaluator = new PathEvaluator({
      logger: createLogger(`[${input.chainConfig.name}.PathEvaluator]`),
      dexManager: this.dexManager,
      priceOracle: this.priceOracle,
      gasManager: this.gasManager,
      config: {
        minGrossProfitUSD: this.chainConfig.arbitrage.minGrossProfitUSD,
        maxTotalSlippage: 100,
      },
    });
  }

  // ============================================
  // EVENT HANDLING
  // ============================================

  handleApplicationEvent(event: ApplicationEvent) {
    if (event.name === 'initialized') {
      // this.graph.buildGraph();
      this.enabled = true;
      this.logger.info('✅ ArbitrageOrchestrator is enabled and ready');
    }

    if (event.name === 'reorg-detected') {
      this.logger.warn(`⚠️ Reorg detected at block ${event.data.blockNumber}, disabling`);
      this.enabled = false;
    }

    if (event.name === 'reorg-recovered') {
      const updatedPools = this.getUpdatedPools(event.data.affectedPoolIds);
      this.graph.updatePools(updatedPools);
      this.enabled = true;
      this.logger.info('✅ Graph updated with affected pools after reorg recovery');
      // TODO: consider trigger full scan for opportunity paths
    }
  }

  async handlePoolsUpsertBatch(payload: PoolsUpsertBatchPayload): Promise<void> {
    const blockTime = payload.block.receivedTimestamp;
    try {
      this.logger.info(`⏳ Applying ${payload.pools.length} batched events (${payload.block.number}) ${deltaMs(blockTime)}`);
      const startTokens = this.graph.updatePools(payload.pools);

      if (!this.enabled) return this.logger.warn('⚠️ Service not enabled yet, skipping opportunity search');
      const opportunities = await this.findOpportunities(startTokens, payload.block);
      if (opportunities.length > 0) await this.eventBus.emitNewArbitrageOpportunitiesBatch(opportunities);
    } catch (error) {
      this.logger.error('❌ Error processing pool events:', { error });
    } finally {
      this.logger.info(`⏱️ Total execution time (${payload.block.number}) ${deltaMs(blockTime)}`);
    }
  }

  async findOpportunities(startTokens: Set<string>, blockEntry: BlockEntry): Promise<ArbitrageOpportunity[]> {
    const blockStr = `(${blockEntry.number})`;
    const blockTime = blockEntry.receivedTimestamp;

    // 3. Discover candidate paths
    const candidatePaths = this.pathFinder.findCycles(startTokens);
    this.logger.info(`🔍 Found ${candidatePaths.length} candidate paths ${blockStr} ${deltaMs(blockTime)}`);

    if (candidatePaths.length === 0) return [];

    // 4. Evaluate paths concurrently (batched)
    const opportunities = await this.evaluatePathsConcurrently(candidatePaths, 30);

    if (opportunities.length === 0) return [];
    this.logger.info(`✅ Found ${opportunities.length} opportunities ${blockStr} ${deltaMs(blockTime)}`);

    this.stats.opportunitiesFound++;

    // 5. handle new opportunities
    return opportunities;
  }

  private getUpdatedPools(poolIds: Set<string>) {
    const pools: DexPoolState[] = [];
    for (const id of poolIds) {
      const pool = this.dexManager.getPoolState(id);
      if (pool) pools.push(pool);
    }

    return pools;
  }

  private async evaluatePathsConcurrently(paths: ArbitragePath[], batchSize: number): Promise<ArbitrageOpportunity[]> {
    const results: ArbitrageOpportunity[] = [];

    for (let i = 0; i < paths.length; i += batchSize) {
      const batch = paths.slice(i, i + batchSize);
      const evaluated = await Promise.all(batch.map((p) => this.pathEvaluator.evaluate(p)));

      for (const result of evaluated) {
        if (result) results.push(result);
      }
    }

    return results;
  }

  getStats() {
    return {
      opportunitiesFound: this.stats.opportunitiesFound,
      graph: this.graph.getStats(),
    };
  }
}
