import type { SwapStep } from '../interfaces';
import type { ArbitragePath, IPathFinder, WeightedEdge } from './interfaces';
import type { TokenOnChain } from '@/shared/data-model/token';
import { LiquidityGraph } from './liquidity-graph';
import { getFeeMultiplier } from '@/utils';
import { TokenManager } from '../token-manager';
import type { Logger } from '@/utils';

export interface PathFinderConfig {
  profitThreshold: number;
  maxHops: number;
  maxPathsPerToken: number;
  preferredBorrowTokens: string[];
}

export interface PathFinderInput {
  logger: Logger;
  config: PathFinderConfig;
  graph: LiquidityGraph;
  tokenManager: TokenManager;
}

interface DFSState {
  currentToken: TokenOnChain;
  path: WeightedEdge[];
  visitedPools: Set<string>;
  visitedTokens: Set<string>;
  depth: number;
  estimatedProfit: number; // This represents VALUE multiplier (1.0 = break even)
}

/**
 * 🔍 Path Finder: Discovers arbitrage cycles in liquidity graph
 *
 * Uses modified DFS to find profitable cycles:
 * 1. Start from borrow tokens
 * 2. Explore neighbors up to maxHops
 * 3. Return to start = valid cycle
 * 4. Prune unpromising paths early
 */
export class PathFinderBacktrackingDFS implements IPathFinder {
  private readonly logger: Logger;
  private readonly graph: LiquidityGraph;
  private readonly config: PathFinderConfig;
  private readonly tokenManager: TokenManager;

  constructor(input: PathFinderInput) {
    this.logger = input.logger;
    this.config = input.config;
    this.graph = input.graph;
    this.tokenManager = input.tokenManager;
  }

  // ============================================
  // PATH DISCOVERY
  // ============================================

  /**
   * 🔍 Find all cycles starting from affected tokens
   */
  findCycles(affectedTokens: Set<string>): ArbitragePath[] {
    const startTokens = this.getStartTokens(affectedTokens); // Get start tokens (intersection with preferred borrow tokens)
    const paths: ArbitragePath[] = [];

    for (const startToken of startTokens) {
      const token = this.tokenManager.getToken(startToken);
      // this.logger.debug(`🔎 DFS from ${token?.symbol || startToken}...`);
      const tokenPaths = this.findCyclesFromToken(token!);
      // this.logger.debug(`   Found ${tokenPaths.length} paths from ${token?.symbol || startToken}`);
      paths.push(...tokenPaths);
    }

    return paths;
  }

  /**
   * 🔄 Find all cycles starting from a specific token
   */
  // Instead of stack-based with copying — use single mutable state + backtrack
  private findCyclesFromToken(borrowToken: TokenOnChain): ArbitragePath[] {
    const paths: ArbitragePath[] = [];
    const visitedPools = new Set<string>();
    const visitedTokens = new Set<string>([borrowToken.address]);
    const pathEdges: WeightedEdge[] = [];

    this.dfs(borrowToken.address, borrowToken.address, pathEdges, visitedPools, visitedTokens, 0, 1.0, paths);
    return paths;
  }

  private dfs(
    start: string,
    current: string,
    path: WeightedEdge[],
    visitedPools: Set<string>,
    visitedTokens: Set<string>,
    depth: number,
    profit: number,
    results: ArbitragePath[],
  ): void {
    if (results.length >= this.config.maxPathsPerToken) return;

    for (const edge of this.graph.getEdges(current)) {
      const next = edge.tokenOut.address;
      if (visitedPools.has(edge.pool.id)) continue;

      const feeMultiplier = getFeeMultiplier(edge.feeBps, edge.pool.protocol);
      const newProfit = profit * edge.spotPrice * feeMultiplier;

      if (depth >= 1 && next === start) {
        if (newProfit > this.config.profitThreshold) results.push(this.createPathFromEdges(start, [...path, edge]));
        continue;
      }

      if (depth >= this.config.maxHops - 1) continue;
      if (visitedTokens.has(next)) continue;
      if (this.shouldPrunePath(start, next, depth + 1, newProfit)) continue;

      // Push — recurse — pop (no allocation)
      path.push(edge);
      visitedPools.add(edge.pool.id);
      visitedTokens.add(next);
      this.dfs(start, next, path, visitedPools, visitedTokens, depth + 1, newProfit, results);
      path.pop();
      visitedPools.delete(edge.pool.id);
      visitedTokens.delete(next);
    }
  }

  /**
   * ✂️ PRUNE potential paths that can't mathematically be profitable
   *
   */
  private shouldPrunePath(startKey: string, nextKey: string, depth: number, estimatedProfit: number): boolean {
    if (depth < 2) return false; // never prune paths of length 1

    const remainingHops = this.config.maxHops - depth;

    // If no remaining hops or completing a cycle => profit must be > 1
    if (remainingHops === 0 || nextKey === startKey) {
      return estimatedProfit <= this.config.profitThreshold; // Require at least X profit threshold to consider returning
    }

    // if we have remaining hops, asume best case scenario (cycle will be completed next hop with minimal fee)
    const bestCaseFeeMultiplier = 0.9999; // best case scenario 0.01% fee next hop // TODO: review this
    const bestCaseProfit = estimatedProfit * bestCaseFeeMultiplier; // (asuming next hop will complete cycle)
    if (bestCaseProfit < this.config.profitThreshold) return true;
    return false;
  }

  /**
   * 🛠️ Convert edge list to ArbitrageOpportunity (without amounts yet)
   */
  private createPathFromEdges(start: string, edges: WeightedEdge[]): ArbitragePath {
    // Create swap steps (amounts will be filled during evaluation)
    const steps: SwapStep[] = edges.map((edge) => ({
      pool: edge.pool,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      amountIn: 0n,
      amountOut: 0n,
      spotPrice: edge.spotPrice,
      executionPrice: 0,
      priceImpact: 0,
      slippage: 0,
    }));

    const pathKey = edges.map((e) => `${e.pool.venue.name}(${e.feeBps})[${e.tokenIn.symbol}->${e.tokenOut.symbol}]`).join('___');

    return {
      id: `${Date.now()}@${pathKey}`,
      steps,
      borrowToken: this.tokenManager.getToken(start)!,
    };
  }

  // ============================================
  // HELPERS
  // ============================================

  /**
   * 📝 Log path exploration details for debugging
   */
  private logExplorationDetails(state: DFSState, edge: WeightedEdge, newEstimatedProfit: number): void {
    const pathString = state.path
      .map((e) => `${e.tokenIn.symbol}---${e.pool.venue.name}(${e.feeBps})--->${e.tokenOut.symbol}`)
      .join('--->');
    const currentPathString = pathString + `---${edge.pool.venue.name}(${edge.feeBps})--->${edge.tokenOut.symbol}`;
    const depthInfo = `depth ${state.depth + 1}, prevProfit:${state.estimatedProfit.toFixed(
      4,
    )} newEstimatedProfit ${newEstimatedProfit.toFixed(4)}`;
    this.logger.debug(`DFS: ${currentPathString} (${depthInfo})`);
  }

  private getStartTokens(affectedTokens: Set<string>): Set<string> {
    // Return intersection of affectedTokens and preferredBorrowTokens
    const result = new Set<string>();
    result.add(this.tokenManager.WETH_ADDRESS);
    return result; // temp

    // for (const addr of affectedTokens) {
    //   const token = this.tokenManager.getToken(addr);
    //   if (token && this.config.preferredBorrowTokens.includes(token.symbol)) {
    //     // if (token.symbol === 'USDC') {
    //     // this.logger.debug(`TEMP Only adding USDC as start token: ${token.symbol} (${addr})`);
    //     result.add(addr);
    //     // }
    //   }
    // }

    // return result;
  }
}
