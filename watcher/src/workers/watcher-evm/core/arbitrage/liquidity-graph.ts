import type { WeightedEdge } from './interfaces';
import { getFeeMultiplier } from '@/utils';
import type { Logger } from '@/utils';
import type { DexManager } from '../dex-manager';
import type { DexPoolState } from '@/shared/data-model/layer1';
import { ethers } from 'ethers';
import { normalizeToGraphToken } from '../helpers';

export type LiquidityGraphConfig = {
  wrappedNativeTokenAddress: string;
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
  private readonly WETH_ADDRESS: string;

  // Adjacency list: tokenAddress -> outgoing edges
  private readonly edges = new Map<string, WeightedEdge[]>();
  // NOTE: list of tokens can be derived from edges keys

  constructor(input: LiquidityGraphInput) {
    this.logger = input.logger;
    this.dexManager = input.dexManager;
    this.config = input.config;
    this.WETH_ADDRESS = this.config.wrappedNativeTokenAddress;
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
    this.logger.debug(`Building liquidity graph from ${allPools.size} pools...`);

    for (const [_, pool] of allPools) {
      this.addPoolToGraph(pool); // bidirectional edges are added inside this method
    }

    // LOGGING: Verify bidirectional edges
    this.logger.debug('🔍 Verifying bidirectional edges...\n');

    // Original debug logging (keep for reference)
    for (const tokenAddr of this.edges.keys()) {
      const edges = this.edges.get(tokenAddr) || [];
      if (edges.length > 0) {
        this.logger.debug(`Token ${tokenAddr}: ${edges.length} edges`);
        for (const edge of edges) {
          this.logger.debug(
            `  → ${edge.tokenOut.symbol} via ${edge.pool.venue.name} (fee: ${edge.feeBps}, liquidity: $${edge.liquidityUSD.toFixed(2)})`,
          );
        }
      }
    }

    const stats = this.getStats();
    const duration = Date.now() - startTime;
    this.logger.info(`🌐 Built graph: ${stats.tokenCount} tokens, ${stats.edgeCount} edges (${duration}ms)`);
  }

  /**
   * 🔄 Update graph for specific pools (incremental)
   */
  updatePools(updatedPools: DexPoolState[]): Set<string> {
    const affectedTokens = new Set<string>();
    const wethAddr = this.config.wrappedNativeTokenAddress;

    for (const pool of updatedPools) {
      this.removePoolFromGraph(pool);

      if (this.addPoolToGraph(pool)) {
        // Track which tokens were affected (for path discovery optimization)
        affectedTokens.add(normalizeToGraphToken(pool.tokenPair.token0, this.WETH_ADDRESS).address);
        affectedTokens.add(normalizeToGraphToken(pool.tokenPair.token1, this.WETH_ADDRESS).address);
      }
    }

    return affectedTokens;
  }

  /**
   * ➕ Add single pool as bidirectional edges
   */
  private addPoolToGraph(pool: DexPoolState): boolean {
    // 1. check for invalid prices
    if (pool.spotPrice0to1 <= 0 || isNaN(pool.spotPrice0to1) || pool.spotPrice1to0 <= 0 || isNaN(pool.spotPrice1to0)) {
      return false;
    }
    // 2. Check liquidity threshold
    if (pool.totalLiquidityUSD < this.config.minLiquidityUSD) return false;

    // 3. Skip pools with hooks for now due to simulation complexity (review if we want to support them in the future)
    if (pool.protocol === 'v4' && pool.hooks !== ethers.ZeroAddress) {
      this.logger.debug(`Skipping pool with hooks: ${pool.hooks} (ID: ${pool.id}) - simulation accuracy not guaranteed`);
      return false;
    }

    // 4. temp blacklist
    // if ([pool.tokenPair.token0.address, pool.tokenPair.token1.address].includes('0x518b63da813d46556fea041a88b52e3caa8c16a8'))
    //   return false;

    // Normalize native ETH (address(0)) to WETH for graph node identity
    const graphToken0 = normalizeToGraphToken(pool.tokenPair.token0, this.WETH_ADDRESS);
    const graphToken1 = normalizeToGraphToken(pool.tokenPair.token1, this.WETH_ADDRESS);

    // Add forward edge: token0 -> token1
    this.addWeightedEdge({
      pool,
      tokenIn: graphToken0,
      tokenOut: graphToken1,
      spotPrice: pool.spotPrice0to1,
      weight: this.calculateEdgeWeight(pool.spotPrice0to1, pool),
      liquidityUSD: pool.totalLiquidityUSD,
      feeBps: pool.feeBps,
      updated: Date.now(),
    });

    // Add reverse edge: token1 -> token0
    this.addWeightedEdge({
      pool,
      tokenIn: graphToken1,
      tokenOut: graphToken0,
      spotPrice: pool.spotPrice1to0,
      weight: this.calculateEdgeWeight(pool.spotPrice1to0, pool),
      liquidityUSD: pool.totalLiquidityUSD,
      feeBps: pool.feeBps,
      updated: Date.now(),
    });

    return true;
  }

  private addWeightedEdge(edge: WeightedEdge): void {
    const key = edge.tokenIn.address;
    if (!this.edges.has(key)) this.edges.set(key, []);
    const edgeList = this.edges.get(key)!;

    // Replace existing edge for same pool, or add new
    const existingIndex = edgeList.findIndex((e) => e.pool.id === edge.pool.id);

    if (existingIndex >= 0) {
      edgeList[existingIndex] = edge;
    } else {
      edgeList.push(edge);
      // edgeList.sort((a, b) => b.liquidityUSD - a.liquidityUSD);
    }
  }

  private removePoolFromGraph(pool: DexPoolState): void {
    const token0Key = normalizeToGraphToken(pool.tokenPair.token0, this.WETH_ADDRESS).address;
    const token1Key = normalizeToGraphToken(pool.tokenPair.token1, this.WETH_ADDRESS).address;

    // Remove edges in both directions
    this.removeEdgeForPool(token0Key, pool.id);
    this.removeEdgeForPool(token1Key, pool.id);
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
   * 📊 Get graph statistics
   */
  getStats() {
    let totalEdges = 0;
    for (const edges of this.edges.values()) {
      totalEdges += edges.length;
    }

    return {
      tokenCount: this.edges.size,
      edgeCount: totalEdges,
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
    return Array.from(this.edges.keys());
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
