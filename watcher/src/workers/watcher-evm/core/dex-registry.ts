import { DexAdapterFactory } from './adapters/dexAdapterFactory';
import type { DexAdapter } from './interfaces';
import { TokenManager } from '../core/token-manager';
import { Blockchain } from '../core/blockchain';
import type { Logger } from '@/utils';
import type { ChainConfig } from '@/config/models';

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

    // Register all DEXes
    let count = 0;
    for (const dexConfig of chainConfig.dexConfigs) {
      try {
        const dexAdapter = DexAdapterFactory.create(dexConfig, this.blockchain, this.tokenManager);
        this.registerDexAdapter(dexAdapter);
        count++;
      } catch (error) {
        this.logger.warn(`❌ Failed to register DEX adapter for ${dexConfig.name}: ${(error as Error).message}`);
      }
    }

    this.logger.info(`✅ Configured ${count}/${chainConfig.dexConfigs.length} DEX adapters`);
  }

  /**
   * 🔧 REGISTER DEX ADAPTER
   */
  registerDexAdapter(adapter: DexAdapter): void {
    if (this.adapters.has(adapter.name)) throw new Error(`DEX adapter '${adapter.name}' is already registered`);
    this.adapters.set(adapter.name, adapter);
    this.logger.info(
      `✅ Registered DEX adapter: (🔧${adapter.type}) ${adapter.name.padEnd(15)} (RouterAddress: ${adapter.routerAddress})`,
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
