import type { DexPoolState } from '@/shared/data-model/layer1';
import type { PoolEvent } from '@/workers/watcher-evm/core/interfaces';

export function printPool(pool: DexPoolState): string {
  return `📊 ${pool.venue.name} ${pool.tokenPair.key}(${pool.feeBps}) (id: '${pool.address}')`;
}

export function printPoolInEvent(pool: DexPoolState, event: PoolEvent): string {
  const details = `📊 ${pool.venue.name} ${pool.tokenPair.key}(${pool.feeBps}) update event`;
  const deltaMs = Date.now() - event.meta.blockReceivedTimestamp;
  return `${details.padEnd(60)} 🔗 ${event.meta.blockNumber} (+${deltaMs}ms) (id: '${pool.address}')`;
}
