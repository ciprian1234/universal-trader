// ========================================================================================
// INIT COMPONENTS
// ========================================================================================

import { appConfig } from '@/config';
import type { ChainConfig } from '@/config/models';
import { CacheService } from '@/utils/cache-service';
import { Blockchain } from '@/workers/watcher-evm/core/blockchain';
import { EventBus } from '@/workers/watcher-evm/core/event-bus';
import { TokenManager } from '@/workers/watcher-evm/core/token-manager';
import { WorkerDb } from '@/workers/watcher-evm/db';

const chainConfig = appConfig.platforms['ethereum'] as ChainConfig;

export const cache = new CacheService(chainConfig.chainId);
export const db = new WorkerDb(chainConfig.databaseUrl, chainConfig.chainId);
export const eventBus = new EventBus();

// Core app services
export const blockchain = new Blockchain({ chainConfig, cache });
export const tokenManager = new TokenManager({ chainConfig, blockchain, eventBus, db });

export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

export const WETH_ABI = [...ERC20_ABI, 'function deposit() payable'];
export const WETH_ADDRESS = chainConfig.wrappedNativeTokenAddress;
