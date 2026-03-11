/**
 * 🎯 TOKEN MANAGER: Central token information and price management
 */
import { createLogger, type Logger } from '@/utils';
import type { TokenPairOnChain } from '@/shared/data-model/token';
import type { WorkerDb } from '../db';
import type { EventBus, PoolStateEvent } from './event-bus';
import type { ChainConfig } from '@/config/models';
import type { TokenManager } from './token-manager';
import type { DexManager } from './dex-manager';
import { tr } from 'zod/locales';

export interface TokenPairManagerInput {
  db: WorkerDb;
  chainConfig: ChainConfig;
  eventBus: EventBus;
  tokenManager: TokenManager;
  dexManager: DexManager;
}

export type TokenPairInfo = {
  tokenPair: TokenPairOnChain;
  isDiscovered: boolean; // whether we have discovered at least one pool for this pair
  totalLiquidityUSD: number; // total liquidity across all pools for this pair
  poolsLiquidity: Map<string, number>; // liquidity of each pool for this pair, poolId => liquidityUSD
  numberOfEvents: number; // total number of events processed for this pair
};

// ================================================================================================
// TOKEN PAIR MANAGER CLASS
// ================================================================================================

export class TokenPairManager {
  private readonly logger: Logger;
  private readonly db: WorkerDb;
  private readonly chainConfig: ChainConfig;
  private readonly eventBus: EventBus;
  private readonly tokenManager: TokenManager;
  private readonly dexManager: DexManager;

  // TokenPair registry for quick lookup of trading pairs
  private tokenPairs: Map<string, TokenPairInfo> = new Map(); // key is `${token0.symbol}-${token1.symbol}` (token0/1 are ordered by address)

  constructor(input: TokenPairManagerInput) {
    this.logger = createLogger(`[${input.chainConfig.name}.token-pair-manager]`);
    this.db = input.db;
    this.chainConfig = input.chainConfig;
    this.eventBus = input.eventBus;
    this.tokenManager = input.tokenManager;
    this.dexManager = input.dexManager;

    // set interval to display token pairs stats every 30 seconds for monitoring purposes
    setInterval(() => {
      this.displayTokenPairs();
    }, 30_000);
  }

  // ================================================================================================
  // HANDLE POOL STATE EVENTS
  // ================================================================================================
  async handlePoolStateEvent(event: PoolStateEvent) {
    const { pool } = event;

    let tokenPairInfo = this.tokenPairs.get(pool.tokenPair.key);
    if (!tokenPairInfo) {
      // new tokenPair
      tokenPairInfo = {
        tokenPair: pool.tokenPair,
        isDiscovered: false,
        totalLiquidityUSD: pool.totalLiquidityUSD,
        poolsLiquidity: new Map([[pool.id, pool.totalLiquidityUSD]]),
        numberOfEvents: 1,
      };
      this.tokenPairs.set(pool.tokenPair.key, tokenPairInfo);

      if (pool.totalLiquidityUSD >= 100_000) {
        tokenPairInfo.isDiscovered = true;
        await this.dexManager.handlePoolsDiscoveryForTokenPair(pool.tokenPair, pool.id); // trigger pool discovery for this tokenPair
        // REMINDER: discover other TokenPair combinations with the new token?
      } else {
        this.logger.info(
          `Skipping creation of token pair ${pool.tokenPair.key} due to low liquidity (${pool.totalLiquidityUSD} USD)`,
        );
      }
    } else {
      // => existing tokenPair, update stats
      tokenPairInfo.numberOfEvents += 1;
      tokenPairInfo.poolsLiquidity.set(pool.id, pool.totalLiquidityUSD);
      tokenPairInfo.totalLiquidityUSD = 0; // reset total liquidity before recalculating
      for (const liquidity of tokenPairInfo.poolsLiquidity.values()) tokenPairInfo.totalLiquidityUSD += liquidity;

      // If we haven't marked this pair as discovered yet, check if it meets the criteria now
      if (!tokenPairInfo.isDiscovered && tokenPairInfo.totalLiquidityUSD >= 100_000) {
        tokenPairInfo.isDiscovered = true;
        await this.dexManager.handlePoolsDiscoveryForTokenPair(tokenPairInfo.tokenPair, pool.id); // discover pools for the new trading pair
      }
    }
  }

  // ================================================================================================
  // TOKEN PAIR MANAGEMENT
  // ================================================================================================
  /**
   * Create token pairs between all discovery tokens
   * emits event for new token pairs which triggers pool discovery in DexManager
   */
  async createTokenPairsBetweenDiscoveryTokens() {
    for (const symbol0 of this.chainConfig.discoveryTokens) {
      for (const symbol1 of this.chainConfig.discoveryTokens) {
        const token0 = this.tokenManager.findTokenBySymbol(symbol0);
        const token1 = this.tokenManager.findTokenBySymbol(symbol1);
        if (!token0 || !token1) throw new Error(`Discovery tokens ${symbol0} or ${symbol1} not found in registry`);
        if (token0.address === token1.address) continue; // Skip self-pairs
        // Enforce canonical order to avoid duplicates
        if (token0.address < token1.address) {
          const key = `${token0.symbol}-${token1.symbol}`;
          if (this.tokenPairs.has(key)) continue; // Skip if pair already exists
          const tokenPair: TokenPairOnChain = { key, token0, token1 };
          this.tokenPairs.set(key, {
            tokenPair,
            isDiscovered: true, // discovery token pairs are considered discovered by default
            totalLiquidityUSD: 0,
            poolsLiquidity: new Map(),
            numberOfEvents: 0,
          });
          await this.dexManager.handlePoolsDiscoveryForTokenPair(tokenPair); // trigger pool discovery for this tokenPair
          this.eventBus.emitTokenPairRegistered(tokenPair); // Emit event for new token pair
        }
      }
    }
  }

  /**
   * Create token pairs between some input token and all discovery tokens
   * emits event for new token pairs which triggers pool discovery in DexManager
   */
  // createTokenPairsForNewToken(newToken: TokenOnChain) {
  //   // TBD: improve this logic in future:
  //   // - create token pairs only if some criteria are met to avoid unnecessary pool discoveries
  //   // - also cache token pairs stats to avoid creating pairs that are unlikely to be liquid (e.g. low market cap tokens)
  //   for (const discoverySymbol of this.chainConfig.discoveryTokens) {
  //     const discoveryToken = this.tokenManager.findTokenBySymbol(discoverySymbol)!;
  //     if (newToken.address === discoveryToken.address) continue; // Skip self-pair

  //     // Enforce canonical order to avoid duplicates
  //     const [token0, token1] =
  //       newToken.address < discoveryToken.address ? [newToken, discoveryToken] : [discoveryToken, newToken];
  //     const key = `${token0.symbol}-${token1.symbol}`;
  //     if (this.tokenPairs.has(key)) {
  //       this.logger.warn(`Token pair ${key} already exists, skipping creation`);
  //       continue; // Skip if pair already exists
  //     }
  //     const tokenPair: TokenPairOnChain = { key, token0, token1 };
  //     this.tokenPairs.set(key, tokenPair);
  //     this.eventBus.emitTokenPairRegistered(tokenPair); // Emit event for new token pair
  //     await this.dexManager.handlePoolsDiscoveryForTokenPair(tokenPair); // discover pools for the new trading pair
  //   }
  // }

  // ================================================================================================
  // HELPERS
  // ================================================================================================

  displayTokenPairs() {
    this.logger.info(`Current token pairs:`);
    for (const tokenPairInfo of this.tokenPairs.values()) {
      this.logger.info(
        ` • ${tokenPairInfo.tokenPair.key} (Pools: ${tokenPairInfo.poolsLiquidity.size}) | Discovered: ${tokenPairInfo.isDiscovered} | Total Liquidity: ${tokenPairInfo.totalLiquidityUSD} USD | Events: ${tokenPairInfo.numberOfEvents}`,
      );
    }
  }
}
