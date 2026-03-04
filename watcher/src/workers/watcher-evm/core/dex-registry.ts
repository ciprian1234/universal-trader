import { TokenManager } from '../core/token-manager';
import { Blockchain } from '../core/blockchain';
import type { Logger } from '@/utils';
import type { ChainConfig, DexConfig, DexV2Config, DexV3Config } from '@/config/models';
import * as DEX_V2 from './dex-adapters/uniswap-v2';
import * as DEX_V3 from './dex-adapters/uniswap-v3';
import * as DEX_V4 from './dex-adapters/uniswap-v4';
import type { DexPoolState, DexV2PoolState, DexV3PoolState, DexV4PoolState, DexVenueName } from '@/shared/data-model/layer1';
import type { TokenPairOnChain } from '@/shared/data-model/token';
import type { PoolEvent, V2SyncEvent, V3SwapEvent, V4SwapEvent } from './interfaces';

type DexRegistryInput = {
  logger: Logger;
  blockchain: Blockchain;
  tokenManager: TokenManager;
};

export class DexRegistry {
  private readonly logger: Logger;
  private readonly blockchain: Blockchain;
  private readonly tokenManager: TokenManager;

  // list of all DEXes supported by the worker, populated during init() based on chain config
  private readonly venueConfigs: Map<DexVenueName, DexConfig> = new Map();

  constructor(input: DexRegistryInput) {
    this.logger = input.logger;
    this.blockchain = input.blockchain;
    this.tokenManager = input.tokenManager;
  }

  private requireConfig(venueName: DexVenueName) {
    const config = this.venueConfigs.get(venueName);
    if (!config) throw new Error(`No config for venue: ${venueName}`);
    return config;
  }

  /**
   * Dex registry initialization
   */
  init(chainConfig: ChainConfig) {
    this.logger.info('🔧 Initializing DEX registry...');

    // Register all DEXes defined in the chain config
    for (const config of chainConfig.dexConfigs) {
      if (config.protocol === 'v2') {
        this.blockchain.initContract(config.factoryAddress, DEX_V2.FACTORY_ABI);
        this.blockchain.initContract(config.routerAddress, DEX_V2.ROUTER_ABI);
      } else if (config.protocol === 'v3') {
        this.blockchain.initContract(config.factoryAddress, DEX_V3.FACTORY_ABI);
        this.blockchain.initContract(config.quoterAddress, DEX_V3.QUOTER_ABI);
        this.blockchain.initContract(config.routerAddress, DEX_V3.ROUTER_ABI);
      } else if (config.protocol === 'v4') {
        this.blockchain.initContract(config.poolManagerAddress, DEX_V4.POOL_MANAGER_ABI);
        this.blockchain.initContract(config.stateViewAddress, DEX_V4.STATE_VIEW_ABI);
      } else {
        this.logger.warn(`Unsupported DEX config`, { config });
        continue;
      }
      this.venueConfigs.set(config.name, config);
    }

    this.logger.info(`✅ Configured DEX venues: ${[...this.venueConfigs.keys()].join(', ')}`);
  }

  async discoverAllPoolsForTokenPair(tokenPair: TokenPairOnChain) {
    const foundPools: DexPoolState[] = [];
    for (const [venueName, config] of this.venueConfigs.entries()) {
      const ctx = { blockchain: this.blockchain, tokenManager: this.tokenManager, config };

      try {
        let foundPoolsForVenue: DexPoolState[] = [];
        if (config.protocol === 'v2') {
          foundPoolsForVenue = await DEX_V2.discoverPools(ctx, tokenPair);
        } else if (config.protocol === 'v3') {
          foundPoolsForVenue = await DEX_V3.discoverPools(ctx, tokenPair);
        } else if (config.protocol === 'v4') {
          foundPoolsForVenue = await DEX_V4.discoverPools(ctx, tokenPair);
        }
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

  //
  // This function is used to handle events for pools that are not yet known in the system.
  //
  async handleEventForUnknownPool(event: PoolEvent): Promise<DexPoolState | null> {
    const ctx = { blockchain: this.blockchain, tokenManager: this.tokenManager };
    this.logger.warn(`Introspecting event for unknown poolId: ${event.poolId}`);

    try {
      let pool: DexPoolState | null = null;
      if (event.protocol === 'v2') {
        // for V2 => at this point we only have the pool address and reserves
        pool = await DEX_V2.introspectPoolFromEvent(ctx, event as V2SyncEvent);
      } else if (event.protocol === 'v3') {
        // for V3 => at this point we only have the pool address and fee tier, we need to fetch the token pair and tick spacing from the contract
        pool = await DEX_V3.introspectPoolFromEvent(ctx, event as V3SwapEvent);
      } else {
        return null; // V4 pool introspection not implemented yet
      }

      pool.venue.name = this.identifyVenueNameForPool(pool);
      return pool;
    } catch (error) {
      this.logger.error(`Error introspecting pool for event with poolId ${event.poolId}: ${(error as Error).message}`);
    }
    return null;
  }

  //
  // Identify venue name for unknown pool
  //
  identifyVenueNameForPool(pool: DexPoolState): DexVenueName {
    const dexConfigListByProtocol = [...this.venueConfigs.values()].filter((config) => config.protocol === pool.protocol);

    let venueName: DexVenueName = 'unknown';
    if (pool.protocol === 'v2') {
      venueName = DEX_V2.identifyVenueForPool(pool, dexConfigListByProtocol as DexV2Config[]);
    } else if (pool.protocol === 'v3') {
      venueName = DEX_V3.identifyVenueForPool(pool, dexConfigListByProtocol as DexV3Config[]);
    }

    return venueName;
  }

  // ================================================================================================
  // DEX ADAPTERS ROUTING LOGIC
  // ================================================================================================
  async updatePool(pool: DexPoolState): Promise<DexPoolState> {
    const ctx = { blockchain: this.blockchain, tokenManager: this.tokenManager, config: this.requireConfig(pool.venue.name) };
    if (pool.protocol === 'v2') return DEX_V2.updatePool(ctx, pool as DexV2PoolState);
    if (pool.protocol === 'v3') return DEX_V3.updatePool(ctx, pool as DexV3PoolState);
    if (pool.protocol === 'v4') return DEX_V4.updatePool(ctx, pool as DexV4PoolState);
    throw new Error(`Unsupported DEX updatePool for protocol: ${pool.protocol}`);
  }

  getFeePercent(pool: DexPoolState): number {
    if (pool.protocol === 'v2') return DEX_V2.getFeePercent(pool as DexV2PoolState);
    if (pool.protocol === 'v3') return DEX_V3.getFeePercent(pool as DexV3PoolState);
    if (pool.protocol === 'v4') return DEX_V4.getFeePercent(pool as DexV4PoolState);
    throw new Error(`Unsupported DEX getFeePercent for protocol: ${pool.protocol}`);
  }

  updatePoolFromEvent(pool: DexPoolState, poolEvent: PoolEvent): DexPoolState {
    if (pool.protocol === 'v2') return DEX_V2.updatePoolFromEvent(pool as DexV2PoolState, poolEvent as V2SyncEvent);
    if (pool.protocol === 'v3') return DEX_V3.updatePoolFromEvent(pool as DexV3PoolState, poolEvent);
    if (pool.protocol === 'v4') return DEX_V4.updatePoolFromEvent(pool as DexV4PoolState, poolEvent as V4SwapEvent);
    throw new Error(`Unsupported DEX updatePoolFromEvent for protocol: ${pool.protocol}`);
  }
}
