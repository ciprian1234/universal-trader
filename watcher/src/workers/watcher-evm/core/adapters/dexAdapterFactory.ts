import { Blockchain } from '../blockchain';
import { TokenManager } from '../token-manager';
import type { DexAdapter } from '../interfaces';
import { UniswapV2Adapter } from './uniswap-v2';
import { UniswapV3Adapter } from './uniswap-v3';
import { UniswapV4Adapter } from './uniswap-v4';
import type { DexConfig } from '@/config/models';

export class DexAdapterFactory {
  static create(dexConfig: DexConfig, blockchain: Blockchain, tokenManager: TokenManager): DexAdapter {
    switch (dexConfig.type) {
      case 'uniswap-v2':
        return new UniswapV2Adapter(
          {
            name: dexConfig.name,
            factoryAddress: dexConfig.factoryAddress!,
            routerAddress: dexConfig.routerAddress,
          },
          blockchain,
          tokenManager,
        );

      case 'uniswap-v3':
        return new UniswapV3Adapter(
          {
            name: dexConfig.name,
            factoryAddress: dexConfig.factoryAddress!,
            routerAddress: dexConfig.routerAddress,
            quoterAddress: dexConfig.quoterAddress!,
          },
          blockchain,
          tokenManager,
        );
      case 'uniswap-v4':
        throw new Error(`Unsupported DEX type: ${dexConfig.type}`);
        return new UniswapV4Adapter(
          {
            name: dexConfig.name,
            poolManagerAddress: dexConfig.poolManagerAddress!,
            stateViewAddress: dexConfig.stateViewAddress!,
            routerAddress: dexConfig.routerAddress,
            quoterAddress: dexConfig.quoterAddress!,
          },
          blockchain,
          tokenManager,
        );
      default:
        throw new Error(`Unsupported DEX type: ${dexConfig.type}`);
    }
  }
}
