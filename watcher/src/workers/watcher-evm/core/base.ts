/**
 * 🏗️ BASE CLASSES: Common functionality for all DEX adapters
 */
import { ethers } from 'ethers';
import type { DexAdapter, TradeQuote, PoolEvent, DexType } from './interfaces';
import { TokenManager } from './token-manager';
import { Blockchain } from './blockchain';
import { createLogger } from '@/utils';
import type { DexPoolState } from '@/shared/data-model/layer1';

// ================================================================================================
// ABSTRACT BASE DEX ADAPTER
// ================================================================================================

export abstract class BaseDexAdapter implements DexAdapter {
  protected readonly logger = createLogger(`[DexAdapter]`);
  protected readonly blockchain: Blockchain;
  protected config: any;
  protected eventSubscriptions: Map<string, ethers.Contract> = new Map();
  protected tokenManager!: TokenManager;

  abstract readonly name: string;
  abstract readonly type: DexType;
  abstract readonly factoryAddress: string;
  abstract readonly routerAddress: string;

  abstract readonly FACTORY_ABI: string[];
  abstract readonly POOL_ABI: string[];

  constructor(config: any, blockchain: Blockchain, tokenManager: TokenManager) {
    this.config = config;
    this.blockchain = blockchain;
    this.tokenManager = tokenManager;
  }

  // ================================================================================================
  // TEMPLATE METHODS (implemented in base class)
  // ================================================================================================

  // ================================================================================================
  // ABSTRACT METHODS (must be implemented by concrete classes)
  // ================================================================================================

  // Pool management
  abstract discoverPools(token0: string, token1: string): Promise<DexPoolState[]>;
  abstract initPool(id: string): Promise<DexPoolState>;
  abstract updatePool(pool: DexPoolState): Promise<DexPoolState>;
  abstract updatePoolFromEvent(pool: DexPoolState, event: PoolEvent): DexPoolState;

  // Trade management
  abstract simulateSwap(poolState: DexPoolState, amountIn: bigint, zeroForOne: boolean): bigint;
  abstract getTradeQuote(poolState: DexPoolState, amountIn: bigint, zeroForOne: boolean): Promise<TradeQuote>;
  abstract getFeePercent(poolState: DexPoolState): number;
}
