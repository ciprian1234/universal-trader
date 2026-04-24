import type { DexConfig } from '@/config/models';
import type { Blockchain } from '../blockchain';
import type { TokenManager } from '../token-manager';

export interface DexAdapterContext {
  config: DexConfig;
  blockchain: Blockchain;
  tokenManager: TokenManager;
}

export interface PoolIntrospectContext {
  configs: DexConfig[]; // list of all dex venue configs
  blockchain: Blockchain;
  tokenManager: TokenManager;
}
