// ================================================================================================
// NETWORK GAS FEE INTERFACES
// ================================================================================================

import type { DexPoolState, EventMetadata } from '@/shared/data-model/layer1';
import type { TokenOnChain } from '@/shared/data-model/token';

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
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
}

export interface V4ModifyLiquidityEvent extends PoolEventBase {
  protocol: 'v4';
  name: 'modify-liquidity';
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

export type DexType = 'uniswap-v2' | 'uniswap-v3' | 'uniswap-v4' | 'curvestable' | 'balancerweighted';

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

// export interface ArbitrageOpportunity {
//   id: string; // Unique identifier for the opportunity
//   tokenPair: TokenPair;
//   zeroForOne: boolean; // true if entry swap its: token0 -> token1

//   // Buy side (cheaper)
//   entryPool: PoolState;
//   entryQuote: TradeQuote;

//   // Sell side (expensive)
//   exitPool: PoolState;
//   exitQuote: TradeQuote;

//   // Info data (used for display and logging)
//   priceDiff: number; // difference in price between entry and exit pools
//   priceDiffPercent: number; // percentage difference in price

//   // Profitability
//   tradeAmount: bigint;

//   grossProfitUSD: number;
//   gasAnalysis?: GasAnalysis;
//   netProfitUSD: number;

//   // Risk metrics
//   totalSlippage: number;
//   confidence: number;
//   urgency: number; // 0-1, how quickly this needs to be executed

//   timestamp: number;
// }

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

/**
 * 🛤️ Complete arbitrage path (N hops)
 */
export interface ArbitrageOpportunity {
  // Identity
  id: string;

  // Path structure
  steps: SwapStep[];
  borrowToken: TokenOnChain; // First token in = last token out
  borrowAmount: bigint;

  // Profitability
  grossProfitToken: bigint; // Profit in borrow token
  grossProfitUSD: number;
  netProfitUSD: number;

  // Metrics
  totalSlippage: number;
  totalPriceImpact: number;
  minConfidence?: number;

  // Gas analysis
  gasAnalysis?: GasAnalysis;

  // Metadata
  timestamp: number;
  blockNumber?: number;
}

// ================================================================================================
// DEX ADAPTER INTERFACE
// ================================================================================================

export interface DexAdapter {
  readonly name: string;
  readonly type: DexType;
  readonly factoryAddress: string;
  readonly routerAddress: string;

  readonly FACTORY_ABI: string[];
  readonly POOL_ABI: string[];

  // Pool management
  discoverPools(token0: string, token1: string): Promise<DexPoolState[]>;
  initPool(id: string): Promise<DexPoolState>;
  updatePool(pool: DexPoolState): Promise<DexPoolState>;
  updatePoolFromEvent(pool: DexPoolState, event: PoolEvent): DexPoolState;

  // Price
  simulateSwap(poolState: DexPoolState, amountIn: bigint, zeroForOne: boolean): bigint;
  getTradeQuote(poolState: DexPoolState, amountIn: bigint, zeroForOne: boolean): Promise<TradeQuote>;
  getFeePercent(poolState: DexPoolState): number;
}

// ================================================================================================
// CONFIGURATION INTERFACES
// ================================================================================================

export interface DexConfig {
  name: string;
  type: DexType;
  chainId: number;

  factoryAddress: string;
  routerAddress?: string;
  quoterAddress?: string;

  fee?: number | number[];
  isActive: boolean;

  // Event monitoring
  startBlock?: number;
  eventBatchSize?: number;

  // Performance tuning
  maxPoolsToMonitor?: number;
  priceUpdateIntervalMs?: number;
}

// ================================================================================================
// TRADE OPTIMIZER INTERFACE
// ================================================================================================

export interface TradeOptimizer {
  findOptimalTradeAmount(
    entryPool: DexPoolState,
    exitPool: DexPoolState,
    entryAdapter: DexAdapter,
    exitAdapter: DexAdapter,
    zeroForOne: boolean,
  ): Promise<bigint>;
}
