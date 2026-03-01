import { formatUnits } from 'ethers';
import { EventBus } from './event-bus';
import type { PoolEvent } from './interfaces';
import type { DexRegistry } from './dex-registry';
import { TokenManager } from '../core/token-manager';
import { safeStringify, type Logger } from '@/utils';
import type { TokenPairOnChain } from '@/shared/data-model/token';
import type { DexPoolState, DexV2PoolState, DexV3PoolState, DexV4PoolState, EventMetadata } from '@/shared/data-model/layer1';

export type PoolStatesManagerInput = {
  chainId: number;
  logger: Logger;
  eventBus: EventBus;
  dexRegistry: DexRegistry;
  tokenManager: TokenManager;
};

export class PoolStatesManager {
  private readonly chainId: number;
  private readonly logger: Logger;
  private readonly eventBus: EventBus;
  private readonly dexRegistry: DexRegistry;
  private readonly tokenManager: TokenManager;

  private poolStates: Map<string, DexPoolState> = new Map();
  private latestPoolEventMeta: Map<string, EventMetadata> = new Map();

  constructor(input: PoolStatesManagerInput) {
    this.chainId = input.chainId;
    this.eventBus = input.eventBus;
    this.dexRegistry = input.dexRegistry;
    this.tokenManager = input.tokenManager;
    this.logger = input.logger;
  }

  // ================================================================================================
  // POOL STATE CRUD OPERATIONS
  // ================================================================================================

  /**
   * 📥 GET ALL POOL STATES
   */
  getAll(): Map<string, DexPoolState> {
    return this.poolStates;
  }

  /**
   * GET POOL ADDRESSES
   */
  getPoolAddresses(): string[] {
    const addresses: string[] = [];
    for (const pool of this.poolStates.values()) {
      if (pool.protocol === 'v2' || pool.protocol === 'v3') addresses.push(pool.address);
    }
    // TODO: handle non-address poolIds (uniswap v4, etc.)
    return addresses;
  }

  /**
   * 📊 GET POOL STATE
   */
  getPoolState(id: string): DexPoolState | undefined {
    return this.poolStates.get(id);
  }

  /**
   * 🗑️ REMOVE POOL STATE
   */
  removePoolState(id: string): void {
    this.poolStates.delete(id);
  }

  /**
   * 🔍 FIND POOLS BY TOKEN PAIR
   */
  findPoolsByTokenPair(tokenPair: TokenPairOnChain): DexPoolState[] {
    const foundPools: DexPoolState[] = [];
    for (const pool of this.poolStates.values()) {
      if (pool.tokenPair.key === tokenPair.key) foundPools.push(pool);
    }
    return foundPools;
  }

  /**
   * 🔍 FIND POOLS BY DEX
   */
  getPoolsByDex(dexName: string): DexPoolState[] {
    return Array.from(this.poolStates.values()).filter((pool) => pool.venue.name === dexName);
  }

  /**
   * 📈 GET ALL ACTIVE POOLS
   */
  getAllActivePools(): DexPoolState[] {
    return Array.from(this.poolStates.values());
  }

  // ================================================================================================
  // INITIALIZATION AND MANAGEMENT
  // ================================================================================================
  async discoverAndRegisterPools(watchedPairs: TokenPairOnChain[]): Promise<void> {
    const discoveredPools = await this.dexRegistry.discoverAllPools(watchedPairs);
    for (const pool of discoveredPools) {
      const poolId = pool.id;
      if (this.poolStates.has(pool.id)) {
        this.logger.warn(`⚠️ Pool with ID ${poolId} already exists, skipping registration`);
        continue;
      }
      this.poolStates.set(poolId, pool);
    }
  }

  async updateAll(): Promise<void> {
    this.logger.info('🔄 Updating all pool states...');
    for (const [id, pool] of this.poolStates.entries()) {
      try {
        const updatedPoolState = await this.dexRegistry.updatePool(pool);
        this.poolStates.set(id, updatedPoolState);

        // Log pool initialization
        this.logger.info(
          `✅ Updated pool on ${pool.venue.name.padEnd(15)} (${pool.tokenPair.key}:${pool.feeBps.toString().padEnd(5)}) (id: ${pool.id})`,
        );
      } catch (error) {
        this.logger.warn(`❌ Failed to update pool ${id}:`, { error });
      }
    }
    this.logger.info(`✅ Updated ${this.poolStates.size} pool states`);
  }

  // ================================================================================================
  // Calculate liquidityUSD for all pools
  // ================================================================================================
  public calculateAllPoolsLiquidityUSD(): void {
    for (const [key, pool] of this.poolStates.entries()) {
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
      this.poolStates.set(key, pool);
    }
  }

  // ================================================================================================
  // EVENT HANDLERS
  // ================================================================================================
  async handlePoolEvent(event: PoolEvent) {
    let pool: DexPoolState | null = null;
    if (this.poolStates.has(event.poolId)) pool = this.poolStates.get(event.poolId)!;
    else {
      pool = await this.dexRegistry.handleEventForUnknownPool(event);
      console.log('handleEventForUnknownPool result:', safeStringify(pool));
    }
    if (!pool) return this.logger.warn(`Unable to find or introspect pool for event with poolId ${event.poolId}`);

    // check if event is newer
    if (!this.isEventNewer(event.meta, pool.latestEventMeta)) {
      return this.logger.warn(`⚠️ Skipping outdated event received for ${event.poolId}`);
    }

    // log event details
    const feePercent = this.dexRegistry.getFeePercent(pool);
    const eventDetails = `📊 ${pool.venue.name} ${pool.tokenPair.key} (fee: ${feePercent}%) update event`;
    const deltaMs = Date.now() - event.meta.blockReceivedTimestamp;
    this.logger.info(`${eventDetails.padEnd(60)} 🔗 ${event.meta.blockNumber} (+${deltaMs}ms)`);

    // Update pool state from event
    const updatedState = this.dexRegistry.updatePoolFromEvent(pool, event);

    // Update latest event timestamp
    this.latestPoolEventMeta.set(pool.id, event.meta); // set blockchain timestamp (not local)

    // Update active state
    this.poolStates.set(pool.id, updatedState);

    // Emit pool update event
    // this.eventBus.emitPoolUpdate(updatedState, pool);
  }

  // ================================================================================================
  // HELPERS for pool staleness
  // ================================================================================================
  public arePoolsFresh(poolStates: DexPoolState[]): boolean {
    return poolStates.every((currentPool) => {
      const latestPoolEventMeta = this.latestPoolEventMeta.get(currentPool.id);
      if (!latestPoolEventMeta) return true;
      return !this.isEventNewer(latestPoolEventMeta, currentPool.latestEventMeta);
    });
  }

  private isEventNewer(newEvent: EventMetadata, lastEvent?: EventMetadata): boolean {
    // if no last event, consider new event as newer
    if (!lastEvent) return true;

    // Primary: Block number
    if (newEvent.blockNumber !== lastEvent.blockNumber) {
      return newEvent.blockNumber > lastEvent.blockNumber;
    }

    // Secondary: Transaction index within block
    if (newEvent.transactionIndex !== lastEvent.transactionIndex) {
      return newEvent.transactionIndex > lastEvent.transactionIndex;
    }

    // Tertiary: Log index within transaction
    return newEvent.logIndex > lastEvent.logIndex;
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
  displayPoolState(pool: DexV2PoolState | DexV3PoolState | DexV4PoolState): void {
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
}
