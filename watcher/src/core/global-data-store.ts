// ================================================================================================
// POOL STATE STORE — Central in-memory store for all pool states
//
// Lives in the main (orchestrator) thread. Plain Maps. No serialization.
// Workers send decoded updates via postMessage, orchestrator writes here.
// Admin API, cross-chain detector, and arb engine read directly — instant access.
// ================================================================================================

import type {
  PoolState,
  V2PoolState,
  V3PoolState,
  SolidlyPoolState,
  CurvePoolState,
  BalancerPoolState,
  CexOrderBook,
  TickData,
  DexType,
} from './types.ts';
import { log } from '../utils/logger.ts';

type PoolChangeType = 'add' | 'update' | 'remove';
type PoolChangeListener = (pool: PoolState, changeType: PoolChangeType) => void;

export class GlobalDataStore {
  // ── Primary storage ──
  private readonly pools = new Map<string, PoolState>(); // address (lowercase) → state

  // ── Indices for fast lookup ──
  private readonly byChain = new Map<number, Set<string>>();
  private readonly byToken = new Map<string, Set<string>>(); // token address → pool addresses
  private readonly byDex = new Map<string, Set<string>>(); // dexName → pool addresses
  private readonly byPair = new Map<string, Set<string>>(); // sorted "tokenA:tokenB" → pool addresses
  private readonly bySymbolPair = new Map<string, Set<string>>(); // sorted "ETH:USDC" → pool addresses

  // ── Update tracking ──
  private _updateCount = 0;
  private _lastUpdateAt = 0;

  // ── Listeners ──
  private readonly listeners: PoolChangeListener[] = [];

  // ════════════════════════════════════════════════════════════
  // WRITE OPERATIONS
  // ════════════════════════════════════════════════════════════

  set(pool: PoolState): void {
    const key = pool.address.toLowerCase();
    const isNew = !this.pools.has(key);

    this.pools.set(key, pool);
    this._updateCount++;
    this._lastUpdateAt = Date.now();

    if (isNew) {
      this.indexPool(key, pool);
    }

    // Notify listeners synchronously — they are all in the same thread
    for (const fn of this.listeners) {
      try {
        fn(pool, isNew ? 'add' : 'update');
      } catch (err) {
        log.error('[PoolStateStore] Listener error:', err);
      }
    }
  }

  /** Apply a batch of updates at once (from a single block) */
  setBatch(pools: PoolState[]): void {
    for (const pool of pools) {
      this.set(pool);
    }
  }

  remove(address: string): boolean {
    const key = address.toLowerCase();
    const pool = this.pools.get(key);
    if (!pool) return false;

    this.pools.delete(key);
    this.removeIndex(key, pool);

    for (const fn of this.listeners) {
      try {
        fn(pool, 'remove');
      } catch (err) {
        log.error('[PoolStateStore] Listener error:', err);
      }
    }

    return true;
  }

  setDisabled(address: string, disabled: boolean): boolean {
    const pool = this.pools.get(address.toLowerCase());
    if (!pool) return false;
    pool.disabled = disabled;
    return true;
  }

  // ════════════════════════════════════════════════════════════
  // READ OPERATIONS — all synchronous, instant
  // ════════════════════════════════════════════════════════════

  get(address: string): PoolState | undefined {
    return this.pools.get(address.toLowerCase());
  }

  getV2(address: string): V2PoolState | undefined {
    const p = this.get(address);
    return p?.dexType === 'uniswap-v2' ? (p as V2PoolState) : undefined;
  }

  getV3(address: string): V3PoolState | undefined {
    const p = this.get(address);
    return p?.dexType === 'uniswap-v3' ? (p as V3PoolState) : undefined;
  }

  getCurve(address: string): CurvePoolState | undefined {
    const p = this.get(address);
    return p?.dexType === 'curve' ? (p as CurvePoolState) : undefined;
  }

  getCex(address: string): CexOrderBook | undefined {
    const p = this.get(address);
    return p?.dexType === 'cex' ? (p as CexOrderBook) : undefined;
  }

  has(address: string): boolean {
    return this.pools.has(address.toLowerCase());
  }

  get size(): number {
    return this.pools.size;
  }

  getAll(): Map<string, PoolState> {
    return this.pools;
  }

  /** All active (non-disabled) pools */
  getActive(): PoolState[] {
    const result: PoolState[] = [];
    for (const pool of this.pools.values()) {
      if (!pool.disabled) result.push(pool);
    }
    return result;
  }

  // ── Index-based lookups (O(1) via sets) ──

  getByChain(chainId: number): PoolState[] {
    const addrs = this.byChain.get(chainId);
    if (!addrs) return [];
    return this.resolveAddresses(addrs);
  }

  getByToken(tokenAddress: string): PoolState[] {
    const addrs = this.byToken.get(tokenAddress.toLowerCase());
    if (!addrs) return [];
    return this.resolveAddresses(addrs);
  }

  getByDex(dexName: string): PoolState[] {
    const addrs = this.byDex.get(dexName);
    if (!addrs) return [];
    return this.resolveAddresses(addrs);
  }

  getByPair(tokenA: string, tokenB: string): PoolState[] {
    const pairKey = this.makePairKey(tokenA, tokenB);
    const addrs = this.byPair.get(pairKey);
    if (!addrs) return [];
    return this.resolveAddresses(addrs);
  }

  /** Look up by two symbol names (sorted internally) */
  getBySymbolPair(symbolA: string, symbolB: string): PoolState[];
  /** Look up by pre-sorted key like "USDC:WETH" */
  getBySymbolPair(pairKey: string): PoolState[];
  getBySymbolPair(a: string, b?: string): PoolState[] {
    const symKey = b ? [a, b].sort().join(':') : a;
    const addrs = this.bySymbolPair.get(symKey);
    if (!addrs) return [];
    return this.resolveAddresses(addrs);
  }

  /** All unique symbol pair keys (e.g. ["USDC:WETH", "USDT:WETH"]) */
  getSymbolPairs(): string[] {
    return Array.from(this.bySymbolPair.keys());
  }

  /** Get best prices for a token symbol across all chains/dexes */
  getBestPrices(symbol: string): Array<{
    chainId: number;
    dexName: string;
    priceUSD: number;
    liquidityUSD: number;
    address: string;
  }> {
    const results: Array<{
      chainId: number;
      dexName: string;
      priceUSD: number;
      liquidityUSD: number;
      address: string;
    }> = [];

    for (const pool of this.pools.values()) {
      if (pool.disabled) continue;
      // Price derivation depends on pool type — we use spot prices from V2/V3
      // This is a simplified version; real price derivation uses TokenManager
      if (pool.tokenPair.token0.symbol === symbol || pool.tokenPair.token1.symbol === symbol) {
        results.push({
          chainId: pool.chainId,
          dexName: pool.dexName,
          priceUSD: 0, // populated by TokenManager
          liquidityUSD: pool.totalLiquidityUSD,
          address: pool.address,
        });
      }
    }

    return results.sort((a, b) => b.liquidityUSD - a.liquidityUSD);
  }

  // ── Listeners ──

  onChange(listener: PoolChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  // ── Stats ──

  getStats() {
    const byChain: Record<number, number> = {};
    const byDexType: Record<string, number> = {};
    let disabledCount = 0;

    for (const pool of this.pools.values()) {
      byChain[pool.chainId] = (byChain[pool.chainId] ?? 0) + 1;
      byDexType[pool.dexType] = (byDexType[pool.dexType] ?? 0) + 1;
      if (pool.disabled) disabledCount++;
    }

    return {
      totalPools: this.pools.size,
      byChain,
      byDexType,
      disabledCount,
      updateCount: this._updateCount,
      lastUpdateAt: this._lastUpdateAt,
    };
  }

  // ════════════════════════════════════════════════════════════
  // INTERNAL HELPERS
  // ════════════════════════════════════════════════════════════

  private indexPool(key: string, pool: PoolState): void {
    // By chain
    this.addToSet(this.byChain, pool.chainId, key);

    // By token
    const t0 = pool.tokenPair.token0.address.toLowerCase();
    const t1 = pool.tokenPair.token1.address.toLowerCase();
    this.addToSet(this.byToken, t0, key);
    this.addToSet(this.byToken, t1, key);

    // By dex
    this.addToSet(this.byDex, pool.dexName, key);

    // By pair (sorted addresses)
    const pairKey = this.makePairKey(t0, t1);
    this.addToSet(this.byPair, pairKey, key);

    // By symbol pair
    const symKey = [pool.tokenPair.token0.symbol, pool.tokenPair.token1.symbol].sort().join(':');
    this.addToSet(this.bySymbolPair, symKey, key);
  }

  private removeIndex(key: string, pool: PoolState): void {
    this.byChain.get(pool.chainId)?.delete(key);

    const t0 = pool.tokenPair.token0.address.toLowerCase();
    const t1 = pool.tokenPair.token1.address.toLowerCase();
    this.byToken.get(t0)?.delete(key);
    this.byToken.get(t1)?.delete(key);

    this.byDex.get(pool.dexName)?.delete(key);

    const pairKey = this.makePairKey(t0, t1);
    this.byPair.get(pairKey)?.delete(key);

    const symKey = [pool.tokenPair.token0.symbol, pool.tokenPair.token1.symbol].sort().join(':');
    this.bySymbolPair.get(symKey)?.delete(key);
  }

  private addToSet<K>(map: Map<K, Set<string>>, key: K, value: string): void {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    set.add(value);
  }

  private makePairKey(a: string, b: string): string {
    return [a.toLowerCase(), b.toLowerCase()].sort().join(':');
  }

  private resolveAddresses(addrs: Set<string>): PoolState[] {
    const result: PoolState[] = [];
    for (const addr of addrs) {
      const pool = this.pools.get(addr);
      if (pool) result.push(pool);
    }
    return result;
  }
}
