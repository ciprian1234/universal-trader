import { createLogger } from '@/utils';
import type { ArbitrageOpportunity, PoolEvent } from '../interfaces';
import type { IPathFinder } from './interfaces';
import { EventBus } from '../event-bus';
import { LiquidityGraph, type GraphConfig } from './liquidity-graph';
import { PathFinder, type PathFinderConfig } from './path-finder';
import { PathEvaluator, type EvaluatorConfig } from './path-evaluator';
import { formatUnits } from 'ethers';
import { TokenManager } from '../token-manager';
import { GasManager } from '../gas-manager';
import { DexManager } from '../dex-manager';
// import CONFIG from '../../config';
import { BellmanFordPathFinder } from './bellman-ford-path-finder';
import type { WorkerDb } from '../../db';
import type { ChainConfig } from '@/config/models';

// ============================================
// CONFIGURATION
// ============================================

export interface ArbitrageOrchestratorConfig {
  minGrossProfitUSD: number;
  maxSlippage: number;
  minLiquidityUSD: number;
  maxHops: number;
  maxPathsPerToken: number;
  fastMode: boolean;
}

export interface ArbitrageOrchestratorInput {
  chainConfig: ChainConfig;
  eventBus: EventBus;
  db: WorkerDb;
  tokenManager: TokenManager;
  gasManager: GasManager;
  dexManager: DexManager;
  config: ArbitrageOrchestratorConfig;
}

export interface ArbitrageStatistics {
  opportunitiesFound: number;
  totalProfitUSD: number;
  averageExecutionTime: number;
  pathsByHopCount: Map<number, number>;
  graphStats: any;
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
  private readonly db: WorkerDb;
  private readonly tokenManager: TokenManager;
  private readonly gasManager: GasManager;
  private readonly dexManager: DexManager;

  // Sub-services
  private readonly graph: LiquidityGraph;
  private readonly pathFinder: IPathFinder;
  private readonly pathEvaluator: PathEvaluator;

  // Statistics
  private stats: ArbitrageStatistics = {
    opportunitiesFound: 0,
    totalProfitUSD: 0,
    averageExecutionTime: 0,
    pathsByHopCount: new Map(),
    graphStats: {},
  };

  constructor(input: ArbitrageOrchestratorInput) {
    this.logger = createLogger(`[${input.chainConfig.name}.ArbitrageOrchestrator]`);
    this.chainConfig = input.chainConfig;
    this.eventBus = input.eventBus;
    this.db = input.db;
    this.tokenManager = input.tokenManager;
    this.gasManager = input.gasManager;
    this.dexManager = input.dexManager;
    // Initialize graph
    const graphConfig: GraphConfig = {
      minLiquidityUSD: input.config.minLiquidityUSD,
      maxEdgesPerToken: 1000,
    };

    this.graph = new LiquidityGraph(this.dexManager, this.tokenManager, graphConfig);

    // Initialize path finder
    const finderConfig: PathFinderConfig = {
      profitThreshold: 1.0001, // 0.01% profit threshold
      maxHops: input.config.maxHops || 4,
      maxPathsPerToken: input.config.maxPathsPerToken || 10000,
      preferredBorrowTokens: this.chainConfig.discoveryTokens, // WE CONSIDER DISCOVERY TOKENS AS PREFFERRED BORROW TOKENS
      tokenManager: this.tokenManager,
    };

    this.pathFinder = new PathFinder(this.graph, finderConfig);
    // this.pathFinder = new BellmanFordPathFinder(this.graph, finderConfig);

    // Initialize evaluator
    const evaluatorConfig: EvaluatorConfig = {
      minGrossProfitUSD: input.config.minGrossProfitUSD,
      maxTotalSlippage: input.config.maxSlippage,
    };

    this.pathEvaluator = new PathEvaluator(this.dexManager, this.tokenManager, this.gasManager, evaluatorConfig);

    this.setupEventListeners();
  }

  // ============================================
  // EVENT HANDLING
  // ============================================

  private setupEventListeners(): void {
    // Pool events
    this.eventBus.onPoolEventsBatch(async ({ events }) => {
      const { blockNumber, blockReceiveTimestamp } = events[0].meta;
      this.logger.info(`🔍 Block ${blockNumber}: ${events.length} events (+${Date.now() - blockReceiveTimestamp}ms)`);
      const startTime = Date.now();
      await this.processPoolEvents(events);
      const duration = Date.now() - startTime;
      // this.updateExecutionTimeStats(duration);
      this.logger.info(`⏱️  Execution time ${duration}ms`);
    });

    // Application events
    this.eventBus.onApplicationEvent((event) => {
      if (event.name === 'pool-states-updated') {
        this.logger.info('✅ Pools updated, building graph and enabling service');
        this.graph.buildGraph();
        this.enabled = true;
        this.stats.graphStats = this.graph.getStats();
      }

      if (event.name === 'reorg-detected') {
        this.logger.warn(`⚠️  Reorg detected at block ${event.data?.blockNumber}, disabling`);
        this.enabled = false;
      }
    });
  }

  // ============================================
  // MAIN PROCESSING PIPELINE
  // ============================================

  private async processPoolEvents(events: PoolEvent[]): Promise<void> {
    if (!this.enabled) {
      this.logger.warn('⚠️  Service not enabled yet');
      return;
    }

    try {
      // 1. Extract updated pools
      const updatedPools = this.getUpdatedPools(events);
      if (updatedPools.length === 0) return;

      this.logger.info(`   📊 ${updatedPools.length} pools updated`);

      // 2. Update graph incrementally
      const affectedTokens = this.graph.updatePools(updatedPools);

      // 3. Discover candidate paths
      const candidatePaths = this.pathFinder.findCycles(affectedTokens);
      this.logger.info(`   🔍 Found ${candidatePaths.length} candidate paths (block:${events[0].meta.blockNumber})`);

      if (candidatePaths.length === 0) return;

      // 4. Evaluate paths concurrently (batched)
      const evaluatedPaths = await this.evaluatePathsConcurrently(candidatePaths, 30);
      this.logger.info(`   ✅ ${evaluatedPaths.length} profitable paths`);

      if (evaluatedPaths.length === 0) return;

      // 5. Select non-overlapping paths
      const selectedPaths = this.selectBestPaths(evaluatedPaths);

      // 6. Save and emit
      await this.db.saveOpportunities(evaluatedPaths);

      for (const path of selectedPaths) {
        this.displayPath(path);
        this.eventBus.emitArbitrageOpportunity(path);
      }
    } catch (error) {
      this.logger.error('❌ Error processing pool events:', { error });
    }
  }

  private getUpdatedPools(events: PoolEvent[]) {
    const pools = new Map();

    for (const event of events) {
      const poolId = event.poolId;
      const pool = this.db.getPoolState(poolId);
      if (pool && !pools.has(poolId)) pools.set(poolId, pool);
    }

    return Array.from(pools.values());
  }

  private async evaluatePathsConcurrently(paths: ArbitrageOpportunity[], batchSize: number): Promise<ArbitrageOpportunity[]> {
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
    // Sort by net profit descending
    const sorted = [...paths].sort((a, b) => b.netProfitUSD - a.netProfitUSD);

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

    this.logger.info(`\n🎯 ${hops}-Hop Arbitrage: ${path.id}`);
    this.logger.info(`   📍 Route: ${route}`);
    this.logger.info(`   💰 Borrow: ${formatUnits(path.borrowAmount, path.borrowToken.decimals)} ${path.borrowToken.symbol}`);

    for (let i = 0; i < path.steps.length; i++) {
      const s = path.steps[i];
      this.logger.info(
        `   ${i + 1}. ${formatUnits(s.amountIn, s.tokenIn.decimals)} ${s.tokenIn.symbol} → ` +
          `${formatUnits(s.amountOut, s.tokenOut.decimals)} ${s.tokenOut.symbol} ` +
          `(${s.pool.dexName}, impact: ${s.priceImpact.toFixed(2)}%)`,
      );
    }

    this.logger.info(`   💵 Gross: $${path.grossProfitUSD.toFixed(4)}`);
    this.logger.info(`   ⛽ Gas: $${path.gasAnalysis!.totalGasCostUSD.toFixed(4)}`);
    this.logger.info(`   💰 Net: $${path.netProfitUSD.toFixed(4)}`);
    this.logger.info(`   📊 Total Slippage: ${path.totalSlippage.toFixed(4)}%\n`);
  }
}
