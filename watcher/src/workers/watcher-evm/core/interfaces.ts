// ================================================================================================
// NETWORK GAS FEE INTERFACES
// ================================================================================================

export interface GasTxSettings {
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

// ================================================================================================
// TOKEN INTERFACES
// ================================================================================================

export interface Token {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

export interface TokenPair {
  token0: Token;
  token1: Token;
  pairKey: string; // "WETH-USDC"
}

export interface TokenPrice {
  token: Token;
  priceUSD: number;
  lastUpdated: number;
  source: string; // DEX name or oracle
}

// ================================================================================================
// DEX POOL INTERFACES
// ================================================================================================
export interface PoolState {
  id: string; // unique pool identifier (address for Uniswap V2/V3, poolKeyHash for Uniswap V4)
  tokenPair: TokenPair;

  // DEX info
  dexName: string;
  dexType: DexType;
  fee: number;

  // V2 specific
  reserve0?: bigint;
  reserve1?: bigint;

  // V3/V4 specific
  sqrtPriceX96?: bigint;
  tick?: number;
  liquidity?: bigint;
  feeGrowthGlobal0X128?: bigint; // not used currently
  feeGrowthGlobal1X128?: bigint; // not used currently

  // derived fields
  spotPrice0to1: number; // spot price of token0 in terms of token1
  spotPrice1to0: number; // spot price of token1 in terms of token0

  // USD valuations (note those values are only for reference - in arbitrage we use pool spot prices directly)
  // token0PriceInUSD?: number; // requires external price feed
  // token1PriceInUSD?: number; // requires external price feed
  // token0LiquidityInUSD?: number; // requires external price feed
  // token1LiquidityInUSD?: number; // requires external price feed
  totalLiquidityInUSD: number; // we filter out pools below a certain USD liquidity threshold

  // other pool metadata
  routerAddress: string;
  meta?: {
    tickSpacing?: number;
    hooks?: string;
  };

  // Latest event metadata
  latestEventMeta?: EventMetadata;

  // V3 tick data for multi-tick simulation
  initializedTicks?: TickData[]; // sorted array of initialized ticks with their liquidityNet
  tickSpacing?: number;
}

export interface TickData {
  tick: number;
  liquidityNet: bigint; // net liquidity change when crossing this tick
}

export type DexType = 'uniswap-v2' | 'uniswap-v3' | 'uniswap-v4' | 'curvestable' | 'balancerweighted';

// ================================================================================================
// TRADING INTERFACES
// ================================================================================================

export interface TradeQuote {
  poolState: PoolState;
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
  pool: PoolState;
  tokenIn: Token;
  tokenOut: Token;
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
  borrowToken: Token; // First token in = last token out
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
  discoverPools(token0: string, token1: string): Promise<PoolState[]>;
  initPool(id: string): Promise<PoolState>;
  updatePool(pool: PoolState): Promise<PoolState>;
  updatePoolFromEvent(pool: PoolState, event: PoolEvent): PoolState;

  // Price
  simulateSwap(poolState: PoolState, amountIn: bigint, zeroForOne: boolean): bigint;
  getTradeQuote(poolState: PoolState, amountIn: bigint, zeroForOne: boolean): Promise<TradeQuote>;
  getFeePercent(poolState: PoolState): number;
}

// ================================================================================================
// EVENT INTERFACES
// ================================================================================================
export interface EventMetadata {
  blockNumber: number;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
  timestamp: number;
  blockReceiveTimestamp: number;
}

export interface PoolEvent {
  type: 'v2-sync' | 'v3-swap' | 'v3-mint' | 'v3-burn' | 'v4-swap' | 'v4-modify-liquidity';
  poolId: string;
  dexName: string;
  dexType: DexType;
  tokenPair: TokenPair;

  // V2 specific
  reserve0?: bigint;
  reserve1?: bigint;

  // V3/V4 specific (TODO: validate)
  sqrtPriceX96?: bigint;
  tick?: number;
  liquidity?: bigint;

  // event metadata
  meta: EventMetadata;
}

export type EventCallback = (event: PoolEvent) => Promise<void>;

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
    entryPool: PoolState,
    exitPool: PoolState,
    entryAdapter: DexAdapter,
    exitAdapter: DexAdapter,
    zeroForOne: boolean,
  ): Promise<bigint>;
}
