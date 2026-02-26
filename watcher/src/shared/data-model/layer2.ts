import type { PairId } from './token';
import type { CexVenue, DexVenue, Venue } from './layer1';

// ════════════════════════════════════════════════════════════
// VENUE PRICING — a single venue's current pricing for a pair
// ════════════════════════════════════════════════════════════

interface VenuePricingBase {
  venueStateId: string; // reference back to Layer 1
  venue: Venue;
  midPrice: number; // universal comparator across all venue types => the price of baseSymbol in terms of quoteSymbol (e.g. 2500 for ETH:USDC)
  liquidityUSD: number;
  lastUpdatedAt: number;
}

interface DexVenuePricing extends VenuePricingBase {
  venue: DexVenue;
  // midPrice inherited — for DEX this is the spot price (marginal price at zero size)
  blockNumber: number;
  feeBps: number; // pool fee — the DEX's inherent "spread"
}

interface CexVenuePricing extends VenuePricingBase {
  venue: CexVenue;
  bidPrice: number;
  askPrice: number;
  bidQty: number;
  askQty: number;
}

type VenuePricing = DexVenuePricing | CexVenuePricing;

// ════════════════════════════════════════════════════════════
// TRADING PAIR — all venues offering a canonical pair
// ════════════════════════════════════════════════════════════

interface TradingPair {
  id: PairId; // "ETH:USDC"
  baseSymbol: string; // "ETH"
  quoteSymbol: string; // "USDC"
  venues: VenuePricing[]; // ← reads naturally: "a trading pair has venues with pricing"
  // bestDexSpot: DexVenuePricing | null;
  // bestCexBid: CexVenuePricing | null;
  // bestCexAsk: CexVenuePricing | null;
  // crossVenueSpreadBps: number | null;
  lastUpdatedAt: number;
}

// ════════════════════════════════════════════════════════════
// PAIR INDEX — Layer 2 query interface
// ════════════════════════════════════════════════════════════

interface IPairIndex {
  getPair(pairId: PairId): TradingPair | undefined;
  getAllPairs(): TradingPair[];
  getPairsForSymbol(symbol: string): TradingPair[];

  getBestPrice(pairId: PairId): { bid: number; ask: number; mid: number } | undefined;

  pairCount: number;
  totalVenueCount: number;
}
