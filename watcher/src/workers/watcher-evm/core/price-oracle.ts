import { createLogger } from '@/utils/logger';
import type { DexPoolState } from '@/shared/data-model/layer1';
import type { TokenManager } from './token-manager';

const logger = createLogger('[PriceOracle]');

type PriceoOracleInput = {
  chainId: number;
  tokenManager: TokenManager;
};

// Anchors: tokens whose prices we fetch externally
// "chainId:address" → true
const ANCHOR_ADDRESSES: Record<number, string[]> = {
  1: [
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', // WBTC
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
    '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
    '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
  ],
};

// DeFiLlama chain prefix
const CHAIN_PREFIX: Record<number, string> = {
  1: 'ethereum',
  42161: 'arbitrum',
  10: 'optimism',
  8453: 'base',
};

export interface PriceEntry {
  priceUSD: number;
  source: 'anchor' | 'derived';
  derivedVia?: string; // poolId used to derive
  updatedAt: number;
}

export class PriceOracle {
  private readonly chainId: number;
  private readonly tokenManager: TokenManager;
  // "chainId:address" → PriceEntry
  private readonly prices = new Map<string, PriceEntry>();

  constructor(input: PriceoOracleInput) {
    this.chainId = input.chainId;
    this.tokenManager = input.tokenManager;
    // Hardcode stablecoin anchors — no fetch needed
    const stablecoins =
      ANCHOR_ADDRESSES[this.chainId]?.filter((a) =>
        ['usdc', 'usdt', 'dai', 'frax', 'lusd'].some(
          (s) => this.prices.has(this.key(a)), // skip if already fetched
        ),
      ) ?? [];

    // Pre-seed known stablecoins as $1.00
    const STABLECOIN_ADDRESSES: Record<number, string[]> = {
      1: [
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
        '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
        '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
        '0x853d955acef822db058eb8505911ed77f175b99e', // FRAX
      ],
    };

    for (const address of STABLECOIN_ADDRESSES[this.chainId] ?? []) {
      this.prices.set(this.key(address), {
        priceUSD: 1.0,
        source: 'anchor',
        updatedAt: Date.now(),
      });
    }
  }

  // ── External anchor fetch (only ~5 tokens) ───────────────────────────

  async fetchAnchors(): Promise<void> {
    const addresses = ANCHOR_ADDRESSES[this.chainId];
    if (!addresses?.length) return;

    const prefix = CHAIN_PREFIX[this.chainId];
    if (!prefix) return;

    const coins = addresses.map((a) => `${prefix}:${a}`).join(',');

    try {
      const res = await fetch(`https://coins.llama.fi/prices/current/${coins}`, {
        signal: AbortSignal.timeout(5_000),
      });
      const data = (await res.json()) as {
        coins: Record<string, { price: number; confidence: number }>;
      };

      console.log('Anchor price data:', data);

      for (const [coinKey, val] of Object.entries(data.coins)) {
        if (val.confidence < 0.5) continue;
        const address = coinKey.split(':')[1];
        this.prices.set(this.key(address), {
          priceUSD: val.price,
          source: 'anchor',
          updatedAt: Date.now(),
        });
      }

      logger.info(`Anchors fetched: ${Object.keys(data.coins).length} prices`);
    } catch (err) {
      logger.warn('Failed to fetch anchor prices:', err);
    }
  }

  // ── Derive all prices from pool states ───────────────────────────────

  /**
   * BFS from known prices → derive unknown token prices through pools.
   * Call this after every venue-state-batch update.
   * Returns addresses whose prices changed.
   */
  deriveFromPools(pools: DexPoolState[]): string[] {
    // Build adjacency: tokenAddress → pools it appears in
    const adjacency = new Map<string, DexPoolState[]>();
    for (const pool of pools) {
      const t0 = pool.tokenPair.token0.address.toLowerCase();
      const t1 = pool.tokenPair.token1.address.toLowerCase();
      if (!adjacency.has(t0)) adjacency.set(t0, []);
      if (!adjacency.has(t1)) adjacency.set(t1, []);
      adjacency.get(t0)!.push(pool);
      adjacency.get(t1)!.push(pool);
    }

    const changed: string[] = [];

    // BFS queue — start from all tokens with known prices
    const queue: string[] = [];
    for (const [k] of this.prices) {
      const address = k.split(':')[1];
      queue.push(address);
    }

    const visited = new Set<string>(queue);

    while (queue.length > 0) {
      const knownAddress = queue.shift()!;
      const knownPrice = this.prices.get(this.key(knownAddress))!.priceUSD;
      const neighborPools = adjacency.get(knownAddress) ?? [];

      for (const pool of neighborPools) {
        if (pool.spotPrice0to1 === 0 || pool.spotPrice1to0 === 0) continue; // no dynamic data yet

        const t0 = pool.tokenPair.token0.address.toLowerCase();
        const t1 = pool.tokenPair.token1.address.toLowerCase();

        const [unknownAddress, derivedPrice] =
          knownAddress === t0
            ? [t1, knownPrice * pool.spotPrice0to1] // price of t1 in USD
            : [t0, knownPrice * pool.spotPrice1to0]; // price of t0 in USD

        if (visited.has(unknownAddress)) continue;
        visited.add(unknownAddress);
        queue.push(unknownAddress);

        const existing = this.prices.get(this.key(unknownAddress));
        if (existing?.priceUSD === derivedPrice) continue;

        this.prices.set(this.key(unknownAddress), {
          priceUSD: derivedPrice,
          source: 'derived',
          derivedVia: pool.id,
          updatedAt: Date.now(),
        });
        changed.push(unknownAddress);
      }
    }

    return changed;
  }

  // ── Query ────────────────────────────────────────────────────────────

  getPrice(address: string): number | undefined {
    return this.prices.get(this.key(address))?.priceUSD;
  }

  getEntry(address: string): PriceEntry | undefined {
    return this.prices.get(this.key(address));
  }

  estimatePoolLiquidityUSD(pool: DexPoolState): number {
    const p0 = this.getPrice(pool.tokenPair.token0.address);
    const p1 = this.getPrice(pool.tokenPair.token1.address);
    const { token0, token1 } = pool.tokenPair;

    if (p0 !== undefined) {
      const r0 = Number(pool.reserve0) / 10 ** token0.decimals;
      return r0 * p0 * 2; // × 2 because balanced pool
    }
    if (p1 !== undefined) {
      const r1 = Number(pool.reserve1) / 10 ** token1.decimals;
      return r1 * p1 * 2;
    }
    return 0;
  }

  private key(address: string): string {
    return `${this.chainId}:${address.toLowerCase()}`;
  }
}
