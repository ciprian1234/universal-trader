import { formatUnits } from 'ethers';
import { EventBus } from './event-bus';
import type { PoolState, TokenPair, EventMetadata, PoolEvent } from './interfaces';
import type { DexRegistry } from './dex-registry';
import { TokenManager } from '../core/token-manager';
import type { Logger } from '@/utils';

export type PoolStatesManagerInput = {
  logger: Logger;
  eventBus: EventBus;
  dexRegistry: DexRegistry;
  tokenManager: TokenManager;
  watchedPairs?: TokenPair[]; // Optional pairs to monitor
};

export class PoolStatesManager {
  private readonly logger: Logger;
  private eventBus: EventBus;
  private dexRegistry: DexRegistry;
  private tokenManager: TokenManager;

  private poolStates: Map<string, PoolState> = new Map();
  private latestPoolEventMeta: Map<string, EventMetadata> = new Map();
  private watchedPairs: TokenPair[] = [];

  constructor(input: PoolStatesManagerInput) {
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
  getAll(): Map<string, PoolState> {
    return this.poolStates;
  }

  /**
   * GET POOL ADDRESSES
   */
  getPoolAddresses(): string[] {
    const addresses: string[] = [];
    for (const pool of this.poolStates.values()) {
      if (pool.dexType === 'uniswap-v2' || pool.dexType === 'uniswap-v3') addresses.push(pool.id);
    }
    // TODO: handle non-address poolIds (uniswap v4, etc.)
    return addresses;
  }

  /**
   * 📊 GET POOL STATE
   */
  getPoolState(id: string): PoolState | undefined {
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
  findPoolsByTokenPair(tokenPair: TokenPair): PoolState[] {
    const foundPools: PoolState[] = [];
    for (const pool of this.poolStates.values()) {
      if (pool.tokenPair.pairKey === tokenPair.pairKey) foundPools.push(pool);
    }
    return foundPools;
  }

  /**
   * 🔍 FIND POOLS BY DEX
   */
  getPoolsByDex(dexName: string): PoolState[] {
    return Array.from(this.poolStates.values()).filter((pool) => pool.dexName === dexName);
  }

  /**
   * 📈 GET ALL ACTIVE POOLS
   */
  getAllActivePools(): PoolState[] {
    return Array.from(this.poolStates.values());
  }

  // ================================================================================================
  // INITIALIZATION AND MANAGEMENT
  // ================================================================================================
  async discoverAndRegisterPools(watchedPairs: TokenPair[]): Promise<void> {
    this.watchedPairs = watchedPairs;

    this.logger.info('🎯 Discovering and registering pools for watched trading pairs...');
    this.logger.info('📋 MONITORED TRADING PAIRS:');
    this.watchedPairs.forEach((pair, index) => {
      this.logger.info(`   ${(index + 1).toString().padStart(2)}. ${pair.pairKey}`);
      this.logger.info(`       • ${pair.token0.symbol} (${pair.token0.address})`);
      this.logger.info(`       • ${pair.token1.symbol} (${pair.token1.address})`);
    });

    for (const pair of this.watchedPairs) {
      for (const [dexName, adapter] of this.dexRegistry.getAll().entries()) {
        // Get all pools from a DEX for a given token pair
        try {
          const pools = await adapter.discoverPools(pair.token0.address, pair.token1.address);
          for (const pool of pools) {
            // set pool state
            const poolKey = pool.id;
            this.poolStates.set(poolKey, pool);

            // Log pool registration
            this.logger.info(
              `✅ Registered pool on ${pool.dexName.padEnd(15)} (${pool.tokenPair.pairKey}:${pool.fee
                .toString()
                .padEnd(5)}) (id: ${pool.id})`,
            );
          }
        } catch (error) {
          this.logger.warn(`❌ Failed to register ${pair.pairKey} on ${dexName}:`, error);
        }
      }
    }

    this.logger.info(`✅ DISCOVERY COMPLETE:`);
    this.logger.info(`   🏗️  DEXes: ${this.dexRegistry.getAll().size}`);
    this.logger.info(`   🗄️  Pool States: ${this.poolStates.size}`);
  }

  async updateAll(): Promise<void> {
    this.logger.info('🔄 Updating all pool states...');

    for (const [key, pool] of this.poolStates.entries()) {
      try {
        const adapter = this.dexRegistry.getAdapter(pool.dexName);
        if (!adapter) {
          this.logger.warn(`❌ No adapter found for DEX ${pool.dexName} while updating pool ${key}`);
          continue;
        }

        const updatedPoolState = await adapter.updatePool(pool);
        this.poolStates.set(key, updatedPoolState);

        // Log pool initialization
        this.logger.info(
          `✅ Updated pool on ${pool.dexName.padEnd(15)} (${pool.tokenPair.pairKey}:${pool.fee.toString().padEnd(5)}) (id: ${pool.id})`,
        );
      } catch (error) {
        this.logger.warn(`❌ Failed to update pool ${key}:`, { error });
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

      // skip if reserves are undefined
      if (pool.reserve0 === undefined || pool.reserve1 === undefined) {
        throw new Error(`Error calculating LiquidityUSD for pool ${key} due to undefined reserves`);
        continue;
      }

      // calculate liquidityUSD (requires external price feed)
      let totalLiquidityInUSD = 0;
      try {
        // TODO: update this when implemented price oracle
        // const v0 = this.tokenManager.calculateUSDValue(token0.address, pool.reserve0) || 0;
        // const v1 = this.tokenManager.calculateUSDValue(token1.address, pool.reserve1) || 0;
        // totalLiquidityInUSD = v0 + v1;
      } catch (e) {
        throw new Error(`Error calculating USD value for pool ${key}: ${(e as Error).message}`);
      }

      // update pool state
      pool.totalLiquidityInUSD = totalLiquidityInUSD;
      this.poolStates.set(key, pool);
    }
  }

  // ================================================================================================
  // EVENT HANDLERS
  // ================================================================================================
  handlePoolEvent(event: PoolEvent) {
    // Get DEX adapter
    const adapter = this.dexRegistry.getAdapter(event.dexName)!;
    const poolId = event.poolId;
    const s0 = event.tokenPair.token0.symbol;
    const s1 = event.tokenPair.token1.symbol;
    try {
      const previousState = this.poolStates.get(poolId);
      if (!previousState) throw new Error(`❌ Failed to get prevState for sync event on ${event.dexName}`);

      // check if event is newer
      if (!this.isEventNewer(event.meta, previousState.latestEventMeta)) {
        this.logger.warn(`⚠️ Skipping outdated event received for ${poolId}`);
        return;
      }

      // log event details
      const feePercent = adapter.getFeePercent(previousState);
      const eventDetails = `📊 ${event.dexName} ${s0}-${s1} (fee: ${feePercent}%) update event`;
      const deltaMs = Date.now() - event.meta.blockReceiveTimestamp;
      this.logger.info(`${eventDetails.padEnd(60)} 🔗 ${event.meta.blockNumber} (+${deltaMs}ms)`);

      // Update pool state from event
      const updatedState = adapter.updatePoolFromEvent(previousState, event);

      // Update latest event timestamp
      this.latestPoolEventMeta.set(poolId, event.meta); // set blockchain timestamp (not local)

      // Update active state
      this.poolStates.set(poolId, updatedState);

      // Emit pool update event
      this.eventBus.emitPoolUpdate(updatedState, previousState);
    } catch (error) {
      this.logger.error(`❌ Error handling sync event on ${event.dexName}:`, { error, event });
      // TODO: move pool state from active to error state
    }
  }

  // ================================================================================================
  // HELPERS for pool staleness
  // ================================================================================================
  public arePoolsFresh(poolStates: PoolState[]): boolean {
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
  displayEvent(event: PoolEvent, previousState: PoolState, updatedState: PoolState): void {
    const s0 = event.tokenPair.token0.symbol;
    const s1 = event.tokenPair.token1.symbol;
    const adapter = this.dexRegistry.getAdapter(event.dexName)!;

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
  displayPoolState(pool: PoolState): void {
    const s0 = pool.tokenPair.token0.symbol;
    const s1 = pool.tokenPair.token1.symbol;

    this.logger.info(`💧 ${pool.dexName} ${s0}-${s1} (feeBP: ${pool.fee}) - Pool ID: ${pool.id}`);
    this.logger.info(`   📈 Price: ${s0} = ${pool.spotPrice0to1}${s1}`);
    this.logger.info(`   📉 Price: ${s1} = ${pool.spotPrice1to0}${s0}`);
    this.logger.info(`   💰 Total Liquidity in USD: $${pool.totalLiquidityInUSD?.toFixed(2)}`);

    if (pool.dexType === 'uniswap-v3') {
      this.logger.info(`   🧱 Current Tick: ${pool.tick} (tickSpacing: ${pool.tickSpacing})`);
      // log tick ranges for each liquidity position
      if (pool.initializedTicks) {
        pool.initializedTicks.forEach((pos, index) => {
          this.logger.info(`       🧱 Position ${index + 1}: Liquidity: ${pos.liquidityNet.toString()} - Tick: ${pos.tick}`);
        });
      }
    }

    this.logger.info(`\n\n`);
  }
}
