/**
 * 🦄 UNISWAP V2 ADAPTER: High-performance V2 DEX adapter with optimized calculations
 */
import { ethers } from 'ethers';
import type { TradeQuote, V2SyncEvent } from '../interfaces';
import { dexPoolId, type DexV2PoolState, type DexVenue } from '@/shared/data-model/layer1';
import { getCanonicalPairId, type TokenOnChain, type TokenPairOnChain } from '@/shared/data-model/token';
import { calculatePriceImpact } from './lib/math';
import type { DexAdapterContext, PoolIntrospectContext } from './interfaces';
import { createLogger } from '@/utils/logger';
import type { Blockchain } from '../blockchain';

// ================================================================================================
// DEX V2 ADAPTERS
// ================================================================================================

const logger = createLogger('DexV2Adapter');

const FEE_BASIS_POINTS = 30; // 0.3% fee (30 bps) (denominated by 10,000)

export const FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) external view returns (address pair)',
  'function allPairs(uint) external view returns (address pair)',
  'function allPairsLength() external view returns (uint)',
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint)',
];

export const POOL_ABI = [
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function totalSupply() external view returns (uint)',
  'function kLast() external view returns (uint)',
  'event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)',
  'event Sync(uint112 reserve0, uint112 reserve1)',
];

export const ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
  'function getAmountsIn(uint amountOut, address[] calldata path) external view returns (uint[] memory amounts)',
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
];

/**
 * 🔍 FIND POOLS: Find all V2 pools for a token pair
 */
export async function discoverPools(ctx: DexAdapterContext, tokenPair: TokenPairOnChain): Promise<DexV2PoolState[]> {
  if (ctx.config.protocol !== 'v2') throw new Error(`Invalid config protocol for V2 adapter: ${ctx.config.protocol}`);

  const factoryContract = ctx.blockchain.getContract(ctx.config.factoryAddress);
  if (!factoryContract) throw new Error(`FactoryV2 contract not found at address: ${ctx.config.factoryAddress}`);
  const poolAddress = await factoryContract.getPair(tokenPair.token0.address, tokenPair.token1.address);
  if (poolAddress === ethers.ZeroAddress) return []; // no pool exists for this pair

  const venue = { name: ctx.config.name, type: 'dex' as const, chainId: ctx.blockchain.chainId };
  const poolState = await initPool(ctx.blockchain, { poolAddress, tokenPair, venue });
  return [poolState];
}

// =====================================================================================================================
// Introspect pool from event
// =====================================================================================================================
export async function introspectPoolFromEvent(ctx: PoolIntrospectContext, event: V2SyncEvent): Promise<DexV2PoolState> {
  const poolAddress = event.sourceAddress;
  let poolContract = ctx.blockchain.getContract(poolAddress);
  if (!poolContract) poolContract = ctx.blockchain.initContract(poolAddress, POOL_ABI);

  const [token0Address, token1Address] = await Promise.all([poolContract.token0(), poolContract.token1()]);
  const token0 = await ctx.tokenManager.ensureTokenRegistered(token0Address, 'address');
  const token1 = await ctx.tokenManager.ensureTokenRegistered(token1Address, 'address');

  if (!token0.trusted) logger.warn(`⚠️ Pool:${poolAddress} Token0 ${token0.symbol} (${token0.address}) is not trusted!`);
  if (!token1.trusted) logger.warn(`⚠️ Pool:${poolAddress} Token1 ${token1.symbol} (${token1.address}) is not trusted!`);
  const tokenPair = { token0, token1, key: `${token0.symbol}-${token1.symbol}` };

  const venue = { name: 'unknown' as const, type: 'dex' as const, chainId: ctx.blockchain.chainId };

  // TODO: - attempt to find the venue

  const poolState = await initPool(ctx.blockchain, { poolAddress, tokenPair, venue });
  return poolState;
}

/**
 * 🏗 INIT POOL: Initialize V2 pool state: called either from pool discovery or from introspection
 * If pool initialized from event => we have the dynamic fields
 */
async function initPool(
  blockchain: Blockchain,
  input: { poolAddress: string; tokenPair: TokenPairOnChain; venue: DexVenue; event?: V2SyncEvent },
): Promise<DexV2PoolState> {
  // init pool contract
  const contract = blockchain.initContract(input.poolAddress, POOL_ABI);
  // Fetch pool static data (not needed since we already have tokenPair)
  // const [token0Address, token1Address] = await Promise.all([contract.token0(), contract.token1()]);
  // if (!token0Address || !token1Address) throw new Error(`Failed to fetch token addresses for pool ${poolAddress}`);

  const newPool: DexV2PoolState = {
    id: dexPoolId(blockchain.chainId, input.poolAddress),
    address: input.poolAddress,
    venue: input.venue,
    protocol: 'v2',
    pairId: getCanonicalPairId(input.tokenPair.token0, input.tokenPair.token1),
    tokenPair: input.tokenPair,
    feeBps: FEE_BASIS_POINTS, // Convert to basis points (0.3% = 30 bps (denominated by 10,000))

    // init dynamic fields to zero (updated later)
    reserve0: 0n,
    reserve1: 0n,
    spotPrice0to1: 0,
    spotPrice1to0: 0,
    // totalLiquidityInUSD: 0,
  };

  if (input.event) updatePoolFromEvent(newPool, input.event);
  return newPool;
}

/**
 * 📊 GET POOL STATE: Fetch current pool state
 */
export async function updatePool(ctx: DexAdapterContext, pool: DexV2PoolState): Promise<DexV2PoolState> {
  const contract = ctx.blockchain.getContract(pool.address);
  if (!contract) throw new Error(`Pool contract not found: ${pool.address}`);

  // Fetch reserves
  const reserves = await contract.getReserves();
  if (!reserves) throw new Error(`Failed to fetch reserves for pool: ${pool.address}`);

  // derived fields
  const { token0, token1 } = pool.tokenPair;

  pool.reserve0 = reserves.reserve0;
  pool.reserve1 = reserves.reserve1;
  pool.spotPrice0to1 = calculateSpotPrice(reserves.reserve0, reserves.reserve1, token0, token1, true);
  pool.spotPrice1to0 = calculateSpotPrice(reserves.reserve0, reserves.reserve1, token0, token1, false);
  return pool;
}

/**
 * 💰 GET SPOT PRICE: Get current spot price for a pool
 * Returns price as a floating-point number, normalized for token decimals.
 * If zeroForOne is true, returns price of token0 in token1 (token1/token0).
 * If false, returns price of token1 in token0 (token0/token1).
 */
function calculateSpotPrice(
  reserve0: bigint,
  reserve1: bigint,
  token0: TokenOnChain,
  token1: TokenOnChain,
  zeroForOne: boolean,
): number {
  if (zeroForOne) {
    const norm0 = parseFloat(ethers.formatUnits(reserve0, token0.decimals));
    const norm1 = parseFloat(ethers.formatUnits(reserve1, token1.decimals));
    return norm1 / norm0;
  } else {
    const norm0 = parseFloat(ethers.formatUnits(reserve0, token0.decimals));
    const norm1 = parseFloat(ethers.formatUnits(reserve1, token1.decimals));
    return norm0 / norm1;
  }
}

/**
 * 💰 GET TRADE QUOTE: Calculate V2 trade quote with perfect math
 */
export async function getTradeQuote(poolState: DexV2PoolState, amountIn: bigint, zeroForOne: boolean): Promise<TradeQuote> {
  if (amountIn <= 0n) throw new Error(`Invalid trade amount: ${amountIn} (must be > 0)`);
  const { token0, token1 } = poolState.tokenPair;

  // Set reserves based on direction
  const reserveIn = zeroForOne ? poolState.reserve0! : poolState.reserve1!;
  const reserveOut = zeroForOne ? poolState.reserve1! : poolState.reserve0!;

  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error(`Insufficient liquidity in pool: ${poolState.id}`);
  if (amountIn > reserveIn) throw new Error(`Trade amount exceeds available liquidity in pool: ${poolState.id}`);

  // Convert fee to basis points for precision
  const feeRateBasisPoints = BigInt(poolState.feeBps); // 30n
  const keepRateBasisPoints = 10000n - feeRateBasisPoints; // 9970n

  // V2 constant product formula with fee
  const amountInWithFee = (amountIn * keepRateBasisPoints) / 10000n;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn + amountInWithFee;
  const amountOut = numerator / denominator;

  if (amountOut <= 0n) throw new Error(`Trade quote invalid amountOut: ${amountOut}`);

  // Use correct spot price for direction
  const spotPrice = zeroForOne ? poolState.spotPrice0to1 : poolState.spotPrice1to0;

  // Calculate execution price
  const normalizedAmountIn = parseFloat(ethers.formatUnits(amountIn, zeroForOne ? token0.decimals : token1.decimals));
  const normalizedAmountOut = parseFloat(ethers.formatUnits(amountOut, zeroForOne ? token1.decimals : token0.decimals));
  const executionPrice = normalizedAmountOut / normalizedAmountIn;
  const priceImpact = calculatePriceImpact(spotPrice, executionPrice);

  // Calculate slippage (for V2, slippage equals price impact)
  const slippage = priceImpact;

  return {
    poolState,
    amountIn,
    amountOut,
    executionPrice,
    priceImpact,
    slippage,
    confidence: 0.99, // V2 quotes are very reliable
  };
}

/**
 * 💰 GET TRADE QUOTE: Calculate V2 trade quote with perfect math
 */
export function simulateSwap(poolState: DexV2PoolState, amountIn: bigint, zeroForOne: boolean): bigint {
  if (amountIn <= 0n) throw new Error(`Invalid trade amount: ${amountIn} (must be > 0)`);

  // Set reserves based on direction
  const reserveIn = zeroForOne ? poolState.reserve0! : poolState.reserve1!;
  const reserveOut = zeroForOne ? poolState.reserve1! : poolState.reserve0!;

  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error(`Insufficient liquidity in pool: ${poolState.id}`);
  if (amountIn > reserveIn)
    throw new Error(
      `Trade amount exceeds available liquidity in pool: ${poolState.id} - reserveIn: ${reserveIn} amountIn: ${amountIn}`,
    );

  // Convert fee to basis points for precision
  const feeRateBasisPoints = BigInt(poolState.feeBps); // 30n
  const keepRateBasisPoints = 10000n - feeRateBasisPoints; // 9970n

  // V2 constant product formula with fee
  const amountInWithFee = (amountIn * keepRateBasisPoints) / 10000n;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn + amountInWithFee;
  const amountOut = numerator / denominator;
  return amountOut;
}

/**
 * 💰 GET FEE PERCENT: Get V2 pool fee percentage
 */
export function getFeePercent(poolState: DexV2PoolState): number {
  return poolState.feeBps / 100; // Convert from basis points to percentage (30 bps = 0.3%)
}

// ================================================================================================
// EVENT HANDLING
// ================================================================================================

/**
 * 🔄 UPDATE POOL STATE FROM EVENT: Fast V2 state updates
 * Only allow sync events!!!
 */
export function updatePoolFromEvent(pool: DexV2PoolState, event: V2SyncEvent): DexV2PoolState {
  pool.reserve0 = event.reserve0;
  pool.reserve1 = event.reserve1;
  pool.latestEventMeta = event.meta;

  // Update derived fields
  const { token0, token1 } = pool.tokenPair;
  pool.spotPrice0to1 = calculateSpotPrice(event.reserve0!, event.reserve1!, token0, token1, true);
  pool.spotPrice1to0 = calculateSpotPrice(event.reserve0!, event.reserve1!, token0, token1, false);

  // calculate liquidityUSD (requires external price feed)
  try {
    // TODO: update this when implemented price oracle
    // const v0 = this.tokenManager.calculateUSDValue(pool.tokenPair.token0.address, pool.reserve0!) || 0;
    // const v1 = this.tokenManager.calculateUSDValue(pool.tokenPair.token1.address, pool.reserve1!) || 0;
    // pool.totalLiquidityInUSD = v0 + v1;
  } catch (error) {
    // this.logger.warn(`❌ Failed to calculate USD liquidity for pool ${event.poolId}: ${(error as Error).message}`);
    // pool.totalLiquidityInUSD = 0;
  }

  return pool;
}
