import type { DexAdapter } from './interfaces';
import { TokenManager } from '../core/token-manager';
import { Blockchain } from '../core/blockchain';
import type { Logger } from '@/utils';
import type { ChainConfig, DexConfig } from '@/config/models';
import { DexV2Adapter } from './adapters/uniswap-v2';
import { DexV3Adapter } from './adapters/uniswap-v3';

type DexRegistryInput = {
  logger: Logger;
  blockchain: Blockchain;
  tokenManager: TokenManager;
};

export class DexRegistry {
  private readonly logger: Logger;
  private blockchain: Blockchain;
  private tokenManager: TokenManager;
  private adapters: Map<string, DexAdapter> = new Map();

  constructor(input: DexRegistryInput) {
    this.logger = input.logger;
    this.blockchain = input.blockchain;
    this.tokenManager = input.tokenManager;
  }

  // ================================================================================================
  // ADAPTER MANAGEMENT
  // ================================================================================================
  /**
   * 🏗️ SETUP DEX ADAPTERS: Register all supported DEX adapters
   */
  setupDexAdapters(chainConfig: ChainConfig) {
    this.logger.info('🔧 Setting up DEX adapters...');

    // Register all DEXes defined in the chain config
    for (const dexConfig of chainConfig.dexConfigs) {
      try {
        const dexAdapter = this.createDexAdapter(dexConfig, this.blockchain, this.tokenManager);
        this.registerDexAdapter(dexAdapter);
      } catch (error) {
        this.logger.warn(`❌ Failed to register DEX adapter for ${dexConfig.name}: ${(error as Error).message}`);
      }
    }

    this.logger.info(`✅ Configured ${this.adapters.size}/${chainConfig.dexConfigs.length} DEX adapters`);
  }

  /**
   * Factory method to create a DexAdapter instance based on DexConfig
   */
  createDexAdapter(dexConfig: DexConfig, blockchain: Blockchain, tokenManager: TokenManager): DexAdapter {
    switch (dexConfig.protocol) {
      case 'v2':
        return new DexV2Adapter(dexConfig, blockchain, tokenManager);
      case 'v3':
        return new DexV3Adapter(dexConfig, blockchain, tokenManager);
      case 'v4':
        throw new Error(`Unsupported DEX type: ${dexConfig.protocol} (not implemented yet)`);
      // return new DexV4Adapter(dexConfig, blockchain, tokenManager);
      default:
        throw new Error(`Unsupported DEX config: ${dexConfig}`);
    }
  }

  /**
   * 🔧 REGISTER DEX ADAPTER
   */
  registerDexAdapter(adapter: DexAdapter): void {
    if (this.adapters.has(adapter.name)) throw new Error(`DEX adapter '${adapter.name}' is already registered`);
    this.adapters.set(adapter.name, adapter);
    this.logger.info(
      `✅ Registered DEX adapter: (🔧${adapter.name}) ${adapter.name.padEnd(15)} (RouterAddress: ${adapter.config.routerAddress})`,
    );
  }

  /**
   * 🔍 GET ADAPTER
   */
  getAdapter(dexName: string): DexAdapter | undefined {
    return this.adapters.get(dexName);
  }

  /**
   * 📋 GET ALL ADAPTERS
   */
  getAll(): Map<string, DexAdapter> {
    return this.adapters;
  }
}
