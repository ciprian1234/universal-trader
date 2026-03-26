import { createLogger } from '@/utils';
import type { ArbitrageOpportunity } from '../interfaces';
import type { ArbitragePath, IPathFinder } from './interfaces';
import { EventBus, type ApplicationEventPayload, type PoolsBatchEventPayload } from '../event-bus';
import { LiquidityGraph } from './liquidity-graph';
import { PathFinder } from './path-finder';
import { PathEvaluator } from './path-evaluator';
import { formatUnits } from 'ethers';
import { TokenManager } from '../token-manager';
import { GasManager } from '../gas-manager';
import { DexManager } from '../dex-manager';
import { BellmanFordPathFinder } from './bellman-ford-path-finder';
import type { WorkerDb } from '../../db';
import type { ChainConfig } from '@/config/models';
import type { PriceOracle } from '../price-oracle';
import type { DexPoolState } from '@/shared/data-model/layer1';
import { deltaMs } from '../helpers';

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
        profitThreshold: 1.0001, // 0.01% profit threshold
        maxHops: input.chainConfig.arbitrage.maxHops,
        maxPathsPerToken: 10000,
        preferredBorrowTokens: this.chainConfig.discoveryTokens, // WE CONSIDER DISCOVERY TOKENS AS PREFFERRED BORROW TOKENS
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

  handleApplicationEvent(event: ApplicationEventPayload) {
    if (event.name === 'pool-states-updated') {
      this.logger.info('✅ Pools updated, building graph and enabling service');
      this.graph.buildGraph();
      this.enabled = true;
    }

    if (event.name === 'reorg-detected') {
      this.logger.warn(`⚠️  Reorg detected at block ${event.data?.blockNumber}, disabling`);
      this.enabled = false;
    }
  }

  async handlePoolsBatchEvent(payload: PoolsBatchEventPayload): Promise<void> {
    const blockStr = `(${payload.blockData.number})`;
    const blockTime = payload.blockData.receivedTimestamp;
    this.logger.info(`⏳ Applying ${payload.poolIds.size} batched events ${blockStr} (+${deltaMs(blockTime)}ms)`);
    if (!this.enabled) return this.logger.warn('⚠️  Service not enabled yet');

    try {
      // 1. Extract updated pools
      const updatedPools = this.getUpdatedPools(payload.poolIds);
      if (updatedPools.length === 0) return;

      this.logger.debug(`📊 ${updatedPools.length} pools updated`);

      // 2. Update graph incrementally
      const affectedTokens = this.graph.updatePools(updatedPools);

      // 3. Discover candidate paths
      const candidatePaths = this.pathFinder.findCycles(affectedTokens);
      this.logger.info(`🔍 Found ${candidatePaths.length} candidate paths ${blockStr} (+${deltaMs(blockTime)}ms)`);

      if (candidatePaths.length === 0) return;

      // 4. Evaluate paths concurrently (batched)
      const evaluatedPaths = await this.evaluatePathsConcurrently(candidatePaths, 30);

      if (evaluatedPaths.length === 0) return;
      this.logger.info(`✅ Found ${evaluatedPaths.length} profitable paths ${blockStr} (+${deltaMs(blockTime)}ms)`);

      // 5. Select non-overlapping paths
      const selectedPaths = this.selectBestPaths(evaluatedPaths);

      // 6. Emit opportunities
      for (const path of selectedPaths) {
        this.stats.opportunitiesFound++;
        this.displayPath(path);
        this.eventBus.emitArbitrageOpportunity(path);
      }
    } catch (error) {
      this.logger.error('❌ Error processing pool events:', { error });
    } finally {
      const duration = Date.now() - blockTime;
      // this.updateExecutionTimeStats(duration);
      this.logger.info(`⏱️ Total execution time ${blockStr} ${deltaMs(blockTime)}`);
    }
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

  private selectBestPaths(paths: ArbitrageOpportunity[]): ArbitrageOpportunity[] {
    // Sort by gross profit descending
    const sorted = [...paths].sort((a, b) => b.grossProfitUSD - a.grossProfitUSD);

    // log path id => gros profit
    sorted.forEach((p) => this.logger.info(`PATH "${p.id}" => GrossProfitUSD $${p.grossProfitUSD.toFixed(2)}`));

    const usedPools = new Set<string>();
    const selected: ArbitrageOpportunity[] = [];

    for (const path of sorted) {
      const poolKeys = path.steps.map((s) => s.pool.id);

      const hasOverlap = poolKeys.some((k) => usedPools.has(k));

      if (!hasOverlap) {
        selected.push(path);
        poolKeys.forEach((k) => usedPools.add(k));
      }
    }

    return selected;
  }

  // ============================================
  // DISPLAY & STATS
  // ============================================

  private displayPath(path: ArbitrageOpportunity): void {
    const hops = path.steps.length;
    const route = path.steps.map((s) => `${s.tokenIn.symbol}→${s.tokenOut.symbol}`).join(' → ');

    this.logger.info(`🎯 ${hops}-Hop Arbitrage: ${path.id}`);
    this.logger.info(`   📍 Route: ${route}`);
    this.logger.info(`   💰 Borrow: ${formatUnits(path.borrowAmount, path.borrowToken.decimals)} ${path.borrowToken.symbol}`);

    for (let i = 0; i < path.steps.length; i++) {
      const s = path.steps[i];
      this.logger.info(
        `   ${i + 1}. ${formatUnits(s.amountIn, s.tokenIn.decimals)} ${s.tokenIn.symbol} → ` +
          `${formatUnits(s.amountOut, s.tokenOut.decimals)} ${s.tokenOut.symbol} ` +
          `(${s.pool.venue.name}, impact: ${s.priceImpact.toFixed(2)}%)`,
      );
    }

    this.logger.info(`   💵 Gross: $${path.grossProfitUSD.toFixed(4)}`);
    this.logger.info(`   ⛽ Gas: $${path.gasAnalysis!.totalGasCostUSD.toFixed(4)}`);
    this.logger.info(`   💰 Net: $${path.netProfitUSD.toFixed(4)}`);
    this.logger.info(`   📊 Total Slippage: ${path.totalSlippage.toFixed(4)}%\n`);
  }

  getStats() {
    return {
      opportunitiesFound: this.stats.opportunitiesFound,
      graph: this.graph.getStats(),
    };
  }
}
