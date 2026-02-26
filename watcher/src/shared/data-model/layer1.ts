import type { PairId, TokenOnChain, TokenBase, TokenPairOnChain } from './token';

// ════════════════════════════════════════════════════════════
// VENUE IDENTIFICATION
// ════════════════════════════════════════════════════════════

export const DEX_VENUE_NAMES = ['uniswap-v2', 'uniswap-v3', 'uniswap-v4', 'sushiswap-v2'] as const;
export const CEX_VENUE_NAMES = ['binance', 'coinbase', 'kraken'] as const;
export type DexVenueName = (typeof DEX_VENUE_NAMES)[number];
export type CexVenueName = (typeof CEX_VENUE_NAMES)[number];

export type VenueType = 'dex' | 'cex';
export type DexProtocol = 'v2' | 'v3' | 'v4';

export interface DexVenueId {
  type: 'dex';
  name: DexVenueName; // supported DEXes
  chainId: number;
}

export interface CexVenueId {
  type: 'cex';
  name: CexVenueName; // supported CEXes
}

export type VenueId = DexVenueId | CexVenueId;

// ════════════════════════════════════════════════════════════
// LAYER 1: VENUE-SPECIFIC STATE
// ════════════════════════════════════════════════════════════

export interface VenueState {
  id: string; // globally unique id: "1:0xabc..." for DEX, "binance:ETHUSDC" for CEX
  venue: VenueId;
  pairId: PairId;
}

// ── DEX ─────────────────────────────────────────────────────

export interface DexPoolState extends VenueState {
  address: string; // pool address (for v2 and v3), in v4 we store PoolManager address here and the actual pool is identified by poolKey
  venue: DexVenueId;
  protocol: DexProtocol;
  tokenPair: TokenPairOnChain;
  feeBps: number;

  // in concentrated liquidity reserves are virtual and calculated from liquidity, tick, and sqrtPriceX96
  reserve0: bigint;
  reserve1: bigint;

  // derived fields (updated on each updatePool)
  spotPrice0to1: number; // price of token0 in terms of token1
  spotPrice1to0: number; // price of token1 in terms of token0
  totalLiquidityInUSD: number;

  // Metadata of the latest event that caused a state update
  latestEventMeta?: EventMetadata;
}

interface ConcentratedLiquidityFields {
  tickSpacing: number;
  tick: number;
  liquidity: bigint;
  sqrtPriceX96: bigint;
  feeGrowthGlobal0X128?: bigint; // not used currently
  feeGrowthGlobal1X128?: bigint; // not used currently
  ticks?: TickData[]; // optional array of active ticks with liquidity changes
}

export interface DexV2PoolState extends DexPoolState {
  protocol: 'v2';
  reserve0: bigint;
  reserve1: bigint;
}

export interface DexV3PoolState extends DexPoolState, ConcentratedLiquidityFields {
  protocol: 'v3';
}

export interface DexV4PoolState extends DexPoolState, ConcentratedLiquidityFields {
  protocol: 'v4';
  poolKey: string; // bytes32 — V4 identifies pools by poolKey, not address
  hooks?: string; // V4 hooks address
}

export interface EventMetadata {
  transactionHash: string;
  blockNumber: number;
  transactionIndex: number;
  logIndex: number;
  blockReceivedTimestamp: number;
}

interface TickData {
  tick: number;
  liquidityNet: bigint;
}

// ── CEX ─────────────────────────────────────────────────────

export interface CexMarketState extends VenueState {
  venue: CexVenueId;
  baseToken: TokenBase; // e.g. ETH
  quoteToken: TokenBase; // e.g. USDC
  exchangeSymbol: string; // raw: "ETHUSDC"
  bestBid: number;
  bestAsk: number;
  bidQty: number;
  askQty: number;
  bids?: [price: number, qty: number][];
  asks?: [price: number, qty: number][];
}

// ════════════════════════════════════════════════════════════
// VENUE STATE STORE
// ════════════════════════════════════════════════════════════

export type VenueChangeType = 'add' | 'update' | 'remove';
export type VenueChangeListener = (state: VenueState, changeType: VenueChangeType) => void;

export interface IVenueStateStore {
  set(state: VenueState): void;
  setBatch(states: VenueState[]): void;
  remove(id: string): boolean;
  setDisabled(id: string, disabled: boolean): void;

  get(id: string): VenueState | undefined;
  getDexPool(id: string): DexPoolState | undefined;
  getCexMarket(id: string): CexMarketState | undefined;
  has(id: string): boolean;
  size: number;

  getByChain(chainId: number): DexPoolState[];
  getByVenue(venue: VenueId): VenueState[]; // all pools on "uniswap:v3:1"
  getByToken(chainId: number, tokenAddress: string): DexPoolState[];
  getByPairId(pairId: PairId): VenueState[];
  getDexPoolsByPairId(pairId: PairId): DexPoolState[];
  getCexMarketsByPairId(pairId: PairId): CexMarketState[];

  onChange(listener: VenueChangeListener): () => void;
}

/** DEX pool ID: "chainId:poolAddress" e.g. "1:0xb4e16d0168..." */
export function dexPoolId(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`;
}

/** CEX market ID: "exchangeName:rawSymbol" e.g. "binance:ETHUSDC" */
export function cexMarketId(exchangeName: string, rawSymbol: string): string {
  return `${exchangeName}:${rawSymbol}`;
}
