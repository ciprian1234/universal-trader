import { TokenManager } from './token-manager';
import { Blockchain } from './blockchain';
import { createLogger, printPool, printPoolInEvent, type Logger } from '@/utils';
import type { ChainConfig } from '@/config/models';
import type { DexPoolState, DexV3PoolState, DexV4PoolState, DexVenueName } from '@/shared/data-model/layer1';
import type { TokenPairOnChain } from '@/shared/data-model/token';
import type { PoolEvent } from './interfaces';
import type { WorkerDb } from '../db';
import { DexAdapter } from './dex-adapters';
import type { PriceOracle } from './price-oracle';
import type { EventBus } from './event-bus';
import type { BlockEntry } from './block-manager';

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

  async registerStoredPools(): Promise<DexPoolState[]> {
    // 1. init pools
    const pools = await this.dexAdapter.loadPoolsFromStorageCache();
    for (const pool of pools) this.pools.set(pool.id, pool); // TBD: set if not exist (to avoid overwriting pools updated from events during startup)
    this.logger.info(`📦 Initialized with ${this.pools.size} registred pools from storage`);

    // 2. update pools with fresh on-chain data
    await this.dexAdapter.updatePoolsInBatch(this.pools); // TBD: use force overwrite flag

    // log dynamic data for all pools after update
    // for (const pool of this.pools.values()) {
    //   const data: any = {
    //     reserve0: pool.reserve0,
    //     reserve1: pool.reserve1,
    //     spotPrice0to1: pool.spotPrice0to1,
    //     spotPrice1to0: pool.spotPrice1to0,
    //     totalLiquidityUSD: pool.totalLiquidityUSD,
    //     error: pool.error,
    //   };
    //   if (pool.protocol === 'v3' || pool.protocol === 'v4') {
    //     data.sqrtPriceX96 = pool.sqrtPriceX96;
    //     data.tick = pool.tick;
    //     data.liquidity = pool.liquidity;
    //   }
    //   this.logger.info(`${printPool(pool)}`, { data }); // pool-log
    // }
    this.logger.info(`✅ Registered and updated ${this.pools.size} pools from storage`);
    return Array.from(this.pools.values()); // return instead of emit
  }

  // ================================================================================================
  // EVENT HANDLERS
  // ================================================================================================
  async handlePoolEventsBatch(events: PoolEvent[], block: BlockEntry): Promise<void> {
    const handledPools: DexPoolState[] = [];
    const unhandledEvents: PoolEvent[] = [];
    for (const event of events) {
      let pool = this.pools.get(event.poolId) ?? null;
      if (!pool) {
        unhandledEvents.push(event);
        continue;
      }

      this.dexAdapter.updatePoolFromEvent(pool, event);
      handledPools.push(pool);
    }

    // process unhandled events sequentially to avoid multiple concurrent introspections for the same unknown pool
    // TODO => optimize this (if mutiple events for same unknown pool)
    const results = await Promise.allSettled(
      unhandledEvents
        .filter((events) => events.name === 'sync' || events.name === 'swap') // handle only sync and swap events for unknown pools
        .map((events) => this.dexAdapter.handleEventForUnknownPool(events)),
    );

    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value) {
        this.pools.set(result.value.id, result.value);
        // this.logger.info(`✅ Registered new pool from event: ${printPool(result.value)}`); // pool-log
        handledPools.push(result.value);
      }

      const event = unhandledEvents[index];
      if (result.status === 'rejected') this.logger.warn(`⚠️ Error handling pool event`, { reason: result.reason, event });
      if (result.status === 'fulfilled' && !result.value) this.logger.warn(`⚠️ Failed to handle pool event`, { event }); // pool-event-log
    });

    this.eventBus.emitPoolsUpsertBatch({ pools: handledPools, block }); // EMIT: pool-state-upsert-batch for newly discovered pools
  }

  //
  // Called by TokenPairManager when a new tokenPair its registred (not used currently)
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
      // this.eventBus.emitPoolStateUpsert({ pool }); // EMIT: pool-state-upsert
    }

    this.logger.info(`✅ Discovery complete for pair ${tokenPair.key}, registered ${foundPools.length} new pools`);
    return foundPools;
  }

  // update only specific pools by their ids
  async updatePoolsByIds(poolIds: Set<string>, fetchTicks: boolean = false): Promise<DexPoolState[]> {
    this.logger.info(`🔄 Updating states ${poolIds.size} pool states...`);
    const subset = new Map<string, DexPoolState>();
    for (const poolId of poolIds) {
      const pool = this.pools.get(poolId);
      if (pool) subset.set(poolId, pool);
    }
    await this.dexAdapter.updatePoolsInBatch(subset);

    if (fetchTicks) {
      const clSubset = new Map<string, DexV3PoolState | DexV4PoolState>();
      for (const id of poolIds) {
        const pool = this.pools.get(id);
        if (pool && (pool.protocol === 'v3' || pool.protocol === 'v4')) clSubset.set(id, pool as DexV3PoolState | DexV4PoolState);
      }
      this.logger.info(`🔄 Updating ticks for ${clSubset.size} concentrated liquidity pools...`);
      await this.dexAdapter.updatePoolTicksInBatch_v2(clSubset, 4);
      this.logger.info(`✅ Updated ticks for ${clSubset.size} concentrated liquidity pools`);
    }

    const updatedPools = Array.from(subset.values());
    this.logger.info(`✅ Updated ${subset.size} pool states`);
    return updatedPools;
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
      // count of pools with errors
      poolsWithErrors: Array.from(this.pools.values()).filter((pool) => pool.error).length,
    };
  }

  // ================================================================================================
  // POOLS OPERATIONS
  // ================================================================================================
  displayPool(poolId: string) {
    const pool = this.pools.get(poolId)!;
    let data: any;
    if (pool.protocol === 'v3' || pool.protocol === 'v4') {
      data = {
        id: pool.id,
        r0: pool.reserve0,
        r1: pool.reserve1,
        s: pool.sqrtPriceX96,
        l: pool.liquidity,
        tC: pool.ticks?.length ? pool.ticks.length : null,
        lUSD: pool.totalLiquidityUSD,
      };
    } else {
      data = { id: pool.id, r0: pool.reserve0, r1: pool.reserve1, lUSD: pool.totalLiquidityUSD };
    }
    this.logger.info(`${printPool(pool)}`, { ...data });
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
