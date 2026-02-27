import type { DexConfig } from '@/config/models';
import type { Blockchain } from '../blockchain';
import type { TokenManager } from '../token-manager';

export interface DexAdapterContext {
  config: DexConfig;
  blockchain: Blockchain;
  tokenManager: TokenManager;
}
