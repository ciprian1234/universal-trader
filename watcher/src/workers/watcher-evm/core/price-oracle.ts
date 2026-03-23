import { createLogger } from '@/utils';
import type { DexPoolState } from '@/shared/data-model/layer1';
import type { TokenManager } from './token-manager';
import type { ChainConfig } from '@/config/models';
import type { TokenOnChain } from '@/shared/data-model/token';
import { ethers } from 'ethers';

type PriceOracleInput = {
  chainConfig: ChainConfig;
  tokenManager: TokenManager;
};

type DefiLlamaPriceResponse = {
  coins: Record<string, { price: number; confidence: number }>;
};

type PriceEntryAnchor = {
  token: TokenOnChain;
  priceUSD: number;
  source: 'anchor';
  updatedAt: number;
};

type PriceEntryDerived = {
  token: TokenOnChain;
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

  private anchorTokens: TokenOnChain[] = []; // for quick lookup of whether a token is an anchor token
  private readonly resolvedPrices = new Map<string, PriceEntry>(); // "address" → PriceEntry

  private readonly anchorTokensSource = 'defi-llama';
  private anchorAddressesQueryParam: string = ''; // defi-llama query param "chain:addr1,chain:addr2,..."
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
    this.anchorTokens = this.chainConfig.priceAnchorTokens.map((symbol) => {
      const anchorToken = this.tokenManager.findTokenBySymbol(symbol);
      if (!anchorToken) throw new Error('Price anchor token not registred');
      return anchorToken;
    });

    // construct the query param for fetching anchor tokens from defi-llama
    const prefix = this.chainConfig.name; // "ethereum"
    this.anchorAddressesQueryParam = this.anchorTokens.map((t) => `${prefix}:${t.address}`).join(',');

    // fetch initial anchor prices and start periodic updates
    await this.fetchAnchors();
    this.fetchIntervalId = setInterval(() => this.fetchAnchors(), 60_000); // fetch every 60 seconds
  }

  // ── External anchor fetch (called on init and periodically to update prices)
  async fetchAnchors(): Promise<void> {
    this.logger.info(`🌐 Fetching priceUSD of ${this.anchorTokens.length} anchor tokens from DeFiLlama...`);

    const res = await fetch(`https://coins.llama.fi/prices/current/${this.anchorAddressesQueryParam}`, {
      signal: AbortSignal.timeout(5_000),
    });
    const response = (await res.json()) as DefiLlamaPriceResponse;
    if (!response?.coins) throw new Error(`Failed to fetch data from DeFiLlama: ${JSON.stringify(response)}`);

    for (const t of this.anchorTokens) {
      const coinKey = `${this.chainConfig.name}:${t.address}`;
      const val = response.coins[coinKey];
      if (!val) throw new Error(`PriceUSD for anchor token ${t.symbol} (${t.address}) not found in response`);
      if (val.confidence < 0.5) this.logger.warn(`⚠️ Confidence of ${t.symbol} under 50% threshold:`, val);
      this.resolvedPrices.set(t.address, {
        token: t,
        priceUSD: val.price,
        source: 'anchor',
        updatedAt: Date.now(),
      });
    }

    // set native ETH price as well => derive from WETH
    const weth = this.tokenManager.findTokenBySymbol('WETH');
    const eth = this.tokenManager.getToken(ethers.ZeroAddress);
    if (!weth || !eth) throw new Error('WETH or ETH token not found for price anchoring');
    const resolvedWETHPrice = this.resolvedPrices.get(weth.address)!;
    this.resolvedPrices.set(eth.address, {
      token: eth,
      priceUSD: resolvedWETHPrice.priceUSD, // 1 ETH = 1 WETH
      source: 'anchor',
      updatedAt: Date.now(),
    });

    // log prices after fetching
    this.logPrices();
  }

  // PriceUSD derived from pool
  // if both tokens are anchors => no need to derive
  // if both p0 and p1 are missing => can't derive
  // example:
  // pool: WETH-NEW_TOKEN, lets say (1 WETH = 50 NEW_TOKEN) <=> (1 NEW_TOKEN = 0.02 WETH)
  // if we know WETH = $2000 => NEW_TOKEN_USD = 0.02 * $2000 = $40
  deriveFromPool(pool: DexPoolState) {
    const t0 = pool.tokenPair.token0;
    const t1 = pool.tokenPair.token1;
    let p0 = this.resolvedPrices.get(t0.address); // token0 price in USD (or undefined if not derived yet or not anchor)
    let p1 = this.resolvedPrices.get(t1.address); // token1 price in USD (or undefined if not derived yet or not anchor)

    // if both prices are missing we can't derive
    if (p0 === undefined && p1 === undefined)
      throw new Error(`Can't derive prices for ${pool.tokenPair.key} - poolId: ${pool.id}`);

    const poolLiquidityUSD = this.estimatePoolLiquidityUSD(pool);

    // A: update/derive p0 (from p1)
    if (p1 !== undefined) {
      if (p0 === undefined) {
        // first time seeing p0 — derive it
        p0 = this.setPriceEntryDerived(t0, p1.priceUSD * pool.spotPrice0to1, pool.id, poolLiquidityUSD);
      } else if (p0.source !== 'anchor' && poolLiquidityUSD > p0.derivedFrom.poolLiquidityUSD) {
        // p0 is derived — only update if current pool has more liquidity (higher confidence price)
        p0 = this.setPriceEntryDerived(t0, p1.priceUSD * pool.spotPrice0to1, pool.id, poolLiquidityUSD);
      }
      // p0.source === 'anchor' => skip — anchor prices come from DeFiLlama only
      // poolLiquidityUSD <= p0.poolLiquidityUSD => skip — previous pool was more liquid, keep that price
    }

    // B: update/derive p1 (from p0)
    if (p0 !== undefined) {
      if (p1 === undefined) {
        // first time seeing p1 — derive it
        p1 = this.setPriceEntryDerived(t1, p0.priceUSD * pool.spotPrice1to0, pool.id, poolLiquidityUSD);
      } else if (p1.source !== 'anchor' && poolLiquidityUSD > p1.derivedFrom.poolLiquidityUSD) {
        // p1 is derived — only update if current pool has more liquidity
        p1 = this.setPriceEntryDerived(t1, p0.priceUSD * pool.spotPrice1to0, pool.id, poolLiquidityUSD);
      }
      // p1.source === 'anchor' => skip — anchor prices come from DeFiLlama only
      // poolLiquidityUSD <= p1.poolLiquidityUSD => skip — previous pool was more liquid, keep that price
    }
    return { liquidityUSD: poolLiquidityUSD };
  }

  // helper to create PriceEntryDerived
  private setPriceEntryDerived(
    token: TokenOnChain,
    priceUSD: number,
    poolId: string,
    poolLiquidityUSD: number,
  ): PriceEntryDerived {
    const newPriceEntry: PriceEntryDerived = {
      token,
      priceUSD,
      source: 'derived',
      updatedAt: Date.now(),
      derivedFrom: {
        poolId,
        poolLiquidityUSD,
      },
    };
    this.resolvedPrices.set(token.address, newPriceEntry);
    return newPriceEntry;
  }

  // ── Query ────────────────────────────────────────────────────────────
  getPriceUSD(address: string) {
    const priceEntry = this.resolvedPrices.get(address);
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
    for (const t of this.anchorTokens) {
      const p = this.resolvedPrices.get(t.address)!; // prices for anchor tokens should always be available
      this.logger.info(` • ${t.symbol}: $${p.priceUSD} (source: ${this.anchorTokensSource})`);
    }
    this.logger.info(`Resolved priceUSD count: ${this.resolvedPrices.size}/${this.tokenManager.getAllTokens().size} tokens`);
  }

  /**
   * 💵 CALCULATE USD VALUE: Get USD value of token amount
   */
  calculateUSDValue(address: string, rawAmount: bigint): number {
    const priceEntry = this.resolvedPrices.get(address);
    if (!priceEntry) throw new Error(`Token ${address} not registered or price not available`);

    const humanAmount = Number(ethers.formatUnits(rawAmount, priceEntry.token.decimals));
    return humanAmount * priceEntry.priceUSD;
  }
}
