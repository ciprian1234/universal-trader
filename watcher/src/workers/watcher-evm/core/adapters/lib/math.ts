/**
 * 🔧 Calculate price impact
 */
export function calculatePriceImpact(spotPrice: number, executionPrice: number): number {
  return Math.abs((executionPrice - spotPrice) / spotPrice) * 100;
}
