// ================================================================================================
// CONFIGURATION
// ================================================================================================
import { WorkerDb } from '@/db';
import { appConfig } from '../config';
import type { ChainConfig } from '@/config/models';
import { Blockchain } from '@/core/blockchain';
import { CacheService } from '@/utils/cache-service';
import { EventBus } from '@/core/event-bus';
import { logger, printPool, safeStringify } from '@/utils';

const platformConfig = appConfig.platforms['ethereum'] as ChainConfig;
const cache = new CacheService(platformConfig.chainId);

if (!process.env.SCRIPTS_DATABASE_URL) throw new Error('SCRIPTS_DATABASE_URL not set in environment variables');
const db = new WorkerDb(process.env.SCRIPTS_DATABASE_URL, platformConfig.chainId);

// Core app services
const eventBus = new EventBus();
const blockchain = new Blockchain({ chainConfig: platformConfig, cache: cache, eventBus });

// ================================================================================================
// Main wrapper
// ================================================================================================
async function main() {
  const pools = await db.loadAllPools();
  logger.info(`Loaded ${pools.length} pools from DB`);

  let count = 0;
  let blacklistedCount = 0;
  const blacklistedPools = [];
  for (const pool of pools) {
    if (pool.state.isBlacklisted) {
      logger.info(`Pool ${printPool(pool.state)} is blacklisted, skipping`);
      blacklistedCount++;

      // whitelisting (uncomment if needed)
      // logger.info(`Unblacklisting pool ${pool.state.id} with pair ${pool.pairId} since it is already blacklisted`);
      // pool.state.isBlacklisted = false;
      // pool.state.error = null;
      // await db.upsertPool(pool.state, pool.source, true);
      continue;
    }

    if (pool.pairId === 'ETH:WETH' || pool.pairId === 'WETH:ETH') {
      logger.info(`Blacklisting pool ${pool.state.id} with pair ${pool.pairId}`);
      pool.state.isBlacklisted = true;
      pool.state.error = 'blacklisted due to known WETH/ETH pair issues';
      await db.upsertPool(pool.state, pool.source, true);
      count++;
      // continue;
    }

    const { token0, token1, key } = pool.state.tokenPair;
    if (token0.symbol === 'ETH' && token0.symbol === token1.symbol) {
      logger.info(`Pool ${pool.state.id} has identical token symbols (${token0.symbol}), blacklisting pool`);
      pool.state.isBlacklisted = true;
      pool.state.error = `blacklisted due to identical ${key} symbols`;
      await db.upsertPool(pool.state, pool.source, true);
      count++;
      // continue;
    }

    // if (pool.state.isBlacklisted) {
    //   blacklistedCount++;
    //   logger.info(`Pool ${printPool(pool.state)} is blacklisted, reason: ${pool.state.error}`);
    // }
  }

  // store blacklisted pools in a json file for reference
  // const fs = await import('fs/promises');
  // await fs.writeFile('./blacklisted-pools.json', safeStringify(blacklistedPools, 2));

  logger.info(`Blacklisted ${count} pools with WETH/ETH pair of ${pools.length} total pools`);
  logger.info(`Total blacklisted pools: ${blacklistedCount}`);
}

// Entry point
main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('❌ Fatal error:', { error });
    process.exit(1);
  })
  .finally(async () => {
    // Cleanup resources
    await db.destroy();
    await blockchain.cleanup();
  });
