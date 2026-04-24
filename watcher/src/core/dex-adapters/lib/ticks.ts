import type { DexV3PoolState, DexV4PoolState } from '@/shared/data-model/layer1';
import { calculateVirtualReserves } from './sqrtPriceMath';

/**
 * Apply a liquidity change to a concentrated-liquidity pool.
 * Updates pool.liquidity (if current tick is in range) and pool.ticks array.
 */
export function applyLiquidityDelta(
  pool: DexV3PoolState | DexV4PoolState,
  tickLower: number,
  tickUpper: number,
  liquidityDelta: bigint,
): void {
  // 1. Update global active liquidity if current tick is within the affected range
  if (pool.tick >= tickLower && pool.tick < tickUpper) {
    pool.liquidity = pool.liquidity + liquidityDelta;

    // Recalculate virtual reserves since active liquidity changed
    const { reserve0, reserve1 } = calculateVirtualReserves(pool.sqrtPriceX96, pool.liquidity);
    pool.reserve0 = reserve0;
    pool.reserve1 = reserve1;

    // Spot prices don't change — sqrtPriceX96 is unchanged
  }

  // 2. Update tick array (if ticks are populated)
  if (!pool.ticks) return;

  updateTickEntry(pool.ticks, tickLower, liquidityDelta); // entering range: +delta
  updateTickEntry(pool.ticks, tickUpper, -liquidityDelta); // leaving range: -delta
}

/**
 * Update or insert a single tick entry in the sorted ticks array.
 * If the resulting liquidityNet is 0, the tick is removed (un-initialized).
 */
function updateTickEntry(ticks: { tick: number; liquidityNet: bigint }[], tick: number, delta: bigint): void {
  const idx = ticks.findIndex((t) => t.tick >= tick);

  if (idx !== -1 && ticks[idx].tick === tick) {
    // Tick exists — update it
    ticks[idx].liquidityNet += delta;
    // If liquidityNet becomes 0, remove the tick (no longer initialized)
    if (ticks[idx].liquidityNet === 0n) ticks.splice(idx, 1);
  } else if (delta !== 0n) {
    // Tick doesn't exist — insert in sorted position
    const entry = { tick, liquidityNet: delta };
    if (idx === -1)
      ticks.push(entry); // append at end
    else ticks.splice(idx, 0, entry); // insert before idx
  }
}
