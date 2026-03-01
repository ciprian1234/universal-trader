/**
 * 🦄 UNISWAP V4 ADAPTER: Support for V4 Singleton Architecture and Hooks
 */
import { ethers, AbiCoder } from 'ethers';
import type { TradeQuote, V4SwapEvent } from '../interfaces';
import * as SqrtMath from './lib/sqrtPriceMath';
import { dexPoolId, type DexV4PoolState } from '@/shared/data-model/layer1';
import { getCanonicalPairId, type TokenOnChain, type TokenPairOnChain } from '@/shared/data-model/token';
import { createLogger } from '@/utils/logger';
import type { DexAdapterContext } from './interfaces';

// ================================================================================================
// Types specific to Uniswap V4
// ================================================================================================
export type PoolKey = {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
};

// ================================================================================================
// UNISWAP V4 ADAPTER
// ================================================================================================

const logger = createLogger('DexV4Adapter');

// Standard fee tier / tick spacing combos often used as defaults
// Fee is uint24, TickSpacing is int24
const POOL_COMBINATIONS = [
  { fee: 100, tickSpacing: 2 }, // 0.01%
  { fee: 500, tickSpacing: 10 }, // 0.05%
  { fee: 3000, tickSpacing: 60 }, // 0.30%
  { fee: 10000, tickSpacing: 200 }, // 1.00%
];

// ABI definitions
export const POOL_MANAGER_ABI = [
  // extsload for advanced queries
  'function extsload(bytes32 slot) external view returns (bytes32)',

  // Events
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks)',
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
  'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta)',
];

export const QUOTER_ABI = [
  'function quoteExactInputSingle(tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks, bytes hookData) params, uint128 amountIn) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  'function quoteExactOutputSingle(tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks, bytes hookData) params, uint128 amountOut) external returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

// ✅ ABI for the StateView / Lens contract
export const STATE_VIEW_ABI = [
  'function getSlot0(address manager, bytes32 poolId) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(address manager, bytes32 poolId) external view returns (uint128 liquidity)',
];

export const STATE_VIEW_ABI_2 = [
  {
    inputs: [{ internalType: 'contract IPoolManager', name: '_poolManager', type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'constructor',
  },
  {
    inputs: [{ internalType: 'PoolId', name: 'poolId', type: 'bytes32' }],
    name: 'getFeeGrowthGlobals',
    outputs: [
      { internalType: 'uint256', name: 'feeGrowthGlobal0', type: 'uint256' },
      { internalType: 'uint256', name: 'feeGrowthGlobal1', type: 'uint256' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'PoolId', name: 'poolId', type: 'bytes32' },
      { internalType: 'int24', name: 'tickLower', type: 'int24' },
      { internalType: 'int24', name: 'tickUpper', type: 'int24' },
    ],
    name: 'getFeeGrowthInside',
    outputs: [
      { internalType: 'uint256', name: 'feeGrowthInside0X128', type: 'uint256' },
      { internalType: 'uint256', name: 'feeGrowthInside1X128', type: 'uint256' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'PoolId', name: 'poolId', type: 'bytes32' }],
    name: 'getLiquidity',
    outputs: [{ internalType: 'uint128', name: 'liquidity', type: 'uint128' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'PoolId', name: 'poolId', type: 'bytes32' },
      { internalType: 'bytes32', name: 'positionId', type: 'bytes32' },
    ],
    name: 'getPositionInfo',
    outputs: [
      { internalType: 'uint128', name: 'liquidity', type: 'uint128' },
      { internalType: 'uint256', name: 'feeGrowthInside0LastX128', type: 'uint256' },
      { internalType: 'uint256', name: 'feeGrowthInside1LastX128', type: 'uint256' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'PoolId', name: 'poolId', type: 'bytes32' },
      { internalType: 'address', name: 'owner', type: 'address' },
      { internalType: 'int24', name: 'tickLower', type: 'int24' },
      { internalType: 'int24', name: 'tickUpper', type: 'int24' },
      { internalType: 'bytes32', name: 'salt', type: 'bytes32' },
    ],
    name: 'getPositionInfo',
    outputs: [
      { internalType: 'uint128', name: 'liquidity', type: 'uint128' },
      { internalType: 'uint256', name: 'feeGrowthInside0LastX128', type: 'uint256' },
      { internalType: 'uint256', name: 'feeGrowthInside1LastX128', type: 'uint256' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'PoolId', name: 'poolId', type: 'bytes32' },
      { internalType: 'bytes32', name: 'positionId', type: 'bytes32' },
    ],
    name: 'getPositionLiquidity',
    outputs: [{ internalType: 'uint128', name: 'liquidity', type: 'uint128' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'PoolId', name: 'poolId', type: 'bytes32' }],
    name: 'getSlot0',
    outputs: [
      { internalType: 'uint160', name: 'sqrtPriceX96', type: 'uint160' },
      { internalType: 'int24', name: 'tick', type: 'int24' },
      { internalType: 'uint24', name: 'protocolFee', type: 'uint24' },
      { internalType: 'uint24', name: 'lpFee', type: 'uint24' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'PoolId', name: 'poolId', type: 'bytes32' },
      { internalType: 'int16', name: 'tick', type: 'int16' },
    ],
    name: 'getTickBitmap',
    outputs: [{ internalType: 'uint256', name: 'tickBitmap', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'PoolId', name: 'poolId', type: 'bytes32' },
      { internalType: 'int24', name: 'tick', type: 'int24' },
    ],
    name: 'getTickFeeGrowthOutside',
    outputs: [
      { internalType: 'uint256', name: 'feeGrowthOutside0X128', type: 'uint256' },
      { internalType: 'uint256', name: 'feeGrowthOutside1X128', type: 'uint256' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'PoolId', name: 'poolId', type: 'bytes32' },
      { internalType: 'int24', name: 'tick', type: 'int24' },
    ],
    name: 'getTickInfo',
    outputs: [
      { internalType: 'uint128', name: 'liquidityGross', type: 'uint128' },
      { internalType: 'int128', name: 'liquidityNet', type: 'int128' },
      { internalType: 'uint256', name: 'feeGrowthOutside0X128', type: 'uint256' },
      { internalType: 'uint256', name: 'feeGrowthOutside1X128', type: 'uint256' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'PoolId', name: 'poolId', type: 'bytes32' },
      { internalType: 'int24', name: 'tick', type: 'int24' },
    ],
    name: 'getTickLiquidity',
    outputs: [
      { internalType: 'uint128', name: 'liquidityGross', type: 'uint128' },
      { internalType: 'int128', name: 'liquidityNet', type: 'int128' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'poolManager',
    outputs: [{ internalType: 'contract IPoolManager', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
];

function isWETH(address: string): boolean {
  const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'; // Ethereum mainnet
  return address.toLowerCase() === WETH_ADDRESS.toLowerCase();
}

// ================================================================================================
// POOL DISCOVERY AND STATE MANAGEMENT
// ================================================================================================

/**
 * 🔍 FIND POOLS: Find initialized V4 pools for a token pair
 * Note: V4 pools are defined by a PoolKey (Tokens + Fee + TickSpacing + Hooks).
 * This logic assumes standard no-hook pools.
 */
export async function discoverPools(ctx: DexAdapterContext, tokenPair: TokenPairOnChain): Promise<DexV4PoolState[]> {
  if (ctx.config.protocol !== 'v4') throw new Error('Invalid protocol for V4 pool initialization');
  const stateViewContract = ctx.blockchain.getContract(ctx.config.stateViewAddress);
  if (!stateViewContract) throw new Error(`StateView contract not found at address: ${ctx.config.stateViewAddress}`);
  const symbol0 = tokenPair.token0.address;
  const symbol1 = tokenPair.token1.address;
  const pools: DexV4PoolState[] = [];

  // // Convert WETH to address(0) if needed
  // const currency0 = this.isWETH(token0) ? ethers.ZeroAddress : token0;
  // const currency1 = this.isWETH(token1) ? ethers.ZeroAddress : token1;

  // Check standard combinations
  for (const combo of POOL_COMBINATIONS) {
    try {
      // 1. Generate Pool Key
      const poolKey = {
        currency0: tokenPair.token0.address,
        currency1: tokenPair.token1.address,
        fee: combo.fee,
        tickSpacing: combo.tickSpacing,
        hooks: ethers.ZeroAddress, // Assuming standard pools without hooks (TBD: review)
      };

      // 2. Calculate Pool ID (Hash of Key)
      const poolIdHash = getPoolId(poolKey); // previous version for testing

      // 3. Check if initialized via Slot0 => If sqrtPriceX96 is 0, pool is not initialized
      // console.log(
      //   `Checking V4 pool for ${symbol0}/${symbol1} (Fee: ${combo.fee}, TickSpacing: ${combo.tickSpacing}) at ID: ${poolIdHash}`,
      // );
      // Use raw storage reader
      const slot0 = await stateViewContract.getSlot0(poolIdHash);
      if (!slot0.sqrtPriceX96 || slot0.sqrtPriceX96 === 0n) {
        logger.warn(`No V4 pool found for ${symbol0}/${symbol1} (Fee: ${combo.fee})`);
        continue; // Pool not initialized
      }

      // Found a pool!
      const poolState = await initPool(ctx, poolIdHash, poolKey, tokenPair);
      pools.push(poolState);
    } catch (error) {
      // Pool check failed
      logger.debug(`Trace check failed for V4 pool ${symbol0}/${symbol1} (Fee: ${combo.fee}): ${(error as Error).message}\n\n`);
    }
  }

  return pools;
}

/**
 * 🏗 INIT POOL: Initialize V4 pool state
 * Note: In V4, we don't have a specific pool contract, we interact with PoolManager
 */
// @ts-ignore - Signature mismatch with base due to extra poolKey params needed for initialization logic
async function initPool(ctx: DexAdapterContext, id, poolKeyData: any, tokenPair: TokenPairOnChain): Promise<DexV4PoolState> {
  if (ctx.config.protocol !== 'v4') throw new Error('Invalid protocol for V4 pool initialization');
  // Use provided key or basic recovery (Tokens must be known contextually or passed in)
  if (!poolKeyData) {
    throw new Error('PoolKey data required to initialize V4 Pool State structure');
  }

  const poolState: DexV4PoolState = {
    id: dexPoolId(ctx.blockchain.chainId, id), // TODO: ensure its correct
    poolKey: id, // TODO: ensure its correct
    address: ctx.config.poolManagerAddress, // V4 uses PoolManager for all pools
    venue: { name: ctx.config.name, type: 'dex', chainId: ctx.blockchain.chainId },
    protocol: 'v4',
    pairId: getCanonicalPairId(tokenPair.token0, tokenPair.token1),
    tokenPair,

    tickSpacing: poolKeyData.tickSpacing,
    // hooks: poolKeyData.hooks,

    feeBps: poolKeyData.fee,

    sqrtPriceX96: 0n,
    tick: 0,
    liquidity: 0n,
    reserve0: 0n,
    reserve1: 0n,
    spotPrice0to1: 0,
    spotPrice1to0: 0,
    // totalLiquidityInUSD: 0,
  };

  return poolState;
}

/**
 * Update pool state via Singleton PoolManager
 */
export async function updatePool(ctx: DexAdapterContext, pool: DexV4PoolState): Promise<DexV4PoolState> {
  if (ctx.config.protocol !== 'v4') throw new Error('Invalid protocol for V4 pool update');
  const { token0, token1 } = pool.tokenPair;
  const poolKey = pool.id;

  // Call PoolManager for this specific ID
  const stateViewContract = ctx.blockchain.getContract(ctx.config.stateViewAddress);
  if (!stateViewContract) throw new Error(`StateView contract not found at address: ${ctx.config.stateViewAddress}`);
  const [slot0, liquidity] = await Promise.all([stateViewContract.getSlot0(poolKey), stateViewContract.getLiquidity(poolKey)]);
  if (!slot0) throw new Error(`Failed to fetch slot0 for pool ID ${poolKey}`);

  const { reserve0, reserve1 } = SqrtMath.calculateVirtualReserves(slot0.sqrtPriceX96, liquidity);

  pool.reserve0 = reserve0;
  pool.reserve1 = reserve1;
  pool.sqrtPriceX96 = slot0.sqrtPriceX96;
  pool.tick = Number(slot0.tick); // Convert BigInt to number for tick
  pool.liquidity = liquidity;

  pool.spotPrice0to1 = calculateSpotPrice(slot0.sqrtPriceX96, token0, token1, true);
  pool.spotPrice1to0 = calculateSpotPrice(slot0.sqrtPriceX96, token0, token1, false);

  return pool;
}

/**
 * ✅ FIXED: Sort tokens correctly
 */
function sortTokens(tokenA: string, tokenB: string): [string, string] {
  const addrA = tokenA.toLowerCase();
  const addrB = tokenB.toLowerCase();
  return addrA < addrB ? [addrA, addrB] : [addrB, addrA];
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
 * 💰 GET TRADE QUOTE: Calculate V4 trade quote
 */
export async function getTradeQuote(
  ctx: DexAdapterContext,
  pool: DexV4PoolState,
  amountIn: bigint,
  zeroForOne: boolean,
): Promise<TradeQuote> {
  if (ctx.config.protocol !== 'v4') throw new Error('Invalid protocol for V4 trade quote');
  const quoterContract = ctx.blockchain.getContract(ctx.config.quoterAddress);
  if (!quoterContract) throw new Error(`Quoter contract not found at address: ${ctx.config.quoterAddress}`);
  const { token0, token1 } = pool.tokenPair;

  // Ensure Key logic matches discovery
  const [currency0, currency1] =
    token0.address.toLowerCase() < token1.address.toLowerCase()
      ? [token0.address, token1.address]
      : [token1.address, token0.address];

  // Reconstruct Key Parameter
  const params = {
    currency0: currency0,
    currency1: currency1,
    fee: pool.feeBps,
    tickSpacing: pool.tickSpacing || 60,
    hooks: pool.hooks || ethers.ZeroAddress,
    hookData: '0x', // Empty bytes
  };

  try {
    // V4 Quoter returns a tuple
    // quoteExactInputSingle(params, amountIn) returns (amountOut, ...)
    const result = await quoterContract.quoteExactInputSingle.staticCall(params, amountIn);

    const amountOut = result[0]; // first return value

    // Calculate execution metrics
    const spotPrice = pool.spotPrice0to1!; // Base assumption
    const normalizedIn = parseFloat(ethers.formatUnits(amountIn, zeroForOne ? token0.decimals : token1.decimals));
    const normalizedOut = parseFloat(ethers.formatUnits(amountOut, zeroForOne ? token1.decimals : token0.decimals));

    const executionPrice = normalizedOut / normalizedIn;

    return {
      poolState: pool,
      amountIn,
      amountOut,
      executionPrice,
      priceImpact: 0, // Simplified
      slippage: 0,
      confidence: 0.9,
    };
  } catch (e: any) {
    throw new Error(`V4 Quote failed: ${e.message}`);
  }
}

/**
 * 🧮 SIMULATE SWAP (Reusing V3 Math)
 * V4 calculation logic for standard pools is identical to V3's concentrated liquidity math.
 * However, hooks can alter this behavior. This assumes NO hooks affecting swap logic.
 */
export function simulateSwap(pool: DexV4PoolState, amountIn: bigint, zeroForOne: boolean): bigint {
  const sqrtPriceX96 = pool.sqrtPriceX96!;
  const liquidity = pool.liquidity!;

  // TBD: check how hooks affect swap calculations
  const hooks = pool.hooks || ethers.ZeroAddress;
  if (hooks !== ethers.ZeroAddress) {
    logger.warn('⚠️ Pool uses hooks - simulation accuracy not guaranteed');
  }

  if (amountIn <= 0n) throw new Error(`Invalid trade amount: ${amountIn}`);
  if (liquidity <= 0n) throw new Error(`Insufficient liquidity`);

  // Fee calculations in V4 can be dynamic via hooks, but we assume static fee here
  const feePpm = BigInt(pool.feeBps);
  const amountInAfterFee = (amountIn * (1_000_000n - feePpm)) / 1_000_000n;

  if (zeroForOne) {
    const sqrtPriceX96Next = SqrtMath.getNextSqrtPriceFromAmount0RoundingUp(sqrtPriceX96, liquidity, amountInAfterFee, true);
    return SqrtMath.getAmount1Delta(sqrtPriceX96Next, sqrtPriceX96, liquidity, false);
  } else {
    const sqrtPriceX96Next = SqrtMath.getNextSqrtPriceFromAmount1RoundingDown(sqrtPriceX96, liquidity, amountInAfterFee, true);
    return SqrtMath.getAmount0Delta(sqrtPriceX96, sqrtPriceX96Next, liquidity, false);
  }
}

/**
 * 💰 GET FEE PERCENT: Get V4 pool fee percentage
 */
export function getFeePercent(pool: DexV4PoolState): number {
  return Number(pool.feeBps) / 10000; // Convert from basis points to percentage (3000 bps = 0.3%)
}

// ================================================================================================
// EVENT HANDLING
// ================================================================================================

/**
 * 🔄 UPDATE POOL STATE FROM EVENT: Fast V4 state updates
 */
export function updatePoolFromEvent(pool: DexV4PoolState, event: V4SwapEvent): DexV4PoolState {
  if (!event.sqrtPriceX96 || !event.liquidity) throw new Error(`❌ Invalid PoolEvent for: ${pool.id}`);
  pool.latestEventMeta = { ...event.meta };

  // virtual reserves are directly from event
  // V4 specific data from Swap event
  const { reserve0, reserve1 } = SqrtMath.calculateVirtualReserves(event.sqrtPriceX96, event.liquidity); // virtual reserve0 and reserve1

  // Update V4 specific state if available
  pool.reserve0 = reserve0;
  pool.reserve1 = reserve1;
  pool.sqrtPriceX96 = event.sqrtPriceX96!;
  pool.tick = event.tick!;
  pool.liquidity = event.liquidity!;

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
    // this.logger.warn(`❌ Failed to calculate USD liquidity for pool ${event.poolId}: ${(error as Error).message}`);
    // pool.totalLiquidityInUSD = 0;
  }

  return pool;
}

// Example: Read pool's active tick
export async function getTickBitmap(ctx: DexAdapterContext, poolId: string, wordPos: number): Promise<bigint> {
  if (ctx.config.protocol !== 'v4') throw new Error('Invalid protocol for V4 tick bitmap');
  const poolManagerContract = ctx.blockchain.getContract(ctx.config.poolManagerAddress);
  if (!poolManagerContract) throw new Error(`PoolManager contract not found at address: ${ctx.config.poolManagerAddress}`);
  // Calculate storage slot for tick bitmap
  const slot = ethers.solidityPackedKeccak256(['bytes32', 'uint256'], [poolId, wordPos]);

  const value = await poolManagerContract.extsload(slot);
  return BigInt(value);
}

// ================================================================================================
// V4 SPECIFIC HELPERS
// ================================================================================================

/**
 * Calculate V4 Pool ID from Key
 * Note: V4 Pool ID is keccak256 hash of the ABI-encoded PoolKey struct
 */
function getPoolId(key: PoolKey): string {
  const abiCoder = AbiCoder.defaultAbiCoder();
  return ethers.keccak256(
    abiCoder.encode(
      ['address', 'address', 'uint24', 'int24', 'address'],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

/**
 * 🕷️ READ POOL STATE: Use extsload to read raw storage
 * Assumes _pools mapping is at Slot 0 and standard Struct layout
 */
export async function getPoolStateFromStorage(
  ctx: DexAdapterContext,
  poolId: string,
): Promise<{ sqrtPriceX96: bigint; tick: number; liquidity: bigint }> {
  if (ctx.config.protocol !== 'v4') throw new Error('Invalid protocol for V4 tick bitmap');
  const poolManagerContract = ctx.blockchain.getContract(ctx.config.poolManagerAddress);
  if (!poolManagerContract) throw new Error(`PoolManager contract not found at address: ${ctx.config.poolManagerAddress}`);
  // 1. Calculate the base storage slot for this pool's struct in the mapping
  // mapping slot for key k is keccak256(abi.encode(k, padding_slot))
  // Assuming _pools is at slot 0
  const MAPPING_SLOT = 0;
  const abiCoder = AbiCoder.defaultAbiCoder();

  const baseSlotHash = ethers.keccak256(abiCoder.encode(['bytes32', 'uint256'], [poolId, MAPPING_SLOT]));
  const baseSlot = BigInt(baseSlotHash);

  // 2. Read Slot 0 (State.slot0)
  // Layout:
  // - sqrtPriceX96: bits 0-159 (160 bits)
  // - tick:         bits 160-183 (24 bits)
  // - protocolFee:  bits 184-207 (24 bits)
  // - lpFee:        bits 208-231 (24 bits)
  const slot0Bytes = await poolManagerContract.extsload(baseSlotHash);
  const slot0Val = BigInt(slot0Bytes);
  console.log(`Slot0 Raw Value: ${slot0Bytes.toString('hex')}`);

  const sqrtPriceX96 = slot0Val & ((1n << 160n) - 1n);

  // Extract Tick (24 bits signed)
  let tickVal = (slot0Val >> 160n) & 0xffffffn;
  // Handle int24 sign extension
  if (tickVal & 0x800000n) {
    tickVal = tickVal - 0x1000000n;
  }
  const tick = Number(tickVal);

  // 3. Read Slot 3 (State.liquidity)
  // Offset 0: slot0
  // Offset 1: feeGrowth0
  // Offset 2: feeGrowth1
  // Offset 3: liquidity
  const liquiditySlot = baseSlot + 3n;
  // Format as hex bytes32 for extsload
  const liquiditySlotHex = '0x' + liquiditySlot.toString(16).padStart(64, '0');

  const liquidityBytes = await poolManagerContract.extsload(liquiditySlotHex);
  const liquidityVal = BigInt(liquidityBytes);
  const liquidity = liquidityVal & ((1n << 128n) - 1n); // Mask 128 bits just in case

  return {
    sqrtPriceX96,
    tick,
    liquidity,
  };
}
