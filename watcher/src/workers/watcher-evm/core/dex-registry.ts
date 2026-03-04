import { TokenManager } from '../core/token-manager';
import { Blockchain } from '../core/blockchain';
import { createLogger, type Logger } from '@/utils';
import type { ChainConfig, DexConfig } from '@/config/models';
import type { DexPoolState, DexVenueName } from '@/shared/data-model/layer1';
import type { TokenPairOnChain } from '@/shared/data-model/token';
import type { PoolEvent } from './interfaces';
import type { WorkerDb } from '../db';
import { formatUnits } from 'ethers';
import { DEX_ADAPTER } from './dex-adapters';

type DexRegistryInput = {
  chainConfig: ChainConfig;
  db: WorkerDb;
  blockchain: Blockchain;
  tokenManager: TokenManager;
};

export class DexRegistry {
  private readonly logger: Logger;
  private chainConfig: ChainConfig;

  private readonly db: WorkerDb;
  private readonly blockchain: Blockchain;
  private readonly tokenManager: TokenManager;

  // map of DEX configs by venue name for quick access
  private readonly venueConfigs: Map<DexVenueName, DexConfig> = new Map();

  // cached list of all stored pools from DB (used for quick introspection)
  private storedPools: Map<string, DexPoolState> = new Map();

  // list of registred pools in the system, updated on discovery and on events
  private pools: Map<string, DexPoolState> = new Map();

  constructor(input: DexRegistryInput) {
    this.logger = createLogger(`[${input.chainConfig.name}.DexManager]`);
    this.chainConfig = input.chainConfig;

    this.db = input.db;
    this.blockchain = input.blockchain;
    this.tokenManager = input.tokenManager;
  }

  /**
   * Dex registry initialization
   */
  async init() {
    this.logger.info('🔧 Initializing DexManager...');

    // Init contracts for all DEXes defined in the chain config and populate venueConfigs map for quick access
    DEX_ADAPTER.initAllDexConfigContracts(this.blockchain, this.chainConfig.dexConfigs);
    this.chainConfig.dexConfigs.forEach((config) => this.venueConfigs.set(config.name, config));

    // load stored pools from DB into cache for quick lookup during pool discovery
    const dbPools = await this.db.loadAllPools();
    for (const pool of dbPools) {
      this.storedPools.set(pool.id, pool.state);
    }
    this.logger.info(`📦 Loaded ${dbPools.length} pools from DB`);
    this.logger.info(`✅ Configured DEX venues: ${[...this.venueConfigs.keys()].join(', ')}`);
  }

  async discoverAllPoolsForTokenPair(tokenPair: TokenPairOnChain) {
    const foundPools: DexPoolState[] = [];
    for (const [venueName, config] of this.venueConfigs.entries()) {
      const ctx = { blockchain: this.blockchain, tokenManager: this.tokenManager, config };

      try {
        let foundPoolsForVenue = await DEX_ADAPTER.discoverPoolsForVenue(ctx, tokenPair);
        if (foundPoolsForVenue.length === 0) continue;
        foundPools.push(...foundPoolsForVenue);
        foundPoolsForVenue.forEach((pool) => {
          this.logger.info(
            `✅ Found pool on ${pool.venue.name.padEnd(15)} (${pool.tokenPair.key}:${pool.feeBps
              .toString()
              .padEnd(5)}) (id: ${pool.id})`,
          );
        });
      } catch (error) {
        this.logger.error(`Error discovering pools for pair ${tokenPair.key} on venue ${venueName}`, {
          error: (error as Error).message,
        });
        continue;
      }
    }
    return foundPools;
  }

  // ================================================================================================
  // INITIALIZATION AND MANAGEMENT
  // ================================================================================================

  async discoverPoolsForTokenPair(tokenPair: TokenPairOnChain): Promise<void> {
    const existingPools = this.findPoolsByTokenPair(tokenPair);
    // TODO: revisit this logic - if 1 new pool exist due to new event => other pools are not discovered
    if (existingPools.length >= 1) {
      this.logger.info(`There are already ${existingPools.length} pools for pair ${tokenPair.key}, skipping discovery`);
      return;
    }
    const discoveredPools = await this.discoverAllPoolsForTokenPair(tokenPair);
    for (const pool of discoveredPools) {
      const poolId = pool.id;
      if (this.pools.has(pool.id)) {
        this.logger.warn(`⚠️ Pool with ID ${poolId} already exists, skipping registration`);
        continue;
      }
      this.pools.set(poolId, pool);
      // this.storedPools.set(poolId, pool);
      this.db
        .upsertPool(pool, 'config', true)
        .catch((e) => this.logger.error(`Failed to save new pool ${poolId} to DB:`, { error: e }));
    }
    this.logger.info(`✅ Discovery complete for pair ${tokenPair.key}, registered ${discoveredPools.length} new pools`);
  }

  async updateAllPools(): Promise<void> {
    this.logger.info('🔄 Updating all pool states...');
    for (const [poolId, pool] of this.pools.entries()) {
      try {
        const ctx = { blockchain: this.blockchain, tokenManager: this.tokenManager, config: this.requireConfig(pool.venue.name) };
        const updatedPoolState = await DEX_ADAPTER.updatePool(ctx, pool);
        this.pools.set(poolId, updatedPoolState);

        // Log pool initialization
        this.logger.info(
          `✅ Updated pool on ${pool.venue.name.padEnd(15)} (${pool.tokenPair.key}:${pool.feeBps.toString().padEnd(5)}) (id: ${pool.id})`,
        );
      } catch (error) {
        this.logger.warn(`❌ Failed to update pool ${poolId}:`, { error });
      }
    }
    this.logger.info(`✅ Updated ${this.pools.size} active pool states`);
  }

  // ================================================================================================
  // Calculate liquidityUSD for all pools
  // ================================================================================================
  public calculateAllPoolsLiquidityUSD(): void {
    for (const [key, pool] of this.pools.entries()) {
      const token0 = pool.tokenPair.token0;
      const token1 = pool.tokenPair.token1;

      let totalLiquidityInUSD = 0;
      if (pool.protocol === 'v2') {
        try {
          // TODO: update this when implemented price oracle
          // const v0 = this.tokenManager.calculateUSDValue(token0.address, pool.reserve0) || 0;
          // const v1 = this.tokenManager.calculateUSDValue(token1.address, pool.reserve1) || 0;
          // totalLiquidityInUSD = v0 + v1;
        } catch (e) {
          throw new Error(`Error calculating USD value for pool ${key}: ${(e as Error).message}`);
        }
      }

      // // skip if reserves are undefined
      // if (pool.reserve0 === undefined || pool.reserve1 === undefined) {
      //   throw new Error(`Error calculating LiquidityUSD for pool ${key} due to undefined reserves`);
      //   continue;
      // }

      // calculate liquidityUSD (requires external price feed)

      // update pool state
      // pool.totalLiquidityInUSD = totalLiquidityInUSD;
      this.pools.set(key, pool);
    }
  }

  // ================================================================================================
  // POOL EVENT HANDLER
  // ================================================================================================
  async handlePoolEvent(event: PoolEvent) {
    let pool: DexPoolState | null = this.pools.get(event.poolId) ?? null;
    if (pool) {
      // => pool its registred - update state from event data
      const updatedState = DEX_ADAPTER.updatePoolFromEvent(pool, event);
      this.pools.set(pool.id, updatedState);
    } else {
      // => pool its new => introspect it from the event
      const ctx = { blockchain: this.blockchain, tokenManager: this.tokenManager, configs: this.chainConfig.dexConfigs };
      pool = await DEX_ADAPTER.handleEventForUnknownPool(ctx, event); // NOTE: this may take longer...
      if (!pool) return this.logger.warn(`Unable to introspect pool, ignoring event for poolId: ${event.poolId}`);

      // set pool in cache and save pool to DB as well
      this.pools.set(pool.id, pool);

      // EMIT: new pool event?

      this.db
        .upsertPool(pool, 'event', true)
        .catch((e) => this.logger.error(`Failed to save new pool ${pool!.id} to DB:`, { error: e }));
    }

    // log event details
    const feePercent = DEX_ADAPTER.getFeePercent(pool);
    const eventDetails = `📊 ${pool.venue.name} ${pool.tokenPair.key} (fee: ${feePercent}%) update event`;
    const deltaMs = Date.now() - event.meta.blockReceivedTimestamp;
    this.logger.info(`${eventDetails.padEnd(60)} 🔗 ${event.meta.blockNumber} (+${deltaMs}ms)`);

    // Emit pool update event
    // this.eventBus.emitPoolUpdate(updatedState, pool);
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

  /**
   * 🔍 FIND POOLS BY TOKEN PAIR
   */
  findPoolsByTokenPair(tokenPair: TokenPairOnChain): DexPoolState[] {
    const foundPools: DexPoolState[] = [];
    for (const pool of this.storedPools.values()) {
      if (pool.tokenPair.key === tokenPair.key) foundPools.push(pool);
    }
    return foundPools;
  }

  // ================================================================================================
  // HELPERS
  // ================================================================================================

  /**
   * 🖥️ Display event details
   */
  displayEvent(event: PoolEvent, previousState: DexPoolState, updatedState: DexPoolState): void {
    const s0 = updatedState.tokenPair.token0.symbol;
    const s1 = updatedState.tokenPair.token1.symbol;

    // get info data
    const oldSpotPriceToken0InToken1 = previousState.spotPrice0to1;
    const oldSpotPriceToken1InToken0 = previousState.spotPrice1to0;
    const newSpotPriceToken0InToken1 = updatedState.spotPrice0to1;
    const newSpotPriceToken1InToken0 = updatedState.spotPrice1to0;

    const oldNormalizedReserve0 = parseFloat(formatUnits(previousState.reserve0!, previousState.tokenPair.token0.decimals));
    const oldNormalizedReserve1 = parseFloat(formatUnits(previousState.reserve1!, previousState.tokenPair.token1.decimals));
    const newNormalizedReserve0 = parseFloat(formatUnits(updatedState.reserve0!, updatedState.tokenPair.token0.decimals));
    const newNormalizedReserve1 = parseFloat(formatUnits(updatedState.reserve1!, updatedState.tokenPair.token1.decimals));

    const priceChangePercent = ((newSpotPriceToken0InToken1 - oldSpotPriceToken0InToken1) / oldSpotPriceToken0InToken1) * 100;

    this.logger.info(`   🔗 Block: ${event.meta.blockNumber} - 📄 TX: ${event.meta.transactionHash}`);
    this.logger.info(`   💧 Reserve0: ${oldNormalizedReserve0} -> ${newNormalizedReserve0} (${s0})`);
    this.logger.info(`   💧 Reserve1: ${oldNormalizedReserve1} -> ${newNormalizedReserve1} (${s1})`);
    this.logger.info(`   📈 Price: 1${s0} costs ${newSpotPriceToken0InToken1}${s1} -> ${priceChangePercent.toFixed(6)}%`);
    this.logger.info(`   📉 Price: 1${s1} costs ${newSpotPriceToken1InToken0}${s0} -> ${priceChangePercent.toFixed(6)}%`);
    this.logger.info(`   ✅ Pool state synchronized successfully\n`);
  }

  /**
   * 🖥️ Display event details
   */
  displayPoolState(pool: DexPoolState): void {
    const s0 = pool.tokenPair.token0.symbol;
    const s1 = pool.tokenPair.token1.symbol;

    this.logger.info(`💧 ${pool.venue.name} ${s0}-${s1} (feeBP: ${pool.feeBps}) - Pool ID: ${pool.id}`);
    this.logger.info(`   📈 Price: ${s0} = ${pool.spotPrice0to1}${s1}`);
    this.logger.info(`   📉 Price: ${s1} = ${pool.spotPrice1to0}${s0}`);
    // this.logger.info(`   💰 Total Liquidity in USD: $${pool.totalLiquidityInUSD?.toFixed(2)}`);

    if (pool.protocol === 'v3') {
      this.logger.info(`   🧱 Current Tick: ${pool.tick} (tickSpacing: ${pool.tickSpacing})`);
      // log tick ranges for each liquidity position
      if (pool.ticks) {
        pool.ticks.forEach((pos, index) => {
          this.logger.info(`       🧱 Position ${index + 1}: Liquidity: ${pos.liquidityNet.toString()} - Tick: ${pos.tick}`);
        });
      }
    }

    this.logger.info(`\n\n`);
  }

  // helper to get config for venue or throw if not exist
  private requireConfig(venueName: DexVenueName) {
    const config = this.venueConfigs.get(venueName);
    if (!config) throw new Error(`No config for venue: ${venueName}`);
    return config;
  }
}
