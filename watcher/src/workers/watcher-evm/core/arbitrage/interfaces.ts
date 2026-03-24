import type { DexPoolState } from '@/shared/data-model/layer1';
import type { SwapStep } from '../interfaces';
import type { TokenOnChain } from '@/shared/data-model/token';

/**
 * 🔄 Single swap in an arbitrage path
 */

// 🔗 Edge in liquidity graph - bellman ford perspective
export interface WeightedEdge {
  pool: DexPoolState; // original pool reference
  tokenIn: TokenOnChain; // token address
  tokenOut: TokenOnChain; // token address

  // Bellman-Ford specific fields weighted field
  weight: number; // -log(rate * (1 - fee))

  // extra fields for reference (decide if needed)
  spotPrice: number;
  liquidityUSD: number;
  feeBps: number;
  updated: number;
}

export interface ArbitragePath {
  id: string;
  borrowToken: TokenOnChain; // First token in = last token out
  steps: SwapStep[];
}

export interface IPathFinder {
  findCycles(affectedTokens: Set<string>): ArbitragePath[];
}
