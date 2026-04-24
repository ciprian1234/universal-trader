import { ethers } from 'ethers';
import type { TokenOnChain, TokenPairOnChain } from '@/shared/data-model/token';

/**
 * Token Normalization for Liquidity Graph
 * - Normalizes native ETH (address(0)) to WETH for graph consistency
 * - Denormalizes back to native ETH when preparing on-chain transactions
 */

export function normalizeToGraphToken(poolToken: TokenOnChain, WETH_ADDR: string): TokenOnChain {
  // NOTE: address is the important part for graph identity ETH = WETH
  if (poolToken.address === ethers.ZeroAddress) return { ...poolToken, address: WETH_ADDR };
  return poolToken;
}

export function denormalizeTokenAddr(poolTokenPair: TokenPairOnChain, swapTokenAddr: string, WETH_ADDR: string): string {
  const { token0, token1 } = poolTokenPair;
  if (swapTokenAddr !== WETH_ADDR) return swapTokenAddr; // straightforward case: swap token is not WETH, return as is
  if (token0.address === ethers.ZeroAddress || token1.address === ethers.ZeroAddress) return ethers.ZeroAddress;
  return swapTokenAddr; // pool doesn't have native ETH, keep as WETH
}

/**
 * Determine swap direction: is tokenIn the pool's token0?
 * Handles the case where pool has native ETH (address(0)) but tokenIn is normalized to WETH.
 */
export function isZeroForOne(poolTokenPair: TokenPairOnChain, normalizedTokenInAddress: string): boolean {
  const { token0, token1 } = poolTokenPair;
  if (normalizedTokenInAddress === token0.address) return true;
  if (normalizedTokenInAddress === token1.address) return false;
  // tokenIn is normalized WETH but pool has native ETH as address(0)
  if (token0.address === ethers.ZeroAddress) return true;
  if (token1.address === ethers.ZeroAddress) return false;
  throw new Error(`Token ${normalizedTokenInAddress} not found in pool ${poolTokenPair.key}`); // this should never happen, just a sanity check
}

export function formatGwei(wei: bigint): string {
  return (Number(wei) / 1e9).toFixed(8) + ' gwei';
}

export function deltaMs(timestamp: number): string {
  const delta = Date.now() - timestamp;
  return `(+${delta}ms)`;
}
