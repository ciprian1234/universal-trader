import { TokenManager } from './token-manager';
import { Blockchain } from './blockchain';
import { createLogger, printPool, printPoolInEvent, type Logger } from '@/utils';
import type { ChainConfig } from '@/config/models';
import type { DexPoolState, DexVenueName } from '@/shared/data-model/layer1';
import type { TokenPairOnChain } from '@/shared/data-model/token';
import type { PoolEvent } from './interfaces';
import type { WorkerDb } from '../db';
import { DexAdapter } from './dex-adapters';
import type { PriceOracle } from './price-oracle';
import type { EventBus } from './event-bus';

type DexManagerInput = {
  chainConfig: ChainConfig;
  db: WorkerDb;
  eventBus: EventBus;
  blockchain: Blockchain;
  tokenManager: TokenManager;
  priceOracle: PriceOracle;
};

export class DexManager {
  private readonly logger: Logger;
  private chainConfig: ChainConfig;

  private readonly db: WorkerDb;
  private readonly eventBus: EventBus;
  private readonly blockchain: Blockchain;
  private readonly tokenManager: TokenManager;
  private readonly priceOracle: PriceOracle;
  private readonly dexAdapter: DexAdapter;

  // list of registred pools in the system, updated on discovery and on events
  private pools: Map<string, DexPoolState> = new Map();

  // used to process events in sequence for the same pool, avoiding multiple concurrent introspections for the same unknown pool
  private promiseChainsPoolEventUpdates: Map<string, Promise<void>> = new Map();

  constructor(input: DexManagerInput) {
    this.logger = createLogger(`[${input.chainConfig.name}.DexManager]`);
    this.chainConfig = input.chainConfig;

    this.db = input.db;
    this.eventBus = input.eventBus;
    this.blockchain = input.blockchain;
    this.tokenManager = input.tokenManager;
    this.priceOracle = input.priceOracle;
    this.dexAdapter = new DexAdapter({
      db: this.db,
      chainConfig: this.chainConfig,
      blockchain: this.blockchain,
      tokenManager: this.tokenManager,
      priceOracle: this.priceOracle,
    });
  }

  // ================================================================================================
  // INITIALIZATION AND MANAGEMENT
  // ================================================================================================
  async init() {
    await this.dexAdapter.init();
  }

  // ================================================================================================
  // EVENT HANDLERS
  // ================================================================================================
  handlePoolEvent(event: PoolEvent): void {
    // get the last promise for this poolId, or a resolved promise if none exists
    const prev = this.promiseChainsPoolEventUpdates.get(event.poolId) ?? Promise.resolve();

    const next = prev
      .then(() => this.processPoolEvent(event))
      .catch((error) => this.logger.error(`Error handling pool event`, { event, error }))
      .finally(() => {
        // if the current promise chain is the same as the one we just executed, remove it from the map
        // to prevent memory leaks; if it's different, it means another event for the same poolId was added while we were processing, so we keep it
        if (this.promiseChainsPoolEventUpdates.get(event.poolId) === next) {
          this.promiseChainsPoolEventUpdates.delete(event.poolId);
        }
      });

    this.promiseChainsPoolEventUpdates.set(event.poolId, next);
  }

  private async processPoolEvent(event: PoolEvent): Promise<void> {
    let pool = this.pools.get(event.poolId) ?? null;

    if (!pool) {
      pool = await this.dexAdapter.handleEventForUnknownPool(event);
      if (!pool) return void this.logger.error(`Unable to introspect pool from event`, { event });
    } else {
      pool = this.dexAdapter.updatePoolFromEvent(pool, event);
    }

    this.logger.debug(printPoolInEvent(pool, event)); // pool-event-log
    this.pools.set(pool.id, pool);
    this.eventBus.emitPoolStateUpsert({ pool }); // EMIT: pool-state-upsert
  }

  //
  // Called by TokenPairManager when a new tokenPair its registred
  //
  async handlePoolsDiscoveryForTokenPair(tokenPair: TokenPairOnChain, skipPoolId?: string): Promise<DexPoolState[]> {
    this.logger.info(`🔍 Starting discovery for new token pair: ${tokenPair.key}...`);
    const foundPools = await this.dexAdapter.discoverPoolsForTokenPair(tokenPair, skipPoolId);
    for (const pool of foundPools) {
      if (this.pools.has(pool.id)) {
        // this could happen only if we trigger tokenPair discovery on an already discovered pair
        this.logger.warn(`Pool already registered: ${printPool(pool)}, skipping...`);
        continue;
      }

      this.pools.set(pool.id, pool);
      this.eventBus.emitPoolStateUpsert({ pool }); // EMIT: pool-state-upsert
    }

    this.logger.info(`✅ Discovery complete for pair ${tokenPair.key}, registered ${foundPools.length} new pools`);
    return foundPools;
  }

  //
  // update the state on all registred pools (currently called only at reorg events)
  //
  async updateAllPools(): Promise<void> {
    this.logger.info('🔄 Updating all pool states...');
    for (const [poolId, pool] of this.pools.entries()) {
      try {
        const updatedPool = await this.dexAdapter.updatePoolFromCall(pool);
        this.pools.set(poolId, updatedPool);
      } catch (error) {
        this.logger.warn(`❌ Failed updatePoolFromCall`, { poolId, pool, error });
      }
    }
    this.logger.info(`✅ Updated ${this.pools.size} active pool states`);
  }

  // ================================================================================================
  // POOLS OPERATIONS
  // ================================================================================================
  /**
   * 📥 GET ALL POOL STATES
   */
  getAllPools() {
    return this.pools;
  }

  /**
   * GET POOL ADDRESSES
   */
  getPoolAddresses(): string[] {
    const addresses: string[] = [];
    for (const pool of this.pools.values()) {
      if (pool.protocol === 'v2' || pool.protocol === 'v3') addresses.push(pool.address);
    }
    // TODO: handle non-address poolIds (uniswap v4, etc.)
    return addresses;
  }

  /**
   * 📊 GET POOL STATE
   */
  getPoolState(id: string): DexPoolState | undefined {
    return this.pools.get(id);
  }

  syncRegisteredPoolsToStorage(): Promise<void> {
    return this.dexAdapter.syncRegisteredPoolsToStorage(this.pools);
  }

  getStats() {
    return {
      registredPools: this.pools.size,
      storedPools: this.dexAdapter.getStats().storedPools,
    };
  }

  // ================================================================================================
  // ADAPTER ROUTING
  // ================================================================================================
  simulateSwap(pool: DexPoolState, amountIn: bigint, zeroForOne: boolean): bigint {
    return this.dexAdapter.simulateSwap(pool, amountIn, zeroForOne);
  }

  getVenueConfig(venueName: DexVenueName) {
    return this.dexAdapter.requireConfig(venueName);
  }
}
