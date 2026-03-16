import { createLogger } from '../../utils/logger';
import { ArbitrageOpportunity, SwapStep, Token } from '../interfaces';
import { IPathFinder, WeightedEdge } from './interfaces';
import { LiquidityGraph } from './liquidity-graph';
import { getFeeMultiplier } from '../utils';
import { TokenManager } from '../token-manager';

export interface PathFinderConfig {
  profitThreshold: number;
  maxHops: number;
  maxPathsPerToken: number;
  preferredBorrowTokens: string[];
  tokenManager: TokenManager;
}

interface DFSState {
  currentToken: Token;
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
export class PathFinder implements IPathFinder {
  private readonly logger = createLogger('[PathFinder]');

  constructor(
    private readonly graph: LiquidityGraph,
    private readonly config: PathFinderConfig,
  ) {}

  // ============================================
  // PATH DISCOVERY
  // ============================================

  /**
   * 🔍 Find all cycles starting from affected tokens
   */
  findCycles(affectedTokens: Set<string>): ArbitrageOpportunity[] {
    const startTokens = this.getStartTokens(affectedTokens); // Get start tokens (intersection with preferred borrow tokens)

    const paths: ArbitrageOpportunity[] = [];

    for (const startToken of startTokens) {
      const token = this.config.tokenManager.getToken(startToken);

      // this.logger.debug(`🔎 DFS from ${token?.symbol || startToken}...`);

      const tokenPaths = this.findCyclesFromToken(token!);

      // this.logger.debug(`   Found ${tokenPaths.length} paths from ${token?.symbol || startToken}`);

      paths.push(...tokenPaths);

      // Limit total paths
      // if (paths.length >= this.config.maxPathsPerToken * startTokens.size) {
      //   break;
      // }
    }

    // ✅ LOG 5: Total paths found
    this.logger.info(`✅ Total paths found: ${paths.length}`);

    return paths;
  }

  /**
   * 🔄 Find all cycles starting from a specific token
   */
  private findCyclesFromToken(borrowToken: Token): ArbitrageOpportunity[] {
    const paths: ArbitrageOpportunity[] = [];
    const startKey = borrowToken.address;

    // DFS state

    const stack: DFSState[] = [
      {
        currentToken: borrowToken,
        path: [],
        visitedPools: new Set(),
        visitedTokens: new Set([startKey]),
        depth: 0,
        estimatedProfit: 1.0, // Start at 1.0 (100% of initial value)
      },
    ];

    while (stack.length > 0 && paths.length < this.config.maxPathsPerToken) {
      const state = stack.pop()!;

      // 🔁 Found cycle back to start
      if (state.depth >= 2 && state.currentToken.address === startKey) {
        // Quick profitability check using spot prices
        if (state.estimatedProfit > this.config.profitThreshold) {
          // 0.6% profit threshold
          // this.logger.debug(
          //   `   🔁 Found cycle (${state.depth}): ${state.path.map((e) => `${e.tokenIn.symbol}->${e.tokenOut.symbol}`).join(' -> ')}`,
          // );
          const path = this.createPathFromEdges(borrowToken, state.path);
          paths.push(path);
        }
        continue; // STOP exploring further from completed cycles (no sense to open cycle again: USDC→X→USDC→Y→USDC)
      }

      // Max depth reached
      if (state.depth >= this.config.maxHops) continue;

      // Explore neighbors (edges for current token to others)
      const edges = this.graph.getEdges(state.currentToken.address);

      for (const edge of edges) {
        const nextTokenAddr = edge.tokenOut.address;

        // Skip if pool already used
        if (state.visitedPools.has(edge.pool.id)) continue;

        // Skip if token already visited (unless closing cycle)
        if (state.visitedTokens.has(nextTokenAddr) && nextTokenAddr !== startKey) continue;

        // NOTE: prune low liquidity pools (no need since graph already filters by liquidity)
        // if (edge.liquidityUSD < 1000) continue; // skip pools with less than $1,000 liquidity

        // Calculate estimated profit multiplier for this edge
        const feeMultiplier = getFeeMultiplier(edge.fee, edge.pool.dexType);
        const newEstimatedProfit = state.estimatedProfit * edge.spotPrice * feeMultiplier;

        // Prune paths that can't mathematically be profitable
        if (this.shouldPrunePath(startKey, nextTokenAddr, state.depth + 1, newEstimatedProfit)) continue; // ✂️ PRUNE

        // log path exploration details (commented out but keep here for reference)
        // this.logExplorationDetails(state, edge, newEstimatedProfit);

        const newVisitedPools = new Set(state.visitedPools);
        newVisitedPools.add(edge.pool.id);

        const newVisitedTokens = new Set(state.visitedTokens);
        newVisitedTokens.add(nextTokenAddr);

        // Add to stack
        stack.push({
          currentToken: edge.tokenOut,
          path: [...state.path, edge],
          visitedPools: newVisitedPools,
          visitedTokens: newVisitedTokens,
          depth: state.depth + 1,
          estimatedProfit: newEstimatedProfit,
        });
      }
    }

    return paths;
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
    const bestCaseFeeMultiplier = 0.9995; // best case scenario 0.05% fee next hop
    const bestCaseProfit = estimatedProfit * bestCaseFeeMultiplier; // (asuming next hop will complete cycle)
    if (bestCaseProfit < this.config.profitThreshold) return true;
    return false;
  }

  /**
   * 🛠️ Convert edge list to ArbitrageOpportunity (without amounts yet)
   */
  private createPathFromEdges(borrowToken: Token, edges: WeightedEdge[]): ArbitrageOpportunity {
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

    const pathKey = edges.map((e) => e.pool.id).join('→');

    return {
      id: `${Date.now()}_${pathKey}`,
      steps,
      borrowToken,
      borrowAmount: 0n,
      grossProfitToken: 0n,
      grossProfitUSD: 0,
      netProfitUSD: 0,
      totalSlippage: 0,
      totalPriceImpact: 0,
      minConfidence: 0.99,
      timestamp: Date.now(),
    };
  }

  // ============================================
  // HELPERS
  // ============================================

  /**
   * 📝 Log path exploration details for debugging
   */
  private logExplorationDetails(state: DFSState, edge: WeightedEdge, newEstimatedProfit: number): void {
    const pathString = state.path.map((e) => `${e.tokenIn.symbol}---${e.pool.dexName}(${e.fee})--->${e.tokenOut.symbol}`).join('--->');
    const currentPathString = pathString + `---${edge.pool.dexName}(${edge.pool.fee})--->${edge.tokenOut.symbol}`;
    const depthInfo = `depth ${state.depth + 1}, prevProfit:${state.estimatedProfit.toFixed(
      4,
    )} newEstimatedProfit ${newEstimatedProfit.toFixed(4)}`;
    this.logger.debug(`DFS: ${currentPathString} (${depthInfo})`);
  }

  private getStartTokens(affectedTokens: Set<string>): Set<string> {
    // Return intersection of affectedTokens and preferredBorrowTokens
    const result = new Set<string>();

    for (const addr of affectedTokens) {
      const token = this.config.tokenManager.getToken(addr);
      if (token && this.config.preferredBorrowTokens.includes(token.symbol)) {
        // if (token.symbol === 'USDC') {
        // this.logger.debug(`TEMP Only adding USDC as start token: ${token.symbol} (${addr})`);
        result.add(addr);
        // }
      }
    }

    return result;
  }

  private getBorrowTokens(affectedTokens: Set<string>): Token[] {
    const borrowTokens: Token[] = [];

    for (const tokenAddr of affectedTokens) {
      const token = this.graph.getTokens().find((t) => t.address.toLowerCase() === tokenAddr);

      if (token && this.config.preferredBorrowTokens.includes(token.symbol)) {
        borrowTokens.push(token);
      }
    }

    // If no affected tokens are borrowable, use all preferred tokens in graph
    if (borrowTokens.length === 0) {
      for (const token of this.graph.getTokens()) {
        if (this.config.preferredBorrowTokens.includes(token.symbol)) {
          borrowTokens.push(token);
        }
      }
    }

    return borrowTokens;
  }
}
