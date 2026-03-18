import type { GraphStats, WeightedEdge } from './interfaces';
import { getFeeMultiplier } from '@/utils';
import type { Logger } from '@/utils';
import type { DexManager } from '../dex-manager';
import type { TokenOnChain } from '@/shared/data-model/token';
import type { DexPoolState } from '@/shared/data-model/layer1';

export type LiquidityGraphConfig = {
  minLiquidityUSD: number;
};

export interface LiquidityGraphInput {
  logger: Logger;
  dexManager: DexManager;
  config: LiquidityGraphConfig;
}

/**
 * 🌐 Liquidity Graph: Token network representation
 *
 * Models DEX liquidity as a directed graph:
 * - Nodes: Tokens
 * - Edges: Pools (weighted by liquidity and price)
 */
export class LiquidityGraph {
  private readonly logger: Logger;
  private readonly dexManager: DexManager;
  private readonly config: LiquidityGraphConfig;

  // Adjacency list: tokenAddress -> outgoing edges
  private readonly edges = new Map<string, WeightedEdge[]>();

  // Quick lookups
  private readonly tokens = new Map<string, TokenOnChain>();
  private readonly poolToEdges = new Map<string, [string, string]>(); // poolKey -> [tokenIn, tokenOut]

  constructor(input: LiquidityGraphInput) {
    this.logger = input.logger;
    this.dexManager = input.dexManager;
    this.config = input.config;
  }

  // ============================================
  // GRAPH BUILDING
  // ============================================

  /**
   * 🔨 Build entire graph from scratch
   */
  buildGraph(): void {
    const startTime = Date.now();

    this.clear();

    const allPools = this.dexManager.getAllPools();

    for (const [_, pool] of allPools) {
      this.addPoolToGraph(pool); // bidirectional edges are added inside this method
    }

    // LOGGING: Verify bidirectional edges
    this.logger.info('🔍 Verifying bidirectional edges...\n');

    // Original debug logging (keep for reference)
    for (const [tokenAddr, token] of this.tokens) {
      const edges = this.edges.get(tokenAddr) || [];
      if (edges.length > 0) {
        this.logger.debug(`Token ${token.symbol}: ${edges.length} edges`);
        for (const edge of edges) {
          this.logger.debug(
            `  → ${edge.tokenOut.symbol} via ${edge.pool.venue.name} (fee: ${edge.feeBps}, liquidity: $${edge.liquidityUSD.toFixed(2)})`,
          );
        }
      }
    }

    const duration = Date.now() - startTime;
    this.logger.info(`🌐 Built graph: ${this.tokens.size} tokens, ${this.edges.size} edges (${duration}ms)`);
  }

  /**
   * 🔄 Update graph for specific pools (incremental)
   */
  updatePools(updatedPools: DexPoolState[]): Set<string> {
    const affectedTokens = new Set<string>();

    for (const pool of updatedPools) {
      this.removePoolFromGraph(pool);

      if (this.addPoolToGraph(pool)) {
        // Track which tokens were affected (for path discovery optimization)
        affectedTokens.add(pool.tokenPair.token0.address);
        affectedTokens.add(pool.tokenPair.token1.address);
      }
    }

    return affectedTokens;
  }

  /**
   * ➕ Add single pool as bidirectional edges
   */
  private addPoolToGraph(pool: DexPoolState): boolean {
    // TODO: rename to updateGraphFromPool
    // Check liquidity threshold
    if (pool.totalLiquidityUSD < this.config.minLiquidityUSD) return false;

    const { token0, token1 } = pool.tokenPair;

    // Add tokens
    this.tokens.set(token0.address, token0);
    this.tokens.set(token1.address, token1);

    // Add forward edge: token0 -> token1
    this.addWeightedEdge({
      pool,
      tokenIn: token0,
      tokenOut: token1,
      spotPrice: pool.spotPrice0to1,
      weight: this.calculateEdgeWeight(pool.spotPrice0to1, pool),
      liquidityUSD: pool.totalLiquidityUSD,
      feeBps: pool.feeBps,
      updated: Date.now(),
    });

    // Add reverse edge: token1 -> token0
    this.addWeightedEdge({
      pool,
      tokenIn: token1,
      tokenOut: token0,
      spotPrice: pool.spotPrice1to0,
      weight: this.calculateEdgeWeight(pool.spotPrice1to0, pool),
      liquidityUSD: pool.totalLiquidityUSD,
      feeBps: pool.feeBps,
      updated: Date.now(),
    });

    // Track pool location in graph
    this.poolToEdges.set(pool.id, [token0.address, token1.address]);

    return true;
  }

  private addWeightedEdge(edge: WeightedEdge): void {
    const key = edge.tokenIn.address;

    if (!this.edges.has(key)) {
      this.edges.set(key, []);
    }

    const edgeList = this.edges.get(key)!;

    // Replace existing edge for same pool, or add new
    const existingIndex = edgeList.findIndex((e) => e.pool.id === edge.pool.id);

    if (existingIndex >= 0) {
      edgeList[existingIndex] = edge;
    } else {
      // Keep sorted by liquidity (descending)
      edgeList.push(edge);
      edgeList.sort((a, b) => b.liquidityUSD - a.liquidityUSD);
    }
  }

  private removePoolFromGraph(pool: DexPoolState): void {
    const tokenPair = this.poolToEdges.get(pool.id);
    if (!tokenPair) return;

    const [token0Key, token1Key] = tokenPair;

    // Remove edges in both directions
    this.removeEdgeForPool(token0Key, pool.id);
    this.removeEdgeForPool(token1Key, pool.id);

    this.poolToEdges.delete(pool.id);
  }

  private removeEdgeForPool(tokenKey: string, poolId: string): void {
    const edges = this.edges.get(tokenKey);
    if (!edges) return;

    const filtered = edges.filter((e) => e.pool.id !== poolId);

    if (filtered.length === 0) {
      this.edges.delete(tokenKey);
    } else {
      this.edges.set(tokenKey, filtered);
    }
  }

  private clear(): void {
    this.edges.clear();
    this.tokens.clear();
    this.poolToEdges.clear();
  }

  // ============================================
  // QUERIES
  // ============================================

  /**
   * 🔍 Get outgoing edges from a token
   */
  getEdges(tokenAddress: string): WeightedEdge[] {
    return this.edges.get(tokenAddress) || [];
  }

  /**
   * 🔍 Get all tokens in graph
   */
  getTokens(): TokenOnChain[] {
    return Array.from(this.tokens.values());
  }

  /**
   * 🔍 Check if token exists in graph
   */
  hasToken(tokenAddress: string): boolean {
    return this.tokens.has(tokenAddress);
  }

  /**
   * 📊 Get graph statistics
   */
  getStats(): GraphStats {
    let totalEdges = 0;
    for (const edges of this.edges.values()) {
      totalEdges += edges.length;
    }

    return {
      tokenCount: this.tokens.size,
      edgeCount: totalEdges,
      avgDegree: this.tokens.size > 0 ? totalEdges / this.tokens.size : 0,
      lastUpdate: Date.now(),
    };
  }

  /**
   * 🔄 Get all weighted edges (for Bellman-Ford)
   */
  getAllWeightedEdges(): WeightedEdge[] {
    const allEdges: WeightedEdge[] = [];
    for (const edges of this.edges.values()) {
      allEdges.push(...edges);
    }

    return allEdges;
  }

  /**
   * 🔄 Get tokens as array (for Bellman-Ford iteration)
   */
  getTokenAddresses(): string[] {
    return Array.from(this.tokens.keys());
  }

  /**
   * Calculate weight for an edge
   */
  calculateEdgeWeight(spotPrice: number, pool: DexPoolState): number {
    const rate = spotPrice;
    const feeMultiplier = getFeeMultiplier(pool.feeBps, pool.protocol);
    return -Math.log(rate * feeMultiplier);
  }
}
