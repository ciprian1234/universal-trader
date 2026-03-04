// ================================================================================================
// CONFIGURATION
// ================================================================================================
import { WorkerDb } from '@/workers/watcher-evm/db';
import { appConfig } from '../config';
import type { ChainConfig } from '@/config/models';
import { Blockchain } from '@/workers/watcher-evm/core/blockchain';
import { createLogger } from '@/utils';
import { CacheService } from '@/utils/cache-service';
import { TokenManager } from '@/workers/watcher-evm/core/token-manager';
import { EventBus } from '@/workers/watcher-evm/core/event-bus';
import { DexManager } from '@/workers/watcher-evm/core/dex-manager';
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
  logger: createLogger(`[token-manager]`),
  blockchain: blockchain,
  eventBus: eventBus,
  db,
});

const dexManager = new DexManager({
  blockchain: blockchain,
  tokenManager: tokenManager,
  logger: createLogger(`[dex-registry]`),
});

const priceOracle = new PriceOracle({
  chainId: platformConfig.chainId,
  tokenManager: tokenManager,
});

// ================================================================================================
// Main script code
// ================================================================================================
async function main() {
  // init
  await cache.load();
  await tokenManager.init(); // load tokens from DB and trusted tokens from coingecho
  dexManager.init(platformConfig); // init contracts for dex venues

  const pools = await db.loadAllPools();
  console.log(`Loaded ${pools.length} pools from DB`);

  // fetch root prices
  await priceOracle.fetchAnchors();
  const allPools = pools.map((storedPool) => storedPool.state);

  // derive all possible prices from pool states + anchors
  priceOracle.deriveFromPools(allPools);

  // For demo, print all known prices
  console.log('Known token prices:');
  for (const [addr, token] of tokenManager.getAllTokens().entries()) {
    const entry = priceOracle.getEntry(addr);
    if (!entry) {
      console.log(`  ${token?.symbol} → price unknown`);
    } else {
      console.log(`  ${token?.symbol} → $${entry.priceUSD} (source: ${entry.source})`);
    }
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
  });
