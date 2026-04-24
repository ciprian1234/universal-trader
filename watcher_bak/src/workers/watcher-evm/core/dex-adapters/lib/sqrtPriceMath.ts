// ================================================================================================
// UNISWAP V3 MATH LIBRARIES (Port from Solidity)
// ================================================================================================

import type { DexV3PoolState, DexV4PoolState } from '@/shared/data-model/layer1';

// Constants for fixed point math
export const Q96 = 1n << 96n; // 2**96
export const Q160 = 1n << 160n; // 2**160

// ================================================================================================
// V3 MATH HELPERS
// ================================================================================================
export function sqrtPriceX96ToPrice(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  // Convert to floating point early to avoid overflow
  const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
  const price = sqrtPrice * sqrtPrice;

  // return price * decimalAdjustment
  return price * Math.pow(10, decimals0 - decimals1);
}

// ================================================================================================
// V3 MATH HELPERS
// ================================================================================================

/**
 * Calculate virtual reserves from sqrtPrice and liquidity
 * Virtual reserves tells how much of each token would be available at the current price
 * Its just an approximation based on the current sqrtPriceX96 and liquidity
 */
export function calculateVirtualReserves(sqrtPriceX96: bigint, liquidity: bigint): { reserve0: bigint; reserve1: bigint } {
  if (liquidity === 0n || sqrtPriceX96 === 0n) return { reserve0: 0n, reserve1: 0n };

  // virtual reserves based on the current sqrtPrice and liquidity
  const reserve0 = (liquidity * Q96) / sqrtPriceX96;
  const reserve1 = (liquidity * sqrtPriceX96) / Q96;

  return { reserve0, reserve1 };
}

/**
 * Calculate next sqrtPrice when adding token0
 * From: SqrtPriceMath.getNextSqrtPriceFromAmount0RoundingUp
 */
export function getNextSqrtPriceFromAmount0RoundingUp(
  sqrtPriceX96: bigint,
  liquidity: bigint,
  amount: bigint,
  add: boolean,
): bigint {
  if (amount === 0n) return sqrtPriceX96;

  const numerator = liquidity * Q96;

  if (add) {
    // Adding token0 → price goes down
    const product = amount * sqrtPriceX96;

    if (product / amount === sqrtPriceX96) {
      // No overflow
      const denominator = numerator + product;
      if (denominator >= numerator) return mulDivRoundingUp(numerator, sqrtPriceX96, denominator);
    }

    // Fallback for overflow cases
    return numerator / (numerator / sqrtPriceX96 + amount);
  } else {
    // Removing token0 → price goes up
    const product = amount * sqrtPriceX96;
    const denominator = numerator - product;
    if (numerator <= product) throw new Error('Insufficient liquidity');
    return mulDivRoundingUp(numerator, sqrtPriceX96, denominator);
  }
}

/**
 * Calculate next sqrtPrice when adding token1
 * From: SqrtPriceMath.getNextSqrtPriceFromAmount1RoundingDown
 */
export function getNextSqrtPriceFromAmount1RoundingDown(
  sqrtPriceX96: bigint,
  liquidity: bigint,
  amount: bigint,
  add: boolean,
): bigint {
  if (add) {
    // Adding token1 → price goes up
    const quotient = amount <= Q160 ? (amount << 96n) / liquidity : (amount * Q96) / liquidity;
    return sqrtPriceX96 + quotient;
  } else {
    // Removing token1 → price goes down
    const quotient = amount <= Q160 ? mulDivRoundingUp(amount, Q96, liquidity) : (amount * Q96) / liquidity;
    if (sqrtPriceX96 <= quotient) throw new Error('Insufficient liquidity');
    return sqrtPriceX96 - quotient;
  }
}

/**
 * Calculate amount0 delta
 * From: SqrtPriceMath.getAmount0Delta
 */
export function getAmount0Delta(sqrtRatioAX96: bigint, sqrtRatioBX96: bigint, liquidity: bigint, roundUp: boolean): bigint {
  if (sqrtRatioAX96 > sqrtRatioBX96) [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];

  const numerator1 = liquidity << 96n;
  const numerator2 = sqrtRatioBX96 - sqrtRatioAX96;

  if (roundUp) return mulDivRoundingUp(mulDivRoundingUp(numerator1, numerator2, sqrtRatioBX96), 1n, sqrtRatioAX96);
  else return mulDiv(numerator1, numerator2, sqrtRatioBX96) / sqrtRatioAX96;
}

/**
 * Calculate amount1 delta
 * From: SqrtPriceMath.getAmount1Delta
 */
export function getAmount1Delta(sqrtRatioAX96: bigint, sqrtRatioBX96: bigint, liquidity: bigint, roundUp: boolean): bigint {
  if (sqrtRatioAX96 > sqrtRatioBX96) [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  const priceDelta = sqrtRatioBX96 - sqrtRatioAX96;

  if (roundUp) return mulDivRoundingUp(liquidity, priceDelta, Q96);
  else return mulDiv(liquidity, priceDelta, Q96);
}

// ================================================================================================
// MATH UTILITIES
// ================================================================================================

function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  return (a * b) / denominator;
}

function mulDivRoundingUp(a: bigint, b: bigint, denominator: bigint): bigint {
  const product = a * b;
  if (product % denominator === 0n) return product / denominator;
  else return product / denominator + 1n;
}

// ================================================================================================
// V3 SWAP SIMULATION
// ================================================================================================

/**
 * 🧮 SIMULATE V3 SWAP - Multi-tick implementation
 * Mirrors the Uniswap V3 core swap loop to handle tick crossings correctly.
 */
export function simulateSwap(poolState: DexV3PoolState | DexV4PoolState, amountIn: bigint, zeroForOne: boolean): bigint {
  const sqrtPriceX96 = poolState.sqrtPriceX96!;
  let liquidity = poolState.liquidity!;
  if (amountIn <= 0n) throw new Error(`Invalid trade amount: ${amountIn}`);

  // If no tick data available, fall back to single-tick simulation
  if (!poolState.ticks || poolState.ticks.length === 0) {
    if (liquidity <= 0n) throw new Error(`Insufficient liquidity`);
    return simulateSwapSingleTick(poolState, amountIn, zeroForOne);
  }

  const feePpm = BigInt(poolState.feeBps);
  let amountRemaining = amountIn;
  let totalAmountOut = 0n;
  let currentSqrtPrice = sqrtPriceX96;
  let currentTick = poolState.tick!;

  // Get sorted initialized ticks
  const ticks = poolState.ticks;

  // Price limits (same as V3 core MIN/MAX sqrt prices)
  const MIN_SQRT_RATIO = 4295128739n + 1n;
  const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n - 1n;
  const sqrtPriceLimit = zeroForOne ? MIN_SQRT_RATIO : MAX_SQRT_RATIO;

  let iterations = 0;
  const MAX_ITERATIONS = 500; // Safety limit

  while (amountRemaining > 0n && currentSqrtPrice !== sqrtPriceLimit && iterations < MAX_ITERATIONS) {
    iterations++;

    // Find the next initialized tick in the swap direction
    const nextTick = getNextInitializedTick(ticks, currentTick, zeroForOne);

    // Calculate sqrt price at the next tick boundary
    const sqrtPriceNextTick = nextTick !== null ? tickToSqrtPriceX96(nextTick.tick) : sqrtPriceLimit;

    // Clamp to price limit
    const sqrtPriceTarget = zeroForOne
      ? sqrtPriceNextTick < sqrtPriceLimit
        ? sqrtPriceLimit
        : sqrtPriceNextTick
      : sqrtPriceNextTick > sqrtPriceLimit
        ? sqrtPriceLimit
        : sqrtPriceNextTick;

    // Apply fee to remaining amount
    const amountRemainingAfterFee = (amountRemaining * (1_000_000n - feePpm)) / 1_000_000n;

    // Compute the swap step within this tick range
    const step = computeSwapStep(currentSqrtPrice, sqrtPriceTarget, liquidity, amountRemainingAfterFee, zeroForOne);

    // Deduct the consumed input (including fee on consumed portion)
    const amountInConsumed = step.amountIn;
    // Fee is proportional to amount consumed
    const feeAmount = (amountInConsumed * feePpm + (1_000_000n - feePpm - 1n)) / (1_000_000n - feePpm);
    amountRemaining -= amountInConsumed + feeAmount;
    if (amountRemaining < 0n) amountRemaining = 0n;

    totalAmountOut += step.amountOut;
    currentSqrtPrice = step.sqrtPriceNextX96;

    // If we reached the tick boundary, cross the tick
    if (nextTick !== null && step.sqrtPriceNextX96 === sqrtPriceTarget && sqrtPriceTarget === sqrtPriceNextTick) {
      // Cross the tick: apply liquidityNet
      if (zeroForOne) {
        liquidity -= nextTick.liquidityNet; // Going down in price
      } else {
        liquidity += nextTick.liquidityNet; // Going up in price
      }

      // Always advance currentTick past the crossed tick to avoid getting stuck
      currentTick = zeroForOne ? nextTick.tick - 1 : nextTick.tick;

      if (liquidity <= 0n) {
        // No more liquidity available (slide to next ticks)
        continue;
      }
    } else {
      // Didn't reach tick boundary, we're done
      break;
    }
  }

  if (totalAmountOut <= 0n) throw new Error('V3 multi-tick simulation produced zero output');
  return totalAmountOut;
}

/**
 * Single-tick fallback (original implementation)
 */
function simulateSwapSingleTick(poolState: DexV3PoolState | DexV4PoolState, amountIn: bigint, zeroForOne: boolean): bigint {
  const sqrtPriceX96 = poolState.sqrtPriceX96!;
  const liquidity = poolState.liquidity!;

  const feePpm = BigInt(poolState.feeBps);
  const amountInAfterFee = (amountIn * (1_000_000n - feePpm)) / 1_000_000n;

  if (zeroForOne) {
    const sqrtPriceX96Next = getNextSqrtPriceFromAmount0RoundingUp(sqrtPriceX96, liquidity, amountInAfterFee, true);
    return getAmount1Delta(sqrtPriceX96Next, sqrtPriceX96, liquidity, false);
  } else {
    const sqrtPriceX96Next = getNextSqrtPriceFromAmount1RoundingDown(sqrtPriceX96, liquidity, amountInAfterFee, true);
    return getAmount0Delta(sqrtPriceX96, sqrtPriceX96Next, liquidity, false);
  }
}

/**
 * Compute one step of the swap within a single tick range.
 */
function computeSwapStep(
  sqrtPriceCurrent: bigint,
  sqrtPriceTarget: bigint,
  liquidity: bigint,
  amountRemaining: bigint,
  zeroForOne: boolean,
): { sqrtPriceNextX96: bigint; amountIn: bigint; amountOut: bigint } {
  if (zeroForOne) {
    // token0 -> token1: price goes DOWN, sqrtPrice decreases
    // Max amount of token0 that can be added to reach sqrtPriceTarget
    const amountInMax = getAmount0Delta(sqrtPriceTarget, sqrtPriceCurrent, liquidity, true);

    if (amountRemaining >= amountInMax) {
      // We reach the target price (tick boundary)
      const amountOut = getAmount1Delta(sqrtPriceTarget, sqrtPriceCurrent, liquidity, false);
      return { sqrtPriceNextX96: sqrtPriceTarget, amountIn: amountInMax, amountOut };
    } else {
      // We don't reach the target; compute where we land
      const sqrtPriceNext = getNextSqrtPriceFromAmount0RoundingUp(sqrtPriceCurrent, liquidity, amountRemaining, true);
      const amountOut = getAmount1Delta(sqrtPriceNext, sqrtPriceCurrent, liquidity, false);
      return { sqrtPriceNextX96: sqrtPriceNext, amountIn: amountRemaining, amountOut };
    }
  } else {
    // token1 -> token0: price goes UP, sqrtPrice increases
    const amountInMax = getAmount1Delta(sqrtPriceCurrent, sqrtPriceTarget, liquidity, true);

    if (amountRemaining >= amountInMax) {
      const amountOut = getAmount0Delta(sqrtPriceCurrent, sqrtPriceTarget, liquidity, false);
      return { sqrtPriceNextX96: sqrtPriceTarget, amountIn: amountInMax, amountOut };
    } else {
      const sqrtPriceNext = getNextSqrtPriceFromAmount1RoundingDown(sqrtPriceCurrent, liquidity, amountRemaining, true);
      const amountOut = getAmount0Delta(sqrtPriceCurrent, sqrtPriceNext, liquidity, false);
      return { sqrtPriceNextX96: sqrtPriceNext, amountIn: amountRemaining, amountOut };
    }
  }
}

/**
 * Find the next initialized tick in the swap direction
 */
function getNextInitializedTick(
  ticks: { tick: number; liquidityNet: bigint }[],
  currentTick: number,
  zeroForOne: boolean,
): { tick: number; liquidityNet: bigint } | null {
  if (zeroForOne) {
    // Going DOWN: find the highest initialized tick <= currentTick
    for (let i = ticks.length - 1; i >= 0; i--) {
      if (ticks[i].tick <= currentTick) return ticks[i];
    }
  } else {
    // Going UP: find the lowest initialized tick > currentTick
    for (let i = 0; i < ticks.length; i++) {
      if (ticks[i].tick > currentTick) return ticks[i];
    }
  }
  return null;
}

/**
 * Convert tick to sqrtPriceX96
 * Exact port of Uniswap V3 TickMath.getSqrtRatioAtTick (pure integer math)
 */
function tickToSqrtPriceX96(tick: number): bigint {
  const absTick = Math.abs(tick);
  if (absTick > 887272) throw new Error(`Tick out of range: ${tick}`);

  let ratio: bigint = (absTick & 0x1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  if ((absTick & 0x2) !== 0) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if ((absTick & 0x4) !== 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if ((absTick & 0x8) !== 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if ((absTick & 0x10) !== 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if ((absTick & 0x20) !== 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if ((absTick & 0x40) !== 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if ((absTick & 0x80) !== 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if ((absTick & 0x100) !== 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if ((absTick & 0x200) !== 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if ((absTick & 0x400) !== 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if ((absTick & 0x800) !== 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if ((absTick & 0x1000) !== 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if ((absTick & 0x2000) !== 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if ((absTick & 0x4000) !== 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if ((absTick & 0x8000) !== 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if ((absTick & 0x10000) !== 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if ((absTick & 0x20000) !== 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if ((absTick & 0x40000) !== 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if ((absTick & 0x80000) !== 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;

  if (tick > 0) ratio = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn / ratio;

  // Round up and shift to Q96
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}
