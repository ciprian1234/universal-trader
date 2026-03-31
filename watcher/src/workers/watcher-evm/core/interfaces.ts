// ================================================================================================
// NETWORK GAS FEE INTERFACES
// ================================================================================================

import type { DexPoolState, EventMetadata } from '@/shared/data-model/layer1';
import type { TokenOnChain } from '@/shared/data-model/token';
import type { Trade } from './flash-arbitrage-handler/flash-arbitrage-config';

// ════════════════════════════════════════════════════════════
// POOL EVENTS — worker-internal, never crosses to main thread
// ════════════════════════════════════════════════════════════

interface PoolEventBase {
  poolId: string;
  protocol: 'v2' | 'v3' | 'v4';
  name: 'sync' | 'swap' | 'mint' | 'burn' | 'modify-liquidity';
  sourceAddress: string; // event address (lowercase)
  meta: EventMetadata;
}

// ── V2 ──────────────────────────────────────────────────────

export interface V2SyncEvent extends PoolEventBase {
  protocol: 'v2';
  name: 'sync';
  reserve0: bigint;
  reserve1: bigint;
}

// ── V3 ──────────────────────────────────────────────────────

export interface V3SwapEvent extends PoolEventBase {
  protocol: 'v3';
  name: 'swap';
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  amount0: bigint;
  amount1: bigint;
}

export interface V3MintEvent extends PoolEventBase {
  protocol: 'v3';
  name: 'mint';
  tickLower: number;
  tickUpper: number;
  amount: bigint; // liquidity added
  amount0: bigint;
  amount1: bigint;
}

export interface V3BurnEvent extends PoolEventBase {
  protocol: 'v3';
  name: 'burn';
  tickLower: number;
  tickUpper: number;
  amount: bigint; // liquidity removed
  amount0: bigint;
  amount1: bigint;
}

// ── V4 ──────────────────────────────────────────────────────

export interface V4SwapEvent extends PoolEventBase {
  protocol: 'v4';
  name: 'swap';
  poolKeyHash: string; // keccak256(token0, token1, fee) used as pool identifier in v4 events
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
}

export interface V4ModifyLiquidityEvent extends PoolEventBase {
  protocol: 'v4';
  name: 'modify-liquidity';
  poolKeyHash: string; // keccak256(token0, token1, fee) used as pool identifier in v4 events
  tickLower: number;
  tickUpper: number;
  liquidityDelta: bigint; // positive = add, negative = remove
}

// ── Union ───────────────────────────────────────────────────

export type PoolEvent = V2SyncEvent | V3SwapEvent | V3MintEvent | V3BurnEvent | V4SwapEvent | V4ModifyLiquidityEvent;

// ================================================================================================
// Gas Tx Settings
// ================================================================================================

export interface GasTxSettings {
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

// ================================================================================================
// TOKEN INTERFACES
// ================================================================================================

export interface TokenPrice {
  token: TokenOnChain;
  priceUSD: number;
  lastUpdated: number;
  source: string; // DEX name or oracle
}

// ================================================================================================
// TRADING INTERFACES
// ================================================================================================

export interface TradeQuote {
  poolState: DexPoolState;
  amountIn: bigint;
  amountOut: bigint;
  executionPrice: number;
  priceImpact: number;
  slippage: number;
  route?: string[];
  confidence: number; // 0-1, higher for more reliable quotes
}

export interface GasAnalysis {
  gasEstimate: bigint;
  totalGasCostUSD: number;
  gasData: any;
  baseFeePerGas: bigint; // latest base fee from latest block
  gasTxSettings: GasTxSettings;
}

export interface SwapStep {
  pool: DexPoolState;
  tokenIn: TokenOnChain;
  tokenOut: TokenOnChain;
  amountIn: bigint;
  amountOut: bigint;
  spotPrice: number;
  executionPrice: number;
  priceImpact: number;
  slippage: number;
}

// ================================================================================================
// ARBITRAGE OPPORTUNITIES
// ================================================================================================
export interface ArbitrageOpportunity {
  id: string;
  chainId: number;
  status: 'new' | 'invalid' | 'pending' | 'success' | 'failed' | 'error' | 'dropped' | 'timeout';

  // info
  grossProfitToken: bigint; // Profit in borrow token
  grossProfitUSD: number;
  netProfitUSD: number;
  borrowToken: TokenOnChain; // First token in = last token out
  borrowAmount: bigint;

  // details
  steps: SwapStep[];
  gasAnalysis?: GasAnalysis;
  logs: any[];

  // Contract Trade Struct
  trade?: Trade; // filled when preparing for execution

  // Metrics
  totalSlippage: number;
  totalPriceImpact: number;
  minConfidence?: number;

  // Metadata
  timestamp: number;
  foundAtBlock?: number;
}

// export interface ArbitrageExecution {
//   status: 'pending' | 'success' | 'failed' | 'dropped' | 'timeout';
//   trade: any; // trade parameters sent to contract
//   tx: any; // transaction object from ethers
//   txReceipt?: any; // transaction receipt after confirmation
//   errorMessage?: string; // error message if failed
//   submittedAt: number;
//   submittedAtBlock: number;
//   confirmetAtBlock?: number;
// }
// ================================================================================================
// TRADE OPTIMIZER INTERFACE
// ================================================================================================

// export interface TradeOptimizer {
//   findOptimalTradeAmount(
//     entryPool: DexPoolState,
//     exitPool: DexPoolState,
//     entryAdapter: DexAdapter,
//     exitAdapter: DexAdapter,
//     zeroForOne: boolean,
//   ): Promise<bigint>;
// }
