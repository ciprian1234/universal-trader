import { TokenManager } from '../core/token-manager';
import { Blockchain } from '../core/blockchain';
import type { Logger } from '@/utils';
import type { ChainConfig, DexConfig } from '@/config/models';
import * as DEX_V2 from './adapters/uniswap-v2';
import * as DEX_V3 from './adapters/uniswap-v3';
import * as DEX_V4 from './adapters/uniswap-v4';
import type { DexPoolState, DexVenueName } from '@/shared/data-model/layer1';
import type { TokenPairOnChain } from '@/shared/data-model/token';

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
}
