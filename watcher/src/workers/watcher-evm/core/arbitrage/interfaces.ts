import { ArbitrageOpportunity, PoolState, Token } from '../interfaces';

/**
 * 🔄 Single swap in an arbitrage path
 */

// 🔗 Edge in liquidity graph - bellman ford perspective
export interface WeightedEdge {
  pool: PoolState; // original pool reference
  tokenIn: Token; // token address
  tokenOut: Token; // token address

  // Bellman-Ford specific fields weighted field
  weight: number; // -log(rate * (1 - fee))

  // extra fields for reference (decide if needed)
  spotPrice: number;
  liquidityUSD: number;
  fee: number;
  updated: number;
}

/**
 * 📊 Graph statistics
 */
export interface GraphStats {
  tokenCount: number;
  edgeCount: number;
  avgDegree: number;
  lastUpdate: number;
}

export interface IPathFinder {
  findCycles(affectedTokens: Set<string>): ArbitrageOpportunity[];
}
