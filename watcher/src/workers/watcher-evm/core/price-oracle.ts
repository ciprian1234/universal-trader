import { createLogger } from '@/utils/logger';
import type { DexPoolState } from '@/shared/data-model/layer1';
import type { TokenManager } from './token-manager';
import type { ChainConfig } from '@/config/models';

type PriceOracleInput = {
  chainConfig: ChainConfig;
  tokenManager: TokenManager;
};

type PriceEntryAnchor = {
  priceUSD: number;
  source: 'anchor';
  updatedAt: number;
};

type PriceEntryDerived = {
  priceUSD: number;
  source: 'derived';
  updatedAt: number;
  derivedFrom: {
    poolId: string;
    poolLiquidityUSD: number;
  };
};

type PriceEntry = PriceEntryAnchor | PriceEntryDerived;

export class PriceOracle {
  private readonly logger;
  private readonly chainConfig: ChainConfig;
  private readonly tokenManager: TokenManager;
  private readonly prices = new Map<string, PriceEntry>(); // "address" → PriceEntry
  private anchorAddresesSet = new Set<string>(); // for quick lookup of whether a token is an anchor token
  private anchorAddressesQueryParam: string = ''; // "chain:addr1,chain:addr2,..."
  private fetchIntervalId: NodeJS.Timeout | null = null;

  constructor(input: PriceOracleInput) {
    this.logger = createLogger(`[${input.chainConfig.name}.PriceOracle]`);
    this.chainConfig = input.chainConfig;
    this.tokenManager = input.tokenManager;
  }

  destroy(): void {
    if (this.fetchIntervalId) {
      clearInterval(this.fetchIntervalId);
      this.fetchIntervalId = null;
    }
  }

  async init(): Promise<void> {
    // prepare anchor token address set and query param
    this.anchorAddresesSet = new Set(
      this.chainConfig.priceAnchorTokens.map((symbol) => {
        const anchorToken = this.tokenManager.findTokenBySymbol(symbol);
        if (!anchorToken) throw new Error('Price anchor token not registred');
        return anchorToken.address;
      }),
    );

    // construct the query param for fetching anchor tokens from defi-llama
    const prefix = this.chainConfig.name; // "ethereum"
    this.anchorAddressesQueryParam = Array.from(this.anchorAddresesSet)
      .map((addr) => `${prefix}:${addr}`)
      .join(',');

    // fetch initial anchor prices and start periodic updates
    await this.fetchAnchors();
    this.fetchIntervalId = setInterval(() => this.fetchAnchors(), 60_000); // fetch every 60 seconds
  }

  // ── External anchor fetch (called on init and periodically to update prices)
  async fetchAnchors(): Promise<void> {
    this.logger.info('Fetching anchor token prices');
    try {
      const res = await fetch(`https://coins.llama.fi/prices/current/${this.anchorAddressesQueryParam}`, {
        signal: AbortSignal.timeout(5_000),
      });
      const data = (await res.json()) as {
        coins: Record<string, { price: number; confidence: number }>;
      };

      for (const [coinKey, val] of Object.entries(data.coins)) {
        if (val.confidence < 0.5) this.logger.warn(`Confidedence of ${coinKey} under 50% threshold:`, val);
        const address = coinKey.split(':')[1];
        this.prices.set(address.toLowerCase(), {
          priceUSD: val.price,
          source: 'anchor',
          updatedAt: Date.now(),
        });
      }
    } catch (err) {
      this.logger.warn('Failed to fetch anchor prices:', err);
    }
  }

  // PriceUSD derived from pool
  // if both tokens are anchors => no need to derive
  // if both p0 and p1 are missing => can't derive
  // example:
  // pool: WETH-NEW_TOKEN, lets say (1 WETH = 50 NEW_TOKEN) <=> (1 NEW_TOKEN = 0.02 WETH)
  // if we know WETH = $2000 => NEW_TOKEN_USD = 0.02 * $2000 = $40
  deriveFromPool(pool: DexPoolState) {
    const t0Addr = pool.tokenPair.token0.address;
    const t1Addr = pool.tokenPair.token1.address;
    let p0 = this.prices.get(t0Addr); // token0 price in USD (or undefined if not derived yet or not anchor)
    let p1 = this.prices.get(t1Addr); // token1 price in USD (or undefined if not derived yet or not anchor)

    // if both prices are missing we can't derive
    if (p0 === undefined && p1 === undefined)
      throw new Error(`Can't derive prices for ${pool.tokenPair.key} - poolId: ${pool.id}`);

    const poolLiquidityUSD = this.estimatePoolLiquidityUSD(pool);

    // A: update/derive p0 (from p1)
    if (p1 !== undefined) {
      if (p0 === undefined) {
        // first time seeing p0 — derive it
        p0 = this.setPriceEntryDerived(t0Addr, p1.priceUSD * pool.spotPrice0to1, pool.id, poolLiquidityUSD);
      } else if (p0.source !== 'anchor' && poolLiquidityUSD > p0.derivedFrom.poolLiquidityUSD) {
        // p0 is derived — only update if current pool has more liquidity (higher confidence price)
        p0 = this.setPriceEntryDerived(t0Addr, p1.priceUSD * pool.spotPrice0to1, pool.id, poolLiquidityUSD);
      }
      // p0.source === 'anchor' => skip — anchor prices come from DeFiLlama only
      // poolLiquidityUSD <= p0.poolLiquidityUSD => skip — previous pool was more liquid, keep that price
    }

    // B: update/derive p1 (from p0)
    if (p0 !== undefined) {
      if (p1 === undefined) {
        // first time seeing p1 — derive it
        p1 = this.setPriceEntryDerived(t1Addr, p0.priceUSD * pool.spotPrice1to0, pool.id, poolLiquidityUSD);
      } else if (p1.source !== 'anchor' && poolLiquidityUSD > p1.derivedFrom.poolLiquidityUSD) {
        // p1 is derived — only update if current pool has more liquidity
        p1 = this.setPriceEntryDerived(t1Addr, p0.priceUSD * pool.spotPrice1to0, pool.id, poolLiquidityUSD);
      }
      // p1.source === 'anchor' => skip — anchor prices come from DeFiLlama only
      // poolLiquidityUSD <= p1.poolLiquidityUSD => skip — previous pool was more liquid, keep that price
    }
    return { liquidityUSD: poolLiquidityUSD };
  }

  // helper to create PriceEntryDerived
  private setPriceEntryDerived(tokenAddr: string, priceUSD: number, poolId: string, poolLiquidityUSD: number): PriceEntryDerived {
    const newPriceEntry: PriceEntryDerived = {
      priceUSD,
      source: 'derived',
      updatedAt: Date.now(),
      derivedFrom: {
        poolId,
        poolLiquidityUSD,
      },
    };
    this.prices.set(tokenAddr, newPriceEntry);
    return newPriceEntry;
  }

  // ── Query ────────────────────────────────────────────────────────────
  getPriceUSD(address: string) {
    const priceEntry = this.prices.get(address);
    if (priceEntry !== undefined) return priceEntry.priceUSD;
    return undefined;
  }

  estimatePoolLiquidityUSD(pool: DexPoolState): number {
    const { token0, token1 } = pool.tokenPair;
    const p0 = this.getPriceUSD(token0.address);
    const p1 = this.getPriceUSD(token1.address);

    // distinguish "price unknown" from "reserve is zero"
    const v0 = p0 !== undefined ? (Number(pool.reserve0) / 10 ** token0.decimals) * p0 : undefined;
    const v1 = p1 !== undefined ? (Number(pool.reserve1) / 10 ** token1.decimals) * p1 : undefined;

    if (v0 !== undefined && v1 !== undefined) return v0 + v1; // both prices known — most accurate
    if (v0 !== undefined) return v0 * 2; // only t0 price known — assume balanced
    if (v1 !== undefined) return v1 * 2; // only t1 price known — assume balanced
    return 0; // no prices known — can't estimate
  }

  // log all prices
  logPrices(): void {
    this.logger.info('Anchor prices in USD:');
    for (const [addr, price] of this.prices.entries()) {
      const token = this.tokenManager.getToken(addr)!;
      this.logger.info(
        `- ${token.symbol} (${addr}): $${price.priceUSD} (source: ${price.source}, updatedAt: ${new Date(price.updatedAt).toISOString()})`,
      );
    }
  }
}
