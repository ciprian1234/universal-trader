import { ethers } from 'ethers';
import type { DexPoolState } from '@/shared/data-model/layer1';

/**
 * Determine swap direction: is tokenIn the pool's token0?
 * Handles the case where pool has native ETH (address(0)) but tokenIn is normalized to WETH.
 */
export function isZeroForOne(normalizedTokenInAddress: string, pool: DexPoolState): boolean {
  const { token0, token1 } = pool.tokenPair;
  if (normalizedTokenInAddress === token0.address) return true;
  if (normalizedTokenInAddress === token1.address) return false;
  // tokenIn is normalized WETH but pool has native ETH as address(0)
  if (token0.address === ethers.ZeroAddress) return true;
  if (token1.address === ethers.ZeroAddress) return false;
  throw new Error(`Token ${normalizedTokenInAddress} not found in pool ${pool.id}`);
}

export function formatGwei(wei: bigint): string {
  return (Number(wei) / 1e9).toFixed(8) + ' gwei';
}

export function deltaMs(timestamp: number): string {
  const delta = Date.now() - timestamp;
  return `${delta}ms`;
}
