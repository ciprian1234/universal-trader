/**
 * 🏗️ BASE CLASSES: Common functionality for all DEX adapters
 */
import { ethers } from 'ethers';
import type { DexAdapter, PoolState, TradeQuote, PoolEvent, DexType } from './interfaces';
import { TokenManager } from './token-manager';
import { Blockchain } from './blockchain';
import { createLogger } from '@/utils';

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
  abstract discoverPools(token0: string, token1: string): Promise<PoolState[]>;
  abstract initPool(id: string): Promise<PoolState>;
  abstract updatePool(pool: PoolState): Promise<PoolState>;
  abstract updatePoolFromEvent(pool: PoolState, event: PoolEvent): PoolState;

  // Trade management
  abstract simulateSwap(poolState: PoolState, amountIn: bigint, zeroForOne: boolean): bigint;
  abstract getTradeQuote(poolState: PoolState, amountIn: bigint, zeroForOne: boolean): Promise<TradeQuote>;
  abstract getFeePercent(poolState: PoolState): number;
}

// ================================================================================================
// UTILITY FUNCTIONS
// ================================================================================================

export class DexUtils {
  /**
   * 🔧 Convert sqrtPriceX96 to human-readable price
   */
  static sqrtPriceX96ToPrice(sqrtPriceX96: bigint, decimals0: number = 18, decimals1: number = 18): number {
    const sqrtPriceFloat = Number(sqrtPriceX96) / 2 ** 96;
    const priceRatio = sqrtPriceFloat ** 2;
    return (priceRatio * 10 ** decimals0) / 10 ** decimals1;
  }

  /**
   * 🔧 Calculate price impact
   */
  static calculatePriceImpact(spotPrice: number, executionPrice: number): number {
    return Math.abs((executionPrice - spotPrice) / spotPrice) * 100;
  }

  /**
   * 🔧 Sort tokens consistently
   */
  static sortTokens(tokenA: string, tokenB: string): [string, string] {
    return tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
  }

  // TODO: see if we can use those:
  // ✅ Percentage calculation
  static calculatePercentage(amount: bigint, basisPoints: number): bigint {
    return (amount * BigInt(basisPoints)) / 10000n;
  }

  // ✅ Token amount formatting
  static formatTokenAmount(amount: bigint, decimals: number): string {
    const divisor = 10n ** BigInt(decimals);
    const whole = amount / divisor;
    const fraction = amount % divisor;
    return `${whole}.${fraction.toString().padStart(decimals, '0')}`;
  }
}
