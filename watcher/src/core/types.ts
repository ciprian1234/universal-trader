// ================================================================================================
// SHARED TYPE DEFINITIONS — used by all layers (orchestrator, workers, admin)
// ================================================================================================

import type { EventMetadata } from '@/shared/data-model/layer1';
import type { TokenOnChain, TokenPairOnChain } from '@/shared/data-model/token';

export interface TokenPrice {
  token: TokenOnChain;
  priceUSD: number;
  lastUpdated: number;
  source: string;
}

// ── DEX Types ──

export type DexType = 'uniswap-v2' | 'uniswap-v3' | 'uniswap-v4' | 'solidly' | 'curve' | 'balancer' | 'cex';

// ── Pool State (discriminated union) ──

export interface BasePoolState {
  address: string; // unique pool identifier
  chainId: number;
  dexName: string;
  dexType: DexType;
  tokenPair: TokenPairOnChain;
  fee: number; // basis points (3000 = 0.3%)

  // USD valuations
  totalLiquidityUSD: number;

  // Other metadata
  routerAddress: string;

  // Tracking
  lastUpdatedBlock: number;
  lastUpdatedAt: number;
  disabled: boolean;

  // Latest event metadata
  latestEventMeta?: EventMetadata;
}

// Uniswap V2 / Sushi / PancakeSwap
export interface V2PoolState extends BasePoolState {
  dexType: 'uniswap-v2';
  reserve0: bigint;
  reserve1: bigint;
  spotPrice0to1: number;
  spotPrice1to0: number;
}

// Uniswap V3 / PancakeSwap V3
export interface V3PoolState extends BasePoolState {
  dexType: 'uniswap-v3';
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  tickSpacing: number;
  spotPrice0to1: number;
  spotPrice1to0: number;
  // Full tick data for multi-tick swap simulation
  initializedTicks: TickData[];
  tickBitmap: Map<number, bigint>;
}

// Solidly / Velodrome / Aerodrome
export interface SolidlyPoolState extends BasePoolState {
  dexType: 'solidly';
  reserve0: bigint;
  reserve1: bigint;
  stable: boolean;
  spotPrice0to1: number;
  spotPrice1to0: number;
}

// Curve StableSwap
export interface CurvePoolState extends BasePoolState {
  dexType: 'curve';
  balances: bigint[];
  A: bigint;
  rates: bigint[];
  totalSupply: bigint;
}

// Balancer Weighted
export interface BalancerPoolState extends BasePoolState {
  dexType: 'balancer';
  balances: bigint[];
  weights: bigint[];
  swapFeePercentage: bigint;
}

// CEX Order Book
export interface CexOrderBook extends BasePoolState {
  dexType: 'cex';
  exchange: string; // 'binance', 'coinbase', etc.
  symbol: string; // 'ETH/USDT'
  bids: Array<[price: number, quantity: number]>;
  asks: Array<[price: number, quantity: number]>;
  bestBid: number;
  bestAsk: number;
  spread: number;
  lastTradePrice: number;
}

// Union type of all pool states
export type PoolState = V2PoolState | V3PoolState | SolidlyPoolState | CurvePoolState | BalancerPoolState | CexOrderBook;

// ── Tick Data (V3) ──

export interface TickData {
  tick: number;
  liquidityNet: bigint;
  liquidityGross?: bigint;
  initialized: boolean;
}

// ── Trading Types ──

export interface TradeQuote {
  poolState: PoolState;
  amountIn: bigint;
  amountOut: bigint;
  executionPrice: number;
  priceImpact: number;
  slippage: number;
  confidence: number;
}

export interface SwapStep {
  pool: PoolState;
  tokenIn: TokenOnChain;
  tokenOut: TokenOnChain;
  amountIn: bigint;
  amountOut: bigint;
  spotPrice: number;
  executionPrice: number;
  priceImpact: number;
  slippage: number;
}

export interface GasTxSettings {
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface GasAnalysis {
  gasEstimate: bigint;
  totalGasCostUSD: number;
  baseFeePerGas: bigint;
  gasTxSettings: GasTxSettings;
}

export interface ArbitrageOpportunity {
  id: string;
  chainId: number;
  type: 'single-chain' | 'cross-chain';

  // Path structure
  steps: SwapStep[];
  borrowToken: TokenOnChain;
  borrowAmount: bigint;

  // Profitability
  grossProfitToken: bigint;
  grossProfitUSD: number;
  netProfitUSD: number;

  // Metrics
  totalSlippage: number;
  totalPriceImpact: number;
  confidence: number;

  // Gas
  gasAnalysis?: GasAnalysis;

  // Metadata
  timestamp: number;
  blockNumber?: number;
  expiresAt: number;
}

// ── Event Types ──

export interface PoolEvent {
  type: 'v2-sync' | 'v3-swap' | 'v3-mint' | 'v3-burn' | 'v4-swap' | 'v4-modify-liquidity';
  poolId: string;
  dexName: string;
  dexType: DexType;
  tokenPair: TokenPairOnChain;

  // V2 specific
  reserve0?: bigint;
  reserve1?: bigint;

  // V3/V4 specific
  sqrtPriceX96?: bigint;
  tick?: number;
  liquidity?: bigint;

  // V3 Mint/Burn specific
  tickLower?: number;
  tickUpper?: number;
  amount?: bigint;

  // Event metadata
  meta: EventMetadata;
}

// ── Execution Results ──

export interface ExecutionResult {
  opportunityId: string;
  chainId: number;
  success: boolean;
  txHash?: string;
  actualProfitUSD?: number;
  gasUsedUSD?: number;
  error?: string;
  executionTimeMs: number;
}

// ── DEX Adapter Interface ──

export interface DexAdapter {
  readonly name: string;
  readonly type: DexType;
  readonly factoryAddress: string;
  readonly routerAddress: string;
  readonly FACTORY_ABI: string[];
  readonly POOL_ABI: string[];

  // Pool management
  discoverPools(token0: string, token1: string): Promise<PoolState[]>;
  initPool(id: string): Promise<PoolState>;
  updatePool(pool: PoolState): Promise<PoolState>;
  updatePoolFromEvent(pool: PoolState, event: PoolEvent): PoolState;

  // Price & trade simulation
  simulateSwap(pool: PoolState, amountIn: bigint, zeroForOne: boolean): bigint;
  getTradeQuote(pool: PoolState, amountIn: bigint, zeroForOne: boolean): Promise<TradeQuote>;
  getFeePercent(pool: PoolState): number;
}
