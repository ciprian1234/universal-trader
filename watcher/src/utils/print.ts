import type { DexPoolState } from '@/shared/data-model/layer1';
import type { ArbitrageOpportunity, PoolEvent } from '@/workers/watcher-evm/core/interfaces';
import type { Logger } from '@/utils';
import { formatUnits } from 'node_modules/ethers/lib.commonjs/utils/units';

export function printPool(pool: DexPoolState): string {
  return `📊 ${pool.venue.name} ${pool.tokenPair.key}(${pool.feeBps}) (id: '${pool.id}')`;
}

export function printPoolInEvent(pool: DexPoolState, event: PoolEvent): string {
  const details = `📊 ${pool.venue.name} ${pool.tokenPair.key}(${pool.feeBps}) update event`;
  const deltaMs = Date.now() - event.meta.blockReceivedTimestamp;
  return `${details.padEnd(60)} 🔗 ${event.meta.blockNumber} (+${deltaMs}ms) (id: '${pool.id}')`;
}

// ============================================
// DISPLAY & STATS
// ============================================

export function displayOpportunity(logger: Logger, path: ArbitrageOpportunity): void {
  const hops = path.steps.length;
  const route = path.steps.map((s) => `${s.tokenIn.symbol}→${s.tokenOut.symbol}`).join(' → ');

  logger.info(`🎯 ${hops}-Hop Arbitrage: ${path.id}`);
  logger.info(`   📍 Route: ${route}`);
  logger.info(`   💰 Borrow: ${formatUnits(path.borrowAmount, path.borrowToken.decimals)} ${path.borrowToken.symbol}`);

  for (let i = 0; i < path.steps.length; i++) {
    const s = path.steps[i];
    logger.info(
      `   ${i + 1}. ${formatUnits(s.amountIn, s.tokenIn.decimals)} ${s.tokenIn.symbol} → ` +
        `${formatUnits(s.amountOut, s.tokenOut.decimals)} ${s.tokenOut.symbol} ` +
        `(${s.pool.venue.name}, impact: ${s.priceImpact.toFixed(2)}%)`,
    );
  }

  logger.info(`   💵 Gross: $${path.grossProfitUSD.toFixed(4)}`);
  logger.info(`   ⛽ Gas: $${path.gasAnalysis.gasCostUSD.toFixed(4)}`);
  logger.info(`   💰 Net: $${path.netProfitUSD.toFixed(4)}`);
  logger.info(`   📊 Total Slippage: ${path.totalSlippage.toFixed(4)}%\n`);
}
