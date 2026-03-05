// ================================================================================================
// CONFIGURATION
// ================================================================================================
import { WorkerDb } from '@/workers/watcher-evm/db';
import { appConfig } from '../config';
import type { ChainConfig } from '@/config/models';
import { Blockchain } from '@/workers/watcher-evm/core/blockchain';
import { createLogger, safeStringify } from '@/utils';
import { CacheService } from '@/utils/cache-service';
import { TokenManager } from '@/workers/watcher-evm/core/token-manager';
import { EventBus } from '@/workers/watcher-evm/core/event-bus';
import { PriceOracle } from '@/workers/watcher-evm/core/price-oracle';

const platformConfig = appConfig.platforms['ethereum'] as ChainConfig;

const cache = new CacheService(platformConfig.chainId);
const db = new WorkerDb(platformConfig.databaseUrl, platformConfig.chainId);
const eventBus = new EventBus({ logger: createLogger(`[event-bus]`) });

// Core app services
const blockchain = new Blockchain({
  chainId: platformConfig.chainId,
  chainName: platformConfig.name,
  providerURL: platformConfig.providerRpcUrl,
  cache: cache,
  logger: createLogger(`[blockchain]`),
});

// create token manager
const tokenManager = new TokenManager({
  chainConfig: platformConfig,
  blockchain: blockchain,
  eventBus: eventBus,
  db,
});

const priceOracle = new PriceOracle({
  chainConfig: platformConfig,
  tokenManager: tokenManager,
});

// ================================================================================================
// Main script code
// ================================================================================================
async function main() {
  // init
  await cache.load();
  await tokenManager.init(); // load tokens from DB and trusted tokens from coingecko

  const pools = await db.loadAllPools();
  const allPools = pools.map((storedPool) => storedPool.state);

  // ensure all DB tokens are registered in token manager
  const tokens = await db.loadAllTokens();
  for (const token of tokens) await tokenManager.ensureTokenRegistered(token.address, 'address');

  // init price oracle after all tokens are registered
  await priceOracle.init(); // fetch initial anchor prices and start periodic updates

  // Print all anchor prices
  priceOracle.logPrices();

  // derive token prices from all pools
  for (const pool of allPools) {
    try {
      priceOracle.deriveFromPool(pool);
    } catch (error: any) {
      console.warn(`Failed to derive prices on ${pool.tokenPair.key} - poolId: ${pool.id}`, error);
    }
  }

  // Print all anchor prices
  priceOracle.logPrices();

  // print pool liquidity for all pools
  for (const pool of allPools) {
    const venueName = pool.venue.name;
    const liquidity = priceOracle.estimatePoolLiquidityUSD(pool);
    console.log(`Pool ${pool.id} ${venueName} ${pool.tokenPair.key} liquidity: $${liquidity.toFixed(4)}`);
  }
}

// Entry point
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  })
  .finally(async () => {
    // Cleanup resources
    await db.destroy();
    await blockchain.cleanup();
    priceOracle.destroy();
  });
