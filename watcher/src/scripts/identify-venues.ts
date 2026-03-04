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
import { DexRegistry } from '@/workers/watcher-evm/core/dex-registry';

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

const dexRegistry = new DexRegistry({
  chainConfig: platformConfig,
  blockchain: blockchain,
  tokenManager: tokenManager,
  db,
});

// ================================================================================================
// Main wrapper
// ================================================================================================
async function main() {
  await init();
  const pools = await db.loadAllPools();
  console.log(`Loaded ${pools.length} pools from DB`);

  for (const pool of pools) {
    const identifiedVenueName = dexRegistry.identifyVenueNameForPool(pool.state);
    console.log(`Pool ${pool.state.id} identified as venue: ${identifiedVenueName} (old:${pool.state.venue.name})`);
    // update pool venue in DB if it was previously unknown
    if (pool.venueName === 'unknown' && identifiedVenueName !== 'unknown') {
      pool.state.venue.name = identifiedVenueName;
      await db.upsertPool(pool.state, pool.source, true);
      console.log(`Updated pool ${pool.state.id} venue to ${identifiedVenueName} in DB`);
    }
  }
}

async function init() {
  // init cache
  await cache.load();
  // await tokenManager.init(); // load tokens from DB and trusted tokens from coingecho
  dexRegistry.init(); // init contracts for dex venues
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
