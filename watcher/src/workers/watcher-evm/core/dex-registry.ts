import { TokenManager } from '../core/token-manager';
import { Blockchain } from '../core/blockchain';
import type { Logger } from '@/utils';
import type { ChainConfig, DexConfig } from '@/config/models';
import * as DEX_V2 from './adapters/uniswap-v2';
import * as DEX_V3 from './adapters/uniswap-v3';
import * as DEX_V4 from './adapters/uniswap-v4';
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
  private blockchain: Blockchain;
  private tokenManager: TokenManager;

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

  async discoverAllPools(watchedPairs: TokenPairOnChain[]) {
    this.logger.info('🔍 Discovering all pools for configured DEX venues...');
    this.logger.info('📋 TRADING PAIRS:');
    watchedPairs.forEach((pair, index) => {
      this.logger.info(`   ${(index + 1).toString().padStart(2)}. ${pair.key}`);
      this.logger.info(`       • ${pair.token0.symbol} (${pair.token0.address})`);
      this.logger.info(`       • ${pair.token1.symbol} (${pair.token1.address})`);
    });

    const allPools: DexPoolState[] = [];
    for (const [venueName, config] of this.venueConfigs.entries()) {
      const ctx = {
        blockchain: this.blockchain,
        tokenManager: this.tokenManager,
        config,
      };
      for (const pair of watchedPairs) {
        try {
          let foundPoolsForPair: DexPoolState[] = [];
          if (config.protocol === 'v2') {
            foundPoolsForPair = await DEX_V2.discoverPools(ctx, pair);
          } else if (config.protocol === 'v3') {
            foundPoolsForPair = await DEX_V3.discoverPools(ctx, pair);
          } else if (config.protocol === 'v4') {
            foundPoolsForPair = await DEX_V4.discoverPools(ctx, pair);
          }
          if (foundPoolsForPair.length === 0) continue;
          allPools.push(...foundPoolsForPair);
          foundPoolsForPair.forEach((pool) => {
            this.logger.info(
              `✅ Found pool on ${pool.venue.name.padEnd(15)} (${pool.tokenPair.key}:${pool.feeBps
                .toString()
                .padEnd(5)}) (id: ${pool.id})`,
            );
          });
        } catch (error) {
          this.logger.error(`Error discovering pools for pair ${pair.key} on venue ${venueName}`, {
            error: (error as Error).message,
          });
          continue;
        }
      }
    }
    this.logger.info(`✅ Pool discovery complete, found ${allPools.length} pools`);
    return allPools;
  }

  //
  // This function is used to handle events for pools that are not yet known in the system.
  //
  async handleEventForUnknownPool(event: PoolEvent): Promise<DexPoolState | null> {
    const ctx = { blockchain: this.blockchain, tokenManager: this.tokenManager };
    this.logger.warn(`Introspecting event for unknown poolId: ${event.poolId}`);

    try {
      if (event.protocol === 'v2') {
        // for V2 => at this point we only have the pool address and reserves
        const pool = await DEX_V2.introspectPoolFromEvent(ctx, event as V2SyncEvent);
        return pool;
      } else if (event.protocol === 'v3') {
        // for V3 => at this point we only have the pool address and fee tier, we need to fetch the token pair and tick spacing from the contract
        const pool = await DEX_V3.introspectPoolFromEvent(ctx, event as V3SwapEvent);
        return pool;
      } else if (event.protocol === 'v4') {
        // for V4 => at this point we only have the pool address, we need to fetch the token pair and fee tier from the contract
        //   const pool = await DEX_V4.introspectPoolFromEvent(ctx, event as V4SwapEvent);
        //   return pool;
        return null; // V4 pool introspection not implemented yet
      }
    } catch (error) {
      this.logger.error(`Error introspecting pool for event with poolId ${event.poolId}: ${(error as Error).message}`);
    }
    return null;
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
