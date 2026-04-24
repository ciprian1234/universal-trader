import type { DexPoolState } from '@/shared/data-model/layer1';

/**
 * PriceOracle — derives USD prices for all known tokens.
 * Fed by Layer 1 pool states. Consumed by Layer 2 (PairIndex) and API.
 */
export interface IPriceOracle {
  getUSDPrice(chainId: number, tokenAddress: string): number | undefined;
  getAllPrices(): Map<string, number>; // "chainId:tokenAddr" → USD price

  /** Called when pool states change — recalculates affected token prices */
  onPoolUpdated(pools: DexPoolState[]): void;
}

export class PriceOracle implements IPriceOracle {
  // "chainId:tokenAddress" → USD price
  private readonly prices = new Map<string, number>();

  // Known stablecoins (bootstrapping anchors)
  private readonly stablecoins = new Set<string>(); // "1:0xa0b8..." etc.

  constructor(stablecoins: Array<{ chainId: number; address: string }>) {
    for (const s of stablecoins) {
      this.stablecoins.add(`${s.chainId}:${s.address.toLowerCase()}`);
      this.prices.set(`${s.chainId}:${s.address.toLowerCase()}`, 1.0);
    }
  }

  getUSDPrice(chainId: number, tokenAddress: string): number | undefined {
    return this.prices.get(`${chainId}:${tokenAddress.toLowerCase()}`);
  }

  getAllPrices(): Map<string, number> {
    return this.prices;
  }

  /**
   * Recalculate prices for tokens in the updated pools.
   * Strategy: BFS from stablecoins through highest-liquidity pools.
   */
  onPoolUpdated(pools: DexPoolState[]): void {
    for (const pool of pools) {
      this.derivePrice(pool);
    }
  }

  private derivePrice(pool: DexPoolState): void {
    const key0 = `${pool.venue.chainId}:${pool.tokenPair.token0.address.toLowerCase()}`;
    const key1 = `${pool.venue.chainId}:${pool.tokenPair.token1.address.toLowerCase()}`;
    const price0 = this.prices.get(key0);
    const price1 = this.prices.get(key1);

    // If we know token0's price, derive token1's price (and vice versa)
    if (price0 !== undefined && pool.spotPrice0to1 > 0) {
      this.prices.set(key1, price0 / pool.spotPrice0to1);
    }
    if (price1 !== undefined && pool.spotPrice1to0 > 0) {
      this.prices.set(key0, price1 / pool.spotPrice1to0);
    }
  }
}
