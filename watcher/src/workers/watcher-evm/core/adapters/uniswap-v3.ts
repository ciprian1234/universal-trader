/**
 * 🦄 DEX V3 ADAPTER: High-performance V3 DEX adapter with concentrated liquidity
 */
import { ethers } from 'ethers';
import type { TradeQuote, PoolEvent, V3SwapEvent } from '../interfaces';
import * as SqrtMath from './lib/sqrtPriceMath';
import { dexPoolId, type DexV3PoolState, type DexVenue } from '@/shared/data-model/layer1';
import { getCanonicalPairId, type TokenOnChain, type TokenPairOnChain } from '@/shared/data-model/token';
import { calculatePriceImpact } from './lib/math';
import { createLogger } from '@/utils/logger';
import type { DexAdapterContext, PoolIntrospectContext } from './interfaces';
import type { Blockchain } from '../blockchain';

// ================================================================================================
// DEX V3 ADAPTER
// ================================================================================================

const logger = createLogger('DexV3Adapter');

// Standard fee tiers in V3
const FEE_TIERS = [100, 500, 3000, 10000]; // 0.01%, 0.05%, 0.3%, 1% (in v3 basis points are denominated by 1,000,000)

// ABI definitions
export const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
];

export const POOL_ABI = [
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function fee() external view returns (uint24)',
  'function tickSpacing() external view returns (int24)',
  'function ticks(int24 tick) external view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)',
  'function liquidity() external view returns (uint128)',
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function feeGrowthGlobal0X128() external view returns (uint256)',
  'function feeGrowthGlobal1X128() external view returns (uint256)',
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
  'event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
  'event Mint(address indexed sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
];

export const QUOTER_ABI = [
  'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)',
  'function quoteExactOutputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountOut, uint160 sqrtPriceLimitX96) external returns (uint256 amountIn)',
];

export const ROUTER_ABI = [
  'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];

// ================================================================================================
// POOL DISCOVERY AND STATE MANAGEMENT
// ================================================================================================

/**
 * 🔍 FIND POOLS: Find all V3 pools for a token pair across all fee tiers
 */
export async function discoverPools(ctx: DexAdapterContext, tokenPair: TokenPairOnChain): Promise<DexV3PoolState[]> {
  if (ctx.config.protocol !== 'v3') throw new Error(`Invalid config protocol for V3 adapter: ${ctx.config.protocol}`);
  const factoryContract = ctx.blockchain.getContract(ctx.config.factoryAddress);
  if (!factoryContract) throw new Error(`FactoryV3 contract not found at address: ${ctx.config.factoryAddress}`);

  const symbol0 = tokenPair.token0.symbol;
  const symbol1 = tokenPair.token1.symbol;
  const pools: DexV3PoolState[] = [];

  // Check all fee tiers
  for (const fee of FEE_TIERS) {
    try {
      const poolAddress = await factoryContract.getPool(tokenPair.token0.address, tokenPair.token1.address, fee);
      if (poolAddress === ethers.ZeroAddress) continue;

      const venue = { name: ctx.config.name, type: 'dex' as const, chainId: ctx.blockchain.chainId };
      const poolState = await initPool(ctx.blockchain, { poolAddress, tokenPair, venue, feeBps: fee });
      pools.push(poolState);
    } catch (error) {
      // Pool doesn't exist for this fee tier, continue
      logger.debug(`No ${fee / 10000}% pool found for ${symbol0}/${symbol1}`);
    }
  }

  return pools;
}

// =====================================================================================================================
// Introspect pool from event
// =====================================================================================================================
export async function introspectPoolFromEvent(ctx: PoolIntrospectContext, event: V3SwapEvent): Promise<DexV3PoolState> {
  const poolAddress = event.sourceAddress.toLowerCase();
  let poolContract = ctx.blockchain.getContract(poolAddress);
  if (!poolContract) poolContract = ctx.blockchain.initContract(poolAddress, POOL_ABI);

  const [token0Address, token1Address, fee] = await Promise.all([
    poolContract.token0(),
    poolContract.token1(),
    poolContract.fee(),
  ]);
  const token0 = await ctx.tokenManager.ensureTokenRegistered(token0Address, 'address');
  const token1 = await ctx.tokenManager.ensureTokenRegistered(token1Address, 'address');

  if (!token0.trusted) logger.warn(`⚠️ Pool:${poolAddress} Token0 ${token0.symbol} (${token0.address}) is not trusted!`);
  if (!token1.trusted) logger.warn(`⚠️ Pool:${poolAddress} Token1 ${token1.symbol} (${token1.address}) is not trusted!`);
  const tokenPair = { token0, token1, key: `${token0.symbol}-${token1.symbol}` };

  const venue = { name: 'unknown' as const, type: 'dex' as const, chainId: ctx.blockchain.chainId };
  // TODO: - attempt to find the venue

  const poolState = await initPool(ctx.blockchain, { poolAddress, tokenPair, venue, feeBps: Number(fee), event });
  return poolState;
}

/**
 * 🏗 INIT POOL: Initialize V3 pool state with static data (called once when pool is first discovered)
 */
async function initPool(
  blockchain: Blockchain,
  input: {
    poolAddress: string;
    tokenPair: TokenPairOnChain;
    venue: DexVenue;
    feeBps: number;
    event?: V3SwapEvent; // optional event for initializing dynamic fields if available (used when introspecting from event)
  },
): Promise<DexV3PoolState> {
  // init pool contract
  const contract = blockchain.initContract(input.poolAddress, POOL_ABI);

  // Fetch pool static data
  const [tickSpacing /* feeGrowthGlobal0X128, feeGrowthGlobal1X128 */] = await Promise.all([
    contract.tickSpacing(),
    // contract.feeGrowthGlobal0X128(),
    // contract.feeGrowthGlobal1X128(),
  ]);

  if (!tickSpacing) throw new Error(`Failed to fetch tick spacing for pool ${input.poolAddress}`);

  const newPool: DexV3PoolState = {
    id: dexPoolId(blockchain.chainId, input.poolAddress),
    address: input.poolAddress,
    venue: input.venue,
    protocol: 'v3',
    pairId: getCanonicalPairId(input.tokenPair.token0, input.tokenPair.token1),
    tokenPair: input.tokenPair,
    feeBps: input.feeBps, // Fee in basis points (500, 3000, 10000)
    tickSpacing: Number(tickSpacing), // Tick spacing for the pool

    // init dynamic fields to zero (updated later)
    sqrtPriceX96: 0n,
    tick: 0,
    liquidity: 0n,
    reserve0: 0n,
    reserve1: 0n,
    spotPrice0to1: 0,
    spotPrice1to0: 0,
  };

  if (input.event) updatePoolFromEvent(newPool, input.event);
  return newPool;
}

/**
 * Update pool state with dynamic data
 */
export async function updatePool(ctx: DexAdapterContext, pool: DexV3PoolState): Promise<DexV3PoolState> {
  const { token0, token1 } = pool.tokenPair;

  const contract = ctx.blockchain.getContract(pool.address);
  if (!contract) throw new Error(`Pool contract not found for address: ${pool.address}`);

  const [slot0, liquidity] = await Promise.all([contract.slot0(), contract.liquidity()]);
  if (!slot0 || !liquidity) throw new Error(`Failed to fetch slot0 or liquidity for pool ${pool.address}`);

  const { reserve0, reserve1 } = SqrtMath.calculateVirtualReserves(slot0.sqrtPriceX96, liquidity);
  pool.reserve0 = reserve0;
  pool.reserve1 = reserve1;
  pool.sqrtPriceX96 = slot0.sqrtPriceX96;
  pool.tick = slot0.tick;
  pool.liquidity = liquidity;
  pool.spotPrice0to1 = calculateSpotPrice(slot0.sqrtPriceX96, token0, token1, true);
  pool.spotPrice1to0 = calculateSpotPrice(slot0.sqrtPriceX96, token0, token1, false);
  await fetchInitializedTicksMulticall3(ctx, pool); // fetch initialized ticks for multi-tick simulation
  return pool;
}

// ================================================================================================
// TRADING AND QUOTES
// ================================================================================================

/**
 * 💰 GET SPOT PRICE: Get current spot price from sqrtPriceX96
 */
function calculateSpotPrice(sqrtPriceX96: bigint, token0: TokenOnChain, token1: TokenOnChain, zeroForOne: boolean): number {
  const price = SqrtMath.sqrtPriceX96ToPrice(sqrtPriceX96, token0.decimals, token1.decimals);
  if (zeroForOne)
    return price; // Price of token0 in token1
  else return 1 / price; // Price of token1 in token0
}

/**
 * 💰 GET TRADE QUOTE: Calculate V3 trade quote using quoter contract
 */
async function getTradeQuote(
  ctx: DexAdapterContext,
  poolState: DexV3PoolState,
  amountIn: bigint,
  zeroForOne: boolean,
): Promise<TradeQuote> {
  if (ctx.config.protocol !== 'v3') throw new Error(`Invalid config protocol for V3 adapter: ${ctx.config.protocol}`);
  const quoterContract = ctx.blockchain.getContract(ctx.config.quoterAddress);
  if (!quoterContract) throw new Error(`Quoter contract not found at address: ${ctx.config.quoterAddress}`);
  if (amountIn <= 0n) throw new Error(`Invalid trade amount: ${amountIn} (must be > 0)`);
  if (poolState.liquidity! <= 0n) throw new Error(`Insufficient liquidity in pool: ${poolState.id}`);
  const { token0, token1 } = poolState.tokenPair;

  try {
    const tokenIn = zeroForOne ? token0.address : token1.address;
    const tokenOut = zeroForOne ? token1.address : token0.address;

    // Use quoter to get exact output amount
    // Note: In production, you'd want to use a static call to avoid state changes
    const amountOut = await quoterContract.quoteExactInputSingle.staticCall(
      tokenIn,
      tokenOut,
      poolState.feeBps,
      amountIn,
      0, // No price limit
    );

    if (amountOut <= 0n) throw new Error(`❌ Quoter contract invalid amountOut: ${amountOut}`);

    // Calculate prices
    const spotPrice = calculateSpotPrice(
      poolState.sqrtPriceX96!,
      poolState.tokenPair.token0,
      poolState.tokenPair.token1,
      zeroForOne,
    );

    const normalizedAmountIn = parseFloat(ethers.formatUnits(amountIn, zeroForOne ? token0.decimals : token1.decimals));
    const normalizedAmountOut = parseFloat(ethers.formatUnits(amountOut, zeroForOne ? token1.decimals : token0.decimals));

    const executionPrice = normalizedAmountOut / normalizedAmountIn;
    const priceImpact = calculatePriceImpact(spotPrice, executionPrice);

    // In V3, slippage is generally close to price impact due to concentrated liquidity
    const slippage = priceImpact;

    return {
      poolState,
      amountIn,
      amountOut,
      executionPrice,
      priceImpact,
      slippage,
      confidence: 0.95, // V3 quotes are reliable but can have more complexity
    };
  } catch (error) {
    throw new Error(`Failed to get V3 trade quote: ${error}`);
  }
}

/**
 * 🧮 SIMULATE V3 SWAP (Using Uniswap V3 SqrtPriceMath)
 * Based on: https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/SqrtPriceMath.sol
 */
export function simulateSwap(poolState: DexV3PoolState, amountIn: bigint, zeroForOne: boolean): bigint {
  return SqrtMath.simulateSwap(poolState, amountIn, zeroForOne);
}

/**
 * 💰 GET FEE PERCENT: Get V3 pool fee percentage
 */
export function getFeePercent(poolState: DexV3PoolState): number {
  return Number(poolState.feeBps) / 10000; // Convert from basis points to percentage (3000 bps = 0.3%)
}

// ================================================================================================
// EVENT HANDLING
// ================================================================================================

/**
 * 🔄 UPDATE POOL STATE FROM EVENT: Fast V3 state updates
 */
export function updatePoolFromEvent(pool: DexV3PoolState, event: PoolEvent): DexV3PoolState {
  if (event.protocol !== 'v3' || event.name !== 'swap') return pool; // Only handle swap events for state updates (sync events not emitted in V3)

  // calculate virtual reserves based on new sqrtPriceX96 and liquidity
  const { reserve0, reserve1 } = SqrtMath.calculateVirtualReserves(event.sqrtPriceX96, event.liquidity); // virtual reserve0 and reserve1

  // Update V3 specific state if available
  pool.reserve0 = reserve0;
  pool.reserve1 = reserve1;
  pool.sqrtPriceX96 = event.sqrtPriceX96!;
  pool.tick = event.tick!;
  pool.liquidity = event.liquidity!;
  pool.latestEventMeta = event.meta;

  // Update derived fields
  const { token0, token1 } = pool.tokenPair;
  pool.spotPrice0to1 = calculateSpotPrice(event.sqrtPriceX96, token0, token1, true);
  pool.spotPrice1to0 = calculateSpotPrice(event.sqrtPriceX96, token0, token1, false);

  // calculate liquidityUSD (requires external price feed)
  try {
    // TODO: update this when implemented price oracle
    // const v0 = this.tokenManager.calculateUSDValue(pool.tokenPair.token0.address, pool.reserve0!) || 0;
    // const v1 = this.tokenManager.calculateUSDValue(pool.tokenPair.token1.address, pool.reserve1!) || 0;
    // pool.totalLiquidityInUSD = v0 + v1; // note: liquidity calculated from virtual reserves
  } catch (error) {
    // this.logger.warn(`❌ Failed to calculate USD liquidity for pool ${event.poolId.value}: ${(error as Error).message}`);
    // pool.totalLiquidityInUSD = 0;
  }

  return pool;
}

/**
 * Fetch initialized ticks around the current tick for multi-tick simulation.
 * Called during pool update, not during simulation.
 */
export async function fetchInitializedTicks(
  ctx: DexAdapterContext,
  pool: DexV3PoolState,
  tickRange: number = 200,
): Promise<void> {
  const contract = ctx.blockchain.getContract(pool.id);
  if (!contract) throw new Error(`Pool contract not found for address: ${pool.address}`);

  const currentTick = pool.tick!;
  const tickSpacing = Number(pool.tickSpacing!);
  pool.tickSpacing = tickSpacing;

  // Align to tick spacing
  const minTick = Math.floor((currentTick - tickRange * tickSpacing) / tickSpacing) * tickSpacing;
  const maxTick = Math.ceil((currentTick + tickRange * tickSpacing) / tickSpacing) * tickSpacing;

  const tickPromises: Promise<{ tick: number; liquidityNet: bigint } | null>[] = [];

  for (let t = minTick; t <= maxTick; t += tickSpacing) {
    tickPromises.push(
      contract.ticks(t).then(
        (data: any) => {
          const liquidityNet = BigInt(data.liquidityNet);
          if (liquidityNet !== 0n) {
            return { tick: t, liquidityNet };
          }
          return null;
        },
        () => null,
      ),
    );
  }

  const results = await Promise.all(tickPromises);
  pool.ticks = results.filter((r): r is { tick: number; liquidityNet: bigint } => r !== null).sort((a, b) => a.tick - b.tick);

  logger.debug(`Fetched ${pool.ticks.length} initialized ticks for pool ${pool.id}`);
}

/**
 * Fetch initialized ticks around the current tick using Multicall3 (single RPC call).
 */
async function fetchInitializedTicksMulticall3(
  ctx: DexAdapterContext,
  pool: DexV3PoolState,
  tickRange: number = 10,
): Promise<void> {
  const contract = ctx.blockchain.getContract(pool.id);
  if (!contract) throw new Error(`Pool contract not found for address: ${pool.address}`);

  const currentTick = Number(pool.tick!);
  const tickSpacing = Number(pool.tickSpacing!);
  pool.tickSpacing = tickSpacing;

  // Align to tick spacing
  const minTick = Math.floor((currentTick - tickRange * tickSpacing) / tickSpacing) * tickSpacing;
  const maxTick = Math.ceil((currentTick + tickRange * tickSpacing) / tickSpacing) * tickSpacing;

  logger.debug(
    `Fetching ticks for pool ${pool.id} (current tick: ${currentTick}) in range [${minTick}, ${maxTick}] with tick spacing ${tickSpacing} using Multicall3...`,
  );

  // Build tick list
  const tickValues: number[] = [];
  for (let t = minTick; t <= maxTick; t += tickSpacing) {
    tickValues.push(t);
  }

  const tickValuesStr = tickValues.map((t) => t.toString());
  logger.debug(`Total ticks to check: ${tickValues.length}`, tickValuesStr);

  if (tickValues.length === 0) return;

  // Encode each ticks(int24) call
  const poolInterface = new ethers.Interface(POOL_ABI);
  const calls = tickValues.map((t) => ({
    target: pool.id,
    allowFailure: true,
    callData: poolInterface.encodeFunctionData('ticks', [t]),
  }));

  // Batch into chunks to avoid gas limit on multicall (max ~500 per batch)
  const BATCH_SIZE = 500;
  const allResults: { success: boolean; returnData: string }[] = [];

  const multicall = ctx.blockchain.getMulticall3Contract();
  if (!multicall) throw new Error(`Multicall3 contract not found on blockchain ${ctx.blockchain.chainId}`);

  for (let i = 0; i < calls.length; i += BATCH_SIZE) {
    const batch = calls.slice(i, i + BATCH_SIZE);
    const results = await multicall.aggregate3.staticCall(batch);
    allResults.push(...results);
  }

  // Decode results
  const initializedTicks: { tick: number; liquidityNet: bigint }[] = [];

  for (let i = 0; i < allResults.length; i++) {
    const result = allResults[i];
    if (!result.success) continue;

    try {
      const decoded = poolInterface.decodeFunctionResult('ticks', result.returnData);
      const liquidityNet = BigInt(decoded.liquidityNet);
      if (liquidityNet !== 0n) {
        initializedTicks.push({ tick: tickValues[i], liquidityNet });
      }
    } catch {
      // Skip malformed responses
    }
  }

  pool.ticks = initializedTicks.sort((a, b) => a.tick - b.tick);
  logger.debug(`Fetched ${pool.ticks.length} initialized ticks for pool ${pool.id} (${tickValues.length} ticks in 1 RPC call)`);
}
