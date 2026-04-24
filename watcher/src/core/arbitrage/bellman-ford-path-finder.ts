import type { Logger } from '@/utils';
import type { ArbitrageOpportunity, SwapStep } from '../interfaces';
import type { ArbitragePath, IPathFinder, WeightedEdge } from './interfaces';
import { LiquidityGraph } from './liquidity-graph';
import type { PathFinderConfig, PathFinderInput } from './path-finder';
import type { TokenManager } from '../token-manager';
import type { TokenOnChain } from '@/shared/data-model/token';

/**
 * 🔍 Bellman-Ford Path Finder: Uses negative cycle detection
 */
export class BellmanFordPathFinder implements IPathFinder {
  private readonly logger: Logger;
  private readonly config: PathFinderConfig;
  private readonly graph: LiquidityGraph;
  private readonly tokenManager: TokenManager;

  constructor(input: PathFinderInput) {
    this.logger = input.logger;
    this.config = input.config;
    this.graph = input.graph;
    this.tokenManager = input.tokenManager;
  }

  /**
   * 🔍 Find arbitrage cycles using Bellman-Ford
   */
  findCycles(affectedTokens: Set<string>): ArbitragePath[] {
    const paths: ArbitragePath[] = [];

    // Get weighted edges
    const edges = this.graph.getAllWeightedEdges();
    const vertices = this.graph.getTokenAddresses();

    // Run from each preferred borrow token
    for (const startTokenAddr of affectedTokens) {
      const token = this.tokenManager.getToken(startTokenAddr);
      if (!token || !this.config.preferredBorrowTokens.includes(token.symbol)) {
        continue;
      }

      // Run Bellman-Ford from this token
      const cycles = this.findNegativeCycles(startTokenAddr, edges, vertices);
      paths.push(...cycles);

      if (paths.length >= this.config.maxPathsPerToken) break;
    }

    return paths;
  }

  /**
   * 🔄 Bellman-Ford algorithm to detect negative cycles
   */
  private findNegativeCycles(source: string, edges: WeightedEdge[], vertices: string[]): ArbitragePath[] {
    const dist = new Map<string, number>();
    const predecessor = new Map<string, WeightedEdge | null>();

    // Initialize distances
    for (const v of vertices) {
      dist.set(v, v === source ? 0 : Infinity);
      predecessor.set(v, null);
    }

    // Relax edges V-1 times
    for (let i = 0; i < vertices.length - 1; i++) {
      for (const edge of edges) {
        const distFrom = dist.get(edge.tokenIn.address)!;
        const distTo = dist.get(edge.tokenOut.address)!;

        if (distFrom + edge.weight < distTo) {
          dist.set(edge.tokenOut.address, distFrom + edge.weight);
          predecessor.set(edge.tokenOut.address, edge);
        }
      }
    }

    // Detect negative cycles
    const cycles: ArbitragePath[] = [];

    for (const edge of edges) {
      const distFrom = dist.get(edge.tokenIn.address)!;
      const distTo = dist.get(edge.tokenOut.address)!;

      if (distFrom + edge.weight < distTo) {
        // Found negative cycle! Reconstruct it
        const cycle = this.reconstructCycle(edge, predecessor, source);
        if (cycle) {
          cycles.push(cycle);

          if (cycles.length >= this.config.maxPathsPerToken) {
            break;
          }
        }
      }
    }

    return cycles;
  }

  /**
   * 🔄 Reconstruct cycle from predecessor map
   */
  private reconstructCycle(
    edge: WeightedEdge,
    predecessor: Map<string, WeightedEdge | null>,
    source: string,
  ): ArbitragePath | null {
    const visited = new Set<string>();
    const path: WeightedEdge[] = [];

    // Walk backwards from edge.tokenIn.address to find the cycle
    let current = edge.tokenIn.address;

    while (!visited.has(current)) {
      visited.add(current);
      const pred = predecessor.get(current);

      if (!pred) break;

      path.unshift(pred);
      current = pred.tokenIn.address;

      // Stop if we've completed a cycle back to source
      if (current === source && path.length >= 2) {
        break;
      }
    }

    if (path.length < 2 || path[0].tokenIn.address !== source) {
      return null;
    }

    // Convert to ArbitragePath
    const borrowToken = this.tokenManager.getToken(source);
    if (!borrowToken) return null;

    return this.createPathFromEdges(borrowToken, path);
  }

  /**
   * 🛠️ Convert edge list to ArbitragePath (without amounts yet)
   */
  private createPathFromEdges(borrowToken: TokenOnChain, edges: WeightedEdge[]): ArbitragePath | null {
    if (edges.length === 0) return null;

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
    };
  }
}
