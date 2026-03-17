/**
 * 🔧 Calculate fee multiplier for profit estimation
 */
export function getFeeMultiplier(fee: number, dexProtocol: string): number {
  const denominator = dexProtocol === 'v2' ? 10_000 : 1_000_000; // Determine denominator
  return 1 - fee / denominator;
}
