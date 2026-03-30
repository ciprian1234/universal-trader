// ================================================================================================
// DEX ADAPTERS ROUTING LOGIC

import type { DexPoolState, DexProtocol, DexV3PoolState, DexV4PoolState, DexVenueName } from '@/shared/data-model/layer1';
import * as V2 from './uniswap-v2';
import * as V3 from './uniswap-v3';
import * as V4 from './uniswap-v4';
import type { PoolEvent, V2SyncEvent, V3SwapEvent, V4SwapEvent } from '../interfaces';
import type { TokenPairOnChain } from '@/shared/data-model/token';
import type { ChainConfig, DexConfig, DexV2Config, DexV3Config, DexV4Config } from '@/config/models';
import { createLogger, printPool, safeStringify } from '@/utils';
import type { Blockchain, Multical3Input } from '../blockchain';
import type { WorkerDb } from '../../db';
import type { TokenManager } from '../token-manager';
import type { PriceOracle } from '../price-oracle';
import { formatUnits } from 'ethers';

type DexAdapterInput = {
  db: WorkerDb;
  chainConfig: ChainConfig;
  blockchain: Blockchain;
  tokenManager: TokenManager;
  priceOracle: PriceOracle;
};

// This class serves as a router for DEX-specific logic, directing calls to the appropriate DEX adapter based on the protocol specified in the DexConfig. It also provides a single interface for the DexManager to interact with different DEX protocols without needing to know the details of each one.
export class DexAdapter {
  private readonly logger;
  private readonly chainConfig: ChainConfig;
  private readonly db: WorkerDb;
  private readonly blockchain: Blockchain;
  private readonly tokenManager: TokenManager;
  private readonly priceOracle: PriceOracle;

  // map of DEX configs by venue name for quick access
  private readonly venueConfigs: Map<DexVenueName, DexConfig> = new Map();

  // cached list of all stored pools from DB (used for quick introspection)
  private storedPools: Map<string, DexPoolState> = new Map();

  // ================================================================================================
  // INITIALIZATION AND CONFIGURATION
  // ================================================================================================
  constructor(input: DexAdapterInput) {
    this.logger = createLogger(`[${input.chainConfig.name}.DexAdapter]`);
    this.chainConfig = input.chainConfig;
    this.db = input.db;
    this.blockchain = input.blockchain;
    this.tokenManager = input.tokenManager;
    this.priceOracle = input.priceOracle;

    // Register all DEXes defined in the chain config
    for (const config of this.chainConfig.dexConfigs) {
      this.venueConfigs.set(config.name, config);

      // Initialize necessary contracts for each DEX based on its protocol
      if (config.protocol === 'v2') {
        this.blockchain.initContract(config.factoryAddress, V2.FACTORY_ABI);
        this.blockchain.initContract(config.routerAddress, V2.ROUTER_ABI);
      } else if (config.protocol === 'v3') {
        this.blockchain.initContract(config.factoryAddress, V3.FACTORY_ABI);
        this.blockchain.initContract(config.quoterAddress, V3.QUOTER_ABI);
        this.blockchain.initContract(config.routerAddress, V3.ROUTER_ABI);
      } else if (config.protocol === 'v4') {
        this.blockchain.initContract(config.poolManagerAddress, V4.POOL_MANAGER_ABI);
        this.blockchain.initContract(config.stateViewAddress, V4.STATE_VIEW_ABI);
        this.blockchain.initContract(config.positionManagerAddress, V4.POSITION_MANAGER_ABI);
      } else {
        throw new Error(`Unsupported DexConfig: ${safeStringify(config)}`);
      }
    }
    this.logger.info(`✅ Configured DEX venues: ${[...this.venueConfigs.keys()].join(', ')}`);
  }

  // init load stored pools from DB and cache them
  async init() {
    // load stored pools from DB into cache for quick lookup during pool discovery
    const dbPools = await this.db.loadAllPools();
    for (const pool of dbPools) {
      this.storedPools.set(pool.id, pool.state);
      // init contracts for faster execution of handleEventForUnknownPool later
    }
    this.logger.info(`📦 Cached ${dbPools.length} stored pools from DB`);
  }

  async loadPoolsFromStorageCache(): Promise<DexPoolState[]> {
    const pools: DexPoolState[] = [];
    for (const pool of this.storedPools.values()) {
      if (pool.protocol !== 'v2') continue; // TESTING ONLY
      // TODO: filter only pools which  are active/reserves are not zero, no errors, etc..
      const initializedPool = this.initPoolFromStorage(pool, undefined);
      await Promise.all([
        this.tokenManager.ensureTokenRegistered(initializedPool.tokenPair.token0.address, 'address'),
        this.tokenManager.ensureTokenRegistered(initializedPool.tokenPair.token1.address, 'address'),
      ]);
      pools.push(initializedPool);
    }
    return pools;
  }

  // ================================================================================================
  // ADAPTER ROUTING
  // ================================================================================================

  updatePoolFromEvent(pool: DexPoolState, poolEvent: PoolEvent): DexPoolState {
    if (pool.protocol === 'v2') V2.updatePoolFromEvent(pool, poolEvent as V2SyncEvent);
    else if (pool.protocol === 'v3') V3.updatePoolFromEvent(pool, poolEvent);
    else if (pool.protocol === 'v4') V4.updatePoolFromEvent(pool, poolEvent as V4SwapEvent);
    else throw new Error(`Unsupported operation for pool: ${safeStringify(pool)} and event: ${safeStringify(poolEvent)}`);
    pool.error = null; // if we reached here we can clear if any error
    this.deriveTokenPricesAndLiquidity(pool);
    return pool;
  }

  async handleEventForUnknownPool(event: PoolEvent): Promise<DexPoolState | null> {
    const ctx = { blockchain: this.blockchain, tokenManager: this.tokenManager, configs: this.chainConfig.dexConfigs };
    // first check if we can find the pool in storedPools, otherwise introspect pool from event data
    let pool = this.storedPools.get(event.poolId) ?? null;
    if (pool) {
      this.logger.debug(`Found pool with id: ${pool.id} in storedPools cache, initializing from storage...`);
      pool = this.initPoolFromStorage(pool, event);
      await this.tokenManager.ensureTokenRegistered(pool.tokenPair.token0.address, 'address');
      await this.tokenManager.ensureTokenRegistered(pool.tokenPair.token1.address, 'address');
      this.deriveTokenPricesAndLiquidity(pool);
    } else {
      this.logger.debug(`Pool for event ${event.poolId} not found in cache, introspecting from event data...`);
      if (event.protocol === 'v2') pool = await V2.introspectPoolFromEvent(ctx, event as V2SyncEvent);
      else if (event.protocol === 'v3') pool = await V3.introspectPoolFromEvent(ctx, event as V3SwapEvent);
      else if (event.protocol === 'v4') pool = await V4.introspectPoolFromEvent(ctx, event as V4SwapEvent);
      else throw new Error(`Unsupported pool event: ${safeStringify(event)}`);
      pool.venue.name = this.identifyVenueNameForPool(pool);
      this.deriveTokenPricesAndLiquidity(pool);
      this.savePoolToStorage(pool);
    }
    return pool;
  }

  private identifyVenueNameForPool(pool: DexPoolState): DexVenueName {
    const dexConfigListByProtocol = this.chainConfig.dexConfigs.filter((config) => config.protocol === pool.protocol);
    if (pool.protocol === 'v2') return V2.identifyVenueForPool(pool, dexConfigListByProtocol as DexV2Config[]);
    else if (pool.protocol === 'v3') return V3.identifyVenueForPool(pool, dexConfigListByProtocol as DexV3Config[]);
    else if (pool.protocol === 'v4') return V4.identifyVenueForPool(pool, dexConfigListByProtocol as DexV4Config[]);
    else return 'unknown';
  }

  private initPoolFromStorage(storedPool: DexPoolState, poolEvent: PoolEvent | undefined): DexPoolState {
    let initializedPool: DexPoolState;
    if (storedPool.protocol === 'v2') {
      initializedPool = V2.initPool(this.blockchain, {
        poolAddress: storedPool.address,
        tokenPair: storedPool.tokenPair,
        venue: storedPool.venue,
        event: poolEvent as V2SyncEvent,
      });
    } else if (storedPool.protocol === 'v3') {
      initializedPool = V3.initPool(this.blockchain, {
        poolAddress: storedPool.address,
        tokenPair: storedPool.tokenPair,
        venue: storedPool.venue,
        feeBps: storedPool.feeBps,
        tickSpacing: storedPool.tickSpacing,
        event: poolEvent as V3SwapEvent,
      });
    } else if (storedPool.protocol === 'v4') {
      initializedPool = V4.initPool(this.blockchain, {
        poolKeyHash: storedPool.poolKeyHash,
        poolManagerAddress: storedPool.address, // all V4 pools share the same poolManagerAddress
        tokenPair: storedPool.tokenPair,
        venue: storedPool.venue,
        feeBps: storedPool.feeBps,
        tickSpacing: storedPool.tickSpacing,
        hooks: storedPool.hooks,
        event: poolEvent as V4SwapEvent,
      });
    } else throw new Error(`Unsupported init operation for pool: ${safeStringify(storedPool)}`);
    return initializedPool;
  }

  // update input list of pools in batch using multicall3
  async updatePoolsInBatch(pools: Map<string, DexPoolState>): Promise<void> {
    const calls: Multical3Input[] = [];
    const callsMap: {
      poolId: string;
      callType: 'v2-reserves' | 'v3-slot0' | 'v3-liquidity' | 'v4-slot0' | 'v4-liquidity';
    }[] = [];

    // 1. build call inputs and mapping to decode results later
    for (const pool of pools.values()) {
      if (pool.protocol === 'v2') {
        calls.push({
          target: pool.address,
          allowFailure: true,
          callData: V2.POOL_INTERFACE.encodeFunctionData('getReserves', []),
        });
        callsMap.push({ poolId: pool.id, callType: 'v2-reserves' });
      } else if (pool.protocol === 'v3') {
        calls.push(
          { target: pool.address, allowFailure: true, callData: V3.POOL_INTERFACE.encodeFunctionData('slot0', []) },
          { target: pool.address, allowFailure: true, callData: V3.POOL_INTERFACE.encodeFunctionData('liquidity', []) },
        );
        callsMap.push({ poolId: pool.id, callType: 'v3-slot0' }, { poolId: pool.id, callType: 'v3-liquidity' });
      } else if (pool.protocol === 'v4') {
        const config = this.requireConfig(pool.venue.name) as DexV4Config;
        const stateViewAddr = config.stateViewAddress;
        calls.push(
          {
            target: stateViewAddr,
            allowFailure: true,
            callData: V4.STATE_VIEW_INTERFACE.encodeFunctionData('getSlot0', [pool.poolKeyHash]),
          },
          {
            target: stateViewAddr,
            allowFailure: true,
            callData: V4.STATE_VIEW_INTERFACE.encodeFunctionData('getLiquidity', [pool.poolKeyHash]),
          },
        );
        callsMap.push({ poolId: pool.id, callType: 'v4-slot0' }, { poolId: pool.id, callType: 'v4-liquidity' });
      } else {
        this.logger.warn(`Unsupported protocol for batch update, skipping pool: ${printPool(pool)}`);
      }
    }

    // 2. execute multicall3
    const callResults = await this.blockchain.executeMulticall3(calls);
    if (!callResults || callResults.length !== calls.length)
      throw new Error(`Invalid multicall3 response, expected ${calls.length} results but got ${callResults?.length}`);

    // 3. Collect decoded results per pool
    // For v3/v4 we need both slot0 and liquidity before we can update, so collect first
    const poolData: Map<string, { slot0?: any; liquidity?: any; reserves?: any; error?: string }> = new Map();
    for (let i = 0; i < callResults.length; i++) {
      const result = callResults[i];
      const { poolId, callType } = callsMap[i];

      if (!poolData.has(poolId)) poolData.set(poolId, {});
      const data = poolData.get(poolId)!;

      if (!result?.success || !result.returnData) {
        data.error = `Multicall3 failed for ${callType}`;
        continue;
      }

      if (callType === 'v2-reserves') {
        data.reserves = V2.POOL_INTERFACE.decodeFunctionResult('getReserves', result.returnData);
      } else if (callType === 'v3-slot0') {
        data.slot0 = V3.POOL_INTERFACE.decodeFunctionResult('slot0', result.returnData);
      } else if (callType === 'v3-liquidity') {
        data.liquidity = V3.POOL_INTERFACE.decodeFunctionResult('liquidity', result.returnData);
      } else if (callType === 'v4-slot0') {
        data.slot0 = V4.STATE_VIEW_INTERFACE.decodeFunctionResult('getSlot0', result.returnData);
      } else if (callType === 'v4-liquidity') {
        data.liquidity = V4.STATE_VIEW_INTERFACE.decodeFunctionResult('getLiquidity', result.returnData);
      }
    }

    for (const pool of pools.values()) {
      const data = poolData.get(pool.id);
      if (!data || data.error) {
        pool.error = data?.error ?? 'No data returned from multicall3';
        continue;
      }

      const { token0, token1 } = pool.tokenPair;

      if (pool.protocol === 'v2' && data.reserves) {
        V2.updatePool(pool, data.reserves);
      } else if (pool.protocol === 'v3' && data.slot0 && data.liquidity != null) {
        const [sqrtPriceX96, tick] = data.slot0;
        const liquidity = data.liquidity[0];
        V3.updatePool(pool, { sqrtPriceX96, tick, liquidity });
      } else if (pool.protocol === 'v4' && data.slot0 && data.liquidity != null) {
        const [sqrtPriceX96, tick] = data.slot0;
        const liquidity = data.liquidity[0];
        V4.updatePool(pool, { sqrtPriceX96, tick, liquidity });
      } else {
        this.logger.warn(`⚠️ Incomplete multicall data for pool ${pool.id}, skipping update`, { data });
        pool.error = 'Incomplete multicall data';
        continue;
      }

      this.deriveTokenPricesAndLiquidity(pool);
    }
  }

  async updatePoolTicksInBatch(pools: Map<string, DexPoolState>, tickRange = 10): Promise<void> {
    const calls: Multical3Input[] = [];
    const callsMap: { poolId: string; protocol: DexProtocol; tick: number }[] = [];

    for (const pool of pools.values()) {
      if (pool.protocol !== 'v3' && pool.protocol !== 'v4') continue;

      const currentTick = pool.tick;
      const tickSpacing = pool.tickSpacing;
      const minTick = Math.floor((currentTick - tickRange * tickSpacing) / tickSpacing) * tickSpacing;
      const maxTick = Math.ceil((currentTick + tickRange * tickSpacing) / tickSpacing) * tickSpacing;

      for (let t = minTick; t <= maxTick; t += tickSpacing) {
        if (pool.protocol === 'v3') {
          calls.push({
            target: pool.address,
            allowFailure: true,
            callData: V3.POOL_INTERFACE.encodeFunctionData('ticks', [t]),
          });
        } else if (pool.protocol === 'v4') {
          const config = this.requireConfig(pool.venue.name) as DexV4Config;
          calls.push({
            target: config.stateViewAddress,
            allowFailure: true,
            callData: V4.STATE_VIEW_INTERFACE.encodeFunctionData('getTickLiquidity', [pool.poolKeyHash, t]),
          });
        }
        callsMap.push({ poolId: pool.id, protocol: pool.protocol, tick: t });
      }
    }

    if (calls.length === 0) return;
    this.logger.info(`🎯 Fetching ticks for ${pools.size} pools (${calls.length} tick calls in multicall)...`);

    const results = await this.blockchain.executeMulticall3(calls);

    // Collect results grouped by pool
    const poolTicks: Map<string, { tick: number; liquidityNet: bigint }[]> = new Map();

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const { poolId, protocol, tick } = callsMap[i];
      if (!result?.success || !result.returnData) continue;

      try {
        let liquidityNet: bigint;

        if (protocol === 'v3') {
          const decoded = V3.POOL_INTERFACE.decodeFunctionResult('ticks', result.returnData);
          liquidityNet = BigInt(decoded.liquidityNet);
        } else {
          // V4: getTickLiquidity returns (uint128 liquidityGross, int128 liquidityNet)
          const decoded = V4.STATE_VIEW_INTERFACE.decodeFunctionResult('getTickLiquidity', result.returnData);
          liquidityNet = BigInt(decoded.liquidityNet);
        }

        if (liquidityNet === 0n) continue;

        if (!poolTicks.has(poolId)) poolTicks.set(poolId, []);
        poolTicks.get(poolId)!.push({ tick, liquidityNet });
      } catch {
        // skip malformed responses
      }
    }

    // Apply to pools
    for (const pool of pools.values()) {
      if (pool.protocol !== 'v3' && pool.protocol !== 'v4') continue;
      const ticks = poolTicks.get(pool.id);
      pool.ticks = ticks ? ticks.sort((a, b) => a.tick - b.tick) : [];
    }

    this.logger.info(`✅ Fetched ticks for ${poolTicks.size} pools with initialized ticks`);
  }

  /**
   * Fetch initialized ticks for multiple V3/V4 pools using tick bitmap approach.
   * Round 1: fetch bitmap words covering the tick range (1 multicall)
   * Round 2: fetch liquidityNet only for initialized ticks found in bitmaps (1 multicall)
   * Mutates pool.ticks in place.
   *
   * @param tickRange - number of bitmap words to scan in each direction from currentTick
   *                    each word covers 256 * tickSpacing ticks, so wordRange=2 covers
   *                    ~512 * tickSpacing ticks in each direction
   */
  async updatePoolTicksInBatch_v2(pools: Map<string, DexV3PoolState | DexV4PoolState>, wordRange = 4): Promise<void> {
    // ──────────────────────────────────────────────
    // ROUND 1: Fetch tick bitmap words
    // ──────────────────────────────────────────────
    const bitmapCalls: Multical3Input[] = [];
    const bitmapCallMap: { poolId: string; wordPos: number }[] = [];

    for (const pool of pools.values()) {
      const compressedTick = Math.floor(pool.tick / pool.tickSpacing);
      const currentWord = compressedTick >> 8; // arithmetic right shift = floor(compressedTick / 256)

      for (let w = currentWord - wordRange; w <= currentWord + wordRange; w++) {
        if (pool.protocol === 'v3') {
          bitmapCalls.push({
            target: pool.address,
            allowFailure: true,
            callData: V3.POOL_INTERFACE.encodeFunctionData('tickBitmap', [w]),
          });
        } else {
          const config = this.requireConfig(pool.venue.name) as DexV4Config;
          bitmapCalls.push({
            target: config.stateViewAddress,
            allowFailure: true,
            callData: V4.STATE_VIEW_INTERFACE.encodeFunctionData('getTickBitmap', [pool.poolKeyHash, w]),
          });
        }
        bitmapCallMap.push({ poolId: pool.id, wordPos: w });
      }
    }

    const bitmapResults = await this.blockchain.executeMulticall3(bitmapCalls);

    // Parse bitmaps to find initialized tick positions
    // Map: poolId -> list of actual tick values that are initialized
    const initializedTicksByPool: Map<string, number[]> = new Map();

    for (let i = 0; i < bitmapResults.length; i++) {
      const result = bitmapResults[i];
      const { poolId, wordPos } = bitmapCallMap[i];
      if (!result?.success || !result.returnData) continue;

      const pool = pools.get(poolId)! as DexV3PoolState | DexV4PoolState;

      let bitmap: bigint;
      try {
        if (pool.protocol === 'v3') {
          const decoded = V3.POOL_INTERFACE.decodeFunctionResult('tickBitmap', result.returnData);
          bitmap = BigInt(decoded[0]);
        } else {
          const decoded = V4.STATE_VIEW_INTERFACE.decodeFunctionResult('getTickBitmap', result.returnData);
          bitmap = BigInt(decoded[0]);
        }
      } catch {
        continue;
      }

      if (bitmap === 0n) continue; // no initialized ticks in this word

      // Extract set bits → tick values
      if (!initializedTicksByPool.has(poolId)) initializedTicksByPool.set(poolId, []);
      const ticks = initializedTicksByPool.get(poolId)!;

      for (let bit = 0; bit < 256; bit++) {
        if ((bitmap >> BigInt(bit)) & 1n) {
          const compressedTick = (wordPos << 8) + bit; // wordPos * 256 + bit
          const actualTick = compressedTick * pool.tickSpacing;
          ticks.push(actualTick);
        }
      }
    }

    // ──────────────────────────────────────────────
    // ROUND 2: Fetch liquidityNet for initialized ticks only
    // ──────────────────────────────────────────────
    const tickCalls: Multical3Input[] = [];
    const tickCallMap: { poolId: string; tick: number }[] = [];

    for (const [poolId, ticks] of initializedTicksByPool) {
      const pool = pools.get(poolId)! as DexV3PoolState | DexV4PoolState;

      for (const tick of ticks) {
        if (pool.protocol === 'v3') {
          tickCalls.push({
            target: pool.address,
            allowFailure: true,
            callData: V3.POOL_INTERFACE.encodeFunctionData('ticks', [tick]),
          });
        } else {
          const config = this.requireConfig(pool.venue.name) as DexV4Config;
          tickCalls.push({
            target: config.stateViewAddress,
            allowFailure: true,
            callData: V4.STATE_VIEW_INTERFACE.encodeFunctionData('getTickLiquidity', [pool.poolKeyHash, tick]),
          });
        }
        tickCallMap.push({ poolId, tick });
      }
    }

    const totalInitialized = tickCallMap.length;
    this.logger.info(`🎯 Round 2: Fetching ${totalInitialized} initialized ticks for ${initializedTicksByPool.size} pools...`);

    const tickResults = await this.blockchain.executeMulticall3(tickCalls);

    // Collect decoded ticks grouped by pool
    const poolTicks: Map<string, { tick: number; liquidityNet: bigint }[]> = new Map();

    for (let i = 0; i < tickResults.length; i++) {
      const result = tickResults[i];
      const { poolId, tick } = tickCallMap[i];
      if (!result?.success || !result.returnData) continue;
      const pool = pools.get(poolId)!;

      try {
        let liquidityNet: bigint;
        if (pool.protocol === 'v3') {
          const decoded = V3.POOL_INTERFACE.decodeFunctionResult('ticks', result.returnData);
          liquidityNet = BigInt(decoded.liquidityNet);
        } else {
          const decoded = V4.STATE_VIEW_INTERFACE.decodeFunctionResult('getTickLiquidity', result.returnData);
          liquidityNet = BigInt(decoded.liquidityNet);
        }

        if (liquidityNet === 0n) continue; // shouldn't happen since bitmap said initialized, but defensive

        if (!poolTicks.has(poolId)) poolTicks.set(poolId, []);
        poolTicks.get(poolId)!.push({ tick, liquidityNet });
      } catch {
        // skip malformed
      }
    }

    // Apply to pools (sorted ascending)
    for (const pool of pools.values()) {
      const ticks = poolTicks.get(pool.id);
      pool.ticks = ticks ? ticks.sort((a, b) => a.tick - b.tick) : [];
    }

    this.logger.info(
      `✅ Bitmap tick fetch complete: ${totalInitialized} initialized ticks across ${initializedTicksByPool.size} pools (2 multicalls)`,
    );
  }

  getFeePercent(pool: DexPoolState): number {
    // for v2 feeBps its 30 => 0.3%, for v3/v4 feeBps its 3000 => 0.3%
    if (pool.protocol === 'v2') return pool.feeBps / 100;
    else if (pool.protocol === 'v3') return pool.feeBps / 10000;
    else if (pool.protocol === 'v4') return pool.feeBps / 10000;
    else throw new Error(`Unsupported operation for pool: ${safeStringify(pool)}`);
  }

  private async discoverPoolsForVenue(venueName: DexVenueName, tokenPair: TokenPairOnChain): Promise<DexPoolState[]> {
    const ctx = { blockchain: this.blockchain, tokenManager: this.tokenManager, config: this.requireConfig(venueName) };
    if (ctx.config.protocol === 'v2') return await V2.discoverPools(ctx, tokenPair);
    else if (ctx.config.protocol === 'v3') return await V3.discoverPools(ctx, tokenPair);
    else if (ctx.config.protocol === 'v4') return await V4.discoverPools(ctx, tokenPair);
    else return [];
  }

  simulateSwap(pool: DexPoolState, amountIn: bigint, zeroForOne: boolean): bigint {
    if (pool.protocol === 'v2') return V2.simulateSwap(pool, amountIn, zeroForOne);
    else if (pool.protocol === 'v3') return V3.simulateSwap(pool, amountIn, zeroForOne);
    else if (pool.protocol === 'v4') return V4.simulateSwap(pool, amountIn, zeroForOne);
    else throw new Error(`Unsupported operation for pool: ${safeStringify(pool)}`);
  }

  // ================================================================================================
  // CORE LOGIC
  // ================================================================================================

  //
  // Find pools for a given token pair by iterating over all configured venues
  // if discoverPoolsForTokenPair its triggerd from event we can skip poolId that caused the event to avoid duplicate (re)discovery
  //
  async discoverPoolsForTokenPair(tokenPair: TokenPairOnChain, skipPoolId = ''): Promise<DexPoolState[]> {
    const allPools: DexPoolState[] = [];
    for (const [venueName, config] of this.venueConfigs.entries()) {
      const foundStoredPools = this.findInStoredPools(tokenPair, venueName);
      // if at least 1 pool its cached => consider for now that the pair its discovered
      if (foundStoredPools.length > 0) {
        this.logger.debug(
          `Found ${foundStoredPools.length} pools for pair ${tokenPair.key} in storage, skipping discovery for venue ${venueName}...`,
        );
        const initializedPools = await Promise.all(foundStoredPools.map((p) => this.initPoolFromStorage(p, undefined)));
        allPools.push(...initializedPools);
      } else {
        const discoveredPools = await this.discoverPoolsForVenue(venueName, tokenPair);
        allPools.push(...discoveredPools);
        for (const pool of discoveredPools) {
          this.logger.info(
            `✅ Discovered new pool on ${pool.venue.name.padEnd(15)} (${pool.tokenPair.key}:${pool.feeBps
              .toString()
              .padEnd(5)}) (id: ${pool.id})`,
          );
        }
      }
    }

    // update all discovered pools with derived USD prices and liquidity and persist to DB
    // note: if skipPoolId provided, filter out that pool from update to avoid duplicate update after event trigger
    // return await Promise.all(allPools.filter((pool) => pool.id !== skipPoolId).map((pool) => this.updatePoolFromCall(pool)));
    return allPools; // TBD: update with batch call to optimize
  }

  //
  // derive USD prices and calculate total liquidityUSD for a pool
  //
  private deriveTokenPricesAndLiquidity(pool: DexPoolState): void {
    // derive USD prices and calculate total liquidityUSD
    try {
      this.priceOracle.deriveFromPool(pool);
      pool.totalLiquidityUSD = this.priceOracle.estimatePoolLiquidityUSD(pool);
    } catch (error) {
      pool.error = `Price derivation failed: ${error instanceof Error ? error.message : String(error)}`;
      this.logger.warn(`Failed to derive priceUSD/liquidity for pool: ${printPool(pool)}`);
    }
  }

  //
  // handle stored pools cache and database sync
  // note: for registered pool events - only update cache but not persist to DB immediately
  private savePoolToStorage(pool: DexPoolState) {
    this.storedPools.set(pool.id, pool); // update stored pools cache - always
    this.db
      .upsertPool(pool, 'event', true)
      .catch((e) => this.logger.error(`Failed to save new pool ${printPool(pool)} to DB:`, { error: e }));
  }

  async syncRegisteredPoolsToStorage(registeredPools: Map<string, DexPoolState>): Promise<void> {
    const PROMISE_BATCH_SIZE = 20;

    const poolEntries = Array.from(registeredPools.entries());
    for (let i = 0; i < poolEntries.length; i += PROMISE_BATCH_SIZE) {
      const batch = poolEntries.slice(i, i + PROMISE_BATCH_SIZE);
      this.logger.info(`Syncing batch of ${batch.length} pools to DB (${i + 1}-${i + batch.length} of ${poolEntries.length})...`);
      await Promise.all(
        batch.map(([poolId, pool]) =>
          this.db
            .upsertPool(pool, 'sync', true)
            .catch((e) => this.logger.error(`Failed to sync pool ${printPool(pool)} to DB:`, { error: e })),
        ),
      );
    }

    this.logger.info(`✅ Synced ${registeredPools.size} registered pools to DB`);
  }

  // ================================================================================================
  // HELPERS
  // ================================================================================================

  /**
   * 🔍 FIND STORED POOLS BY TOKEN PAIR
   */
  private findInStoredPools(tokenPair: TokenPairOnChain, venue: DexVenueName): DexPoolState[] {
    const foundPools: DexPoolState[] = [];
    for (const pool of this.storedPools.values()) {
      if (pool.tokenPair.key === tokenPair.key && pool.venue.name === venue) foundPools.push(pool);
    }
    return foundPools;
  }

  // helper to get config for venue or throw if not exist
  requireConfig(venueName: DexVenueName) {
    const config = this.venueConfigs.get(venueName);
    if (!config) throw new Error(`No config for venue: ${venueName}`);
    return config;
  }

  /**
   * 🖥️ Display pool
   */
  displayPoolState(pool: DexPoolState): void {
    const s0 = pool.tokenPair.token0.symbol;
    const s1 = pool.tokenPair.token1.symbol;

    this.logger.info(`💧 ${pool.venue.name} ${s0}-${s1} (feeBP: ${pool.feeBps}) - Pool ID: ${pool.id}`);
    this.logger.info(`   📈 Price: ${s0} = ${pool.spotPrice0to1}${s1}`);
    this.logger.info(`   📉 Price: ${s1} = ${pool.spotPrice1to0}${s0}`);
    this.logger.info(`   💰 Total Liquidity in USD: $${pool.totalLiquidityUSD?.toFixed(2)}`);

    if (pool.protocol === 'v3') {
      this.logger.info(`   🧱 Current Tick: ${pool.tick} (tickSpacing: ${pool.tickSpacing})`);
      // log tick ranges for each liquidity position
      if (pool.ticks) {
        pool.ticks.forEach((pos, index) => {
          this.logger.info(`       🧱 Position ${index + 1}: Liquidity: ${pos.liquidityNet.toString()} - Tick: ${pos.tick}`);
        });
      }
    }

    this.logger.info(`\n\n`);
  }

  /**
   * 🖥️ Display event
   */
  displayEvent(event: PoolEvent, previousState: DexPoolState, updatedState: DexPoolState): void {
    const s0 = updatedState.tokenPair.token0.symbol;
    const s1 = updatedState.tokenPair.token1.symbol;

    // get info data
    const oldSpotPriceToken0InToken1 = previousState.spotPrice0to1;
    const oldSpotPriceToken1InToken0 = previousState.spotPrice1to0;
    const newSpotPriceToken0InToken1 = updatedState.spotPrice0to1;
    const newSpotPriceToken1InToken0 = updatedState.spotPrice1to0;

    const oldNormalizedReserve0 = parseFloat(formatUnits(previousState.reserve0!, previousState.tokenPair.token0.decimals));
    const oldNormalizedReserve1 = parseFloat(formatUnits(previousState.reserve1!, previousState.tokenPair.token1.decimals));
    const newNormalizedReserve0 = parseFloat(formatUnits(updatedState.reserve0!, updatedState.tokenPair.token0.decimals));
    const newNormalizedReserve1 = parseFloat(formatUnits(updatedState.reserve1!, updatedState.tokenPair.token1.decimals));

    const priceChangePercent = ((newSpotPriceToken0InToken1 - oldSpotPriceToken0InToken1) / oldSpotPriceToken0InToken1) * 100;

    this.logger.info(`   🔗 Block: ${event.meta.blockNumber} - 📄 TX: ${event.meta.transactionHash}`);
    this.logger.info(`   💧 Reserve0: ${oldNormalizedReserve0} -> ${newNormalizedReserve0} (${s0})`);
    this.logger.info(`   💧 Reserve1: ${oldNormalizedReserve1} -> ${newNormalizedReserve1} (${s1})`);
    this.logger.info(`   📈 Price: 1${s0} costs ${newSpotPriceToken0InToken1}${s1} -> ${priceChangePercent.toFixed(6)}%`);
    this.logger.info(`   📉 Price: 1${s1} costs ${newSpotPriceToken1InToken0}${s0} -> ${priceChangePercent.toFixed(6)}%`);
    this.logger.info(`   ✅ Pool state synchronized successfully\n`);
  }

  // ================================================================================================
  getStats() {
    return {
      storedPools: this.storedPools.size,
    };
  }
}
