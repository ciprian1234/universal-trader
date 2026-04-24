// ================================================================================================
// CONFIGURATION
// ================================================================================================
import { WorkerDb } from '@/db';
import { appConfig } from '../config';
import type { ChainConfig } from '@/config/models';
import { Blockchain } from '@/core/blockchain';
import { createLogger } from '@/utils';
import { CacheService } from '@/utils/cache-service';
import { TokenManager } from '@/core/token-manager';
import { EventBus } from '@/core/event-bus';
import { DexManager } from '@/core/dex-manager';

const platformConfig = appConfig.platforms['ethereum'] as ChainConfig;

const cache = new CacheService(platformConfig.chainId);
const db = new WorkerDb(platformConfig.databaseUrl, platformConfig.chainId);
const eventBus = new EventBus();

// Core app services
const blockchain = new Blockchain({ chainConfig: platformConfig, cache: cache });

// // create token manager
// const tokenManager = new TokenManager({
//   chainConfig: platformConfig,
//   blockchain: blockchain,
//   eventBus: eventBus,
//   db,
// });

// const dexManager = new DexManager({
//   chainConfig: platformConfig,
//   blockchain: blockchain,
//   tokenManager: tokenManager,
//   db,
// });

// ================================================================================================
// Main wrapper
// ================================================================================================
async function main() {
  await init();
  const pools = await db.loadAllPools();
  console.log(`Loaded ${pools.length} pools from DB`);

  for (const pool of pools) {
    const identifiedVenueName = DEX_ADAPTER.identifyVenueNameForPool(pool.state, platformConfig.dexConfigs);
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
  DEX_ADAPTER.initAllDexConfigContracts(blockchain, platformConfig.dexConfigs); // init contracts for dex venues
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
