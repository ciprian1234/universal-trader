import { TokenManager } from './token-manager';
import { Blockchain } from './blockchain';
import { createLogger, type Logger } from '@/utils';
import type { ChainConfig } from '@/config/models';
import type { DexPoolState } from '@/shared/data-model/layer1';
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
  async handlePoolEvent(event: PoolEvent) {
    let pool = this.pools.get(event.poolId) ?? null;
    const isNewPool = !pool; // to determine if we need to emit a 'create' or 'update' event later
    if (pool) {
      pool = this.dexAdapter.updatePoolFromEvent(pool, event);
    } else {
      pool = await this.dexAdapter.handleEventForUnknownPool(event); // NOTE: this may take longer...
      if (!pool) return this.logger.error(`Unable to introspect pool, ignoring event for poolId: ${event.poolId}`);
    }

    // update pools cache
    this.pools.set(pool.id, pool);
    this.eventBus.emitPoolStateEvent({ action: isNewPool ? 'create' : 'update', pool }); // EMIT: pool-state-event

    // log event details
    const feePercent = this.dexAdapter.getFeePercent(pool);
    const eventDetails = `📊 ${pool.venue.name} ${pool.tokenPair.key} (fee: ${feePercent}%) update event`;
    const deltaMs = Date.now() - event.meta.blockReceivedTimestamp;
    this.logger.info(`${eventDetails.padEnd(60)} 🔗 ${event.meta.blockNumber} (+${deltaMs}ms)`);
  }

  //
  // Called when a new token pair its registred in the system (either via event or on init for preconfigured pairs)
  //
  async handlePoolsDiscoveryForTokenPair(tokenPair: TokenPairOnChain): Promise<DexPoolState[]> {
    this.logger.info(`🔍 Starting discovery for new token pair: ${tokenPair.key}...`);
    const foundPools = await this.dexAdapter.discoverPoolsForTokenPair(tokenPair);
    for (const pool of foundPools) {
      if (this.pools.has(pool.id)) {
        this.logger.info(`Pool with ID ${pool.id} already exists`);
        continue;
      }

      this.pools.set(pool.id, pool);
      this.eventBus.emitPoolStateEvent({ action: 'create', pool }); // EMIT: pool-state-event
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
        this.logger.warn(`❌ Failed to update pool ${poolId}:`, { error });
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
}
