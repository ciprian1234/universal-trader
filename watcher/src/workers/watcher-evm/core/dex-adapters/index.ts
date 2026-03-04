// ================================================================================================
// DEX ADAPTERS ROUTING LOGIC

import type { DexPoolState, DexVenueName } from '@/shared/data-model/layer1';
import * as V2 from './uniswap-v2';
import * as V3 from './uniswap-v3';
import * as V4 from './uniswap-v4';
import type { PoolEvent, V2SyncEvent, V3SwapEvent, V4SwapEvent } from '../interfaces';
import type { DexAdapterContext, PoolIntrospectContext } from './interfaces';
import type { TokenPairOnChain } from '@/shared/data-model/token';
import type { DexConfig, DexV2Config, DexV3Config } from '@/config/models';
import { safeStringify } from '@/utils';
import type { Blockchain } from '../blockchain';

function initAllDexConfigContracts(blockchain: Blockchain, dexConfigs: DexConfig[]) {
  // Register all DEXes defined in the chain config
  for (const config of dexConfigs) {
    if (config.protocol === 'v2') {
      blockchain.initContract(config.factoryAddress, V2.FACTORY_ABI);
      blockchain.initContract(config.routerAddress, V2.ROUTER_ABI);
    } else if (config.protocol === 'v3') {
      blockchain.initContract(config.factoryAddress, V3.FACTORY_ABI);
      blockchain.initContract(config.quoterAddress, V3.QUOTER_ABI);
      blockchain.initContract(config.routerAddress, V3.ROUTER_ABI);
    } else if (config.protocol === 'v4') {
      blockchain.initContract(config.poolManagerAddress, V4.POOL_MANAGER_ABI);
      blockchain.initContract(config.stateViewAddress, V4.STATE_VIEW_ABI);
    } else {
      throw new Error(`Unsupported DexConfig: ${safeStringify(config)}`);
    }
  }
}

async function discoverPoolsForVenue(ctx: DexAdapterContext, tokenPair: TokenPairOnChain): Promise<DexPoolState[]> {
  if (ctx.config.protocol === 'v2') return await V2.discoverPools(ctx, tokenPair);
  else if (ctx.config.protocol === 'v3') return await V3.discoverPools(ctx, tokenPair);
  else if (ctx.config.protocol === 'v4') return await V4.discoverPools(ctx, tokenPair);
  else return [];
}

async function handleEventForUnknownPool(ctx: PoolIntrospectContext, event: PoolEvent): Promise<DexPoolState | null> {
  let pool: DexPoolState | null = null;
  if (event.protocol === 'v2') pool = await V2.introspectPoolFromEvent(ctx, event as V2SyncEvent);
  else if (event.protocol === 'v3') pool = await V3.introspectPoolFromEvent(ctx, event as V3SwapEvent);
  else throw new Error(`Unsupported pool event: ${safeStringify(event)}`);
  pool.venue.name = identifyVenueNameForPool(pool, ctx.configs);
  return pool;
}

// helper to identify venue name for pool
function identifyVenueNameForPool(pool: DexPoolState, dexConfigs: DexConfig[]): DexVenueName {
  const dexConfigListByProtocol = dexConfigs.filter((config) => config.protocol === pool.protocol);
  if (pool.protocol === 'v2') return V2.identifyVenueForPool(pool, dexConfigListByProtocol as DexV2Config[]);
  else if (pool.protocol === 'v3') return V3.identifyVenueForPool(pool, dexConfigListByProtocol as DexV3Config[]);
  else return 'unknown';
}

async function updatePool(ctx: DexAdapterContext, pool: DexPoolState): Promise<DexPoolState> {
  if (pool.protocol === 'v2') return V2.updatePool(ctx, pool);
  else if (pool.protocol === 'v3') return V3.updatePool(ctx, pool);
  else if (pool.protocol === 'v4') return V4.updatePool(ctx, pool);
  else throw new Error(`Unsupported operation for pool: ${safeStringify(pool)}`);
}

function getFeePercent(pool: DexPoolState): number {
  if (pool.protocol === 'v2') return V2.getFeePercent(pool);
  else if (pool.protocol === 'v3') return V3.getFeePercent(pool);
  else if (pool.protocol === 'v4') return V4.getFeePercent(pool);
  else throw new Error(`Unsupported operation for pool: ${safeStringify(pool)}`);
}

function updatePoolFromEvent(pool: DexPoolState, poolEvent: PoolEvent): DexPoolState {
  if (pool.protocol === 'v2') return V2.updatePoolFromEvent(pool, poolEvent as V2SyncEvent);
  else if (pool.protocol === 'v3') return V3.updatePoolFromEvent(pool, poolEvent);
  else if (pool.protocol === 'v4') return V4.updatePoolFromEvent(pool, poolEvent as V4SwapEvent);
  else throw new Error(`Unsupported operation for pool: ${safeStringify(pool)} and event: ${safeStringify(poolEvent)}`);
}

// exported adapter functions for DexManager
export const DEX_ADAPTER = {
  initAllDexConfigContracts,
  discoverPoolsForVenue,
  handleEventForUnknownPool,
  updatePool,
  getFeePercent,
  updatePoolFromEvent,
};
