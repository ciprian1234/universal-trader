// ================================================================================================
// EVENT BUS — typed event emitter for in-process coordination
//
// Used within the main orchestrator thread. Workers communicate via postMessage,
// but once data arrives in the main thread, services coordinate via this bus.
// ================================================================================================

import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger.ts';
// import type { ArbitrageOpportunity, PoolEvent, PoolState } from './types.ts';

export interface BlockEntry {
  number: number;
  chainId: number;
  receivedTimestamp: number;
  baseFeePerGas?: bigint;
}

export class EventBus extends EventEmitter {
  private readonly logger = createLogger('[EventBus]');
  private cleanupInterval?: Timer;

  constructor() {
    super();
    this.setMaxListeners(256);
  }

  // ── Emission ──

  emitNewBlock(block: BlockEntry): void {
    this.emit('newBlock', block);
  }

  // emitArbitrageOpportunity(opportunity: ArbitrageOpportunity): void {
  //   this.emit('arbitrage-opportunity', opportunity);
  // }

  emitAppEvent(name: string, data?: unknown): void {
    this.emit('app-event', { name, data });
  }

  // ── Subscriptions (return unsubscribe fn) ──

  onNewBlock(cb: (block: BlockEntry) => void): () => void {
    this.on('newBlock', cb);
    return () => this.off('newBlock', cb);
  }

  // onPoolUpdate(cb: (info: { current: PoolState; previous?: PoolState }) => void): () => void {
  //   this.on('pool-update', cb);
  //   return () => this.off('pool-update', cb);
  // }

  // onPoolEventsBatch(cb: (data: { chainId: number; events: PoolEvent[] }) => void): () => void {
  //   this.on('poolEventsBatch', cb);
  //   return () => this.off('poolEventsBatch', cb);
  // }

  // onArbitrageOpportunity(cb: (opp: ArbitrageOpportunity) => void): () => void {
  //   this.on('arbitrage-opportunity', cb);
  //   return () => this.off('arbitrage-opportunity', cb);
  // }

  onAppEvent(cb: (event: { name: string; data?: unknown }) => void): () => void {
    this.on('app-event', cb);
    return () => this.off('app-event', cb);
  }

  destroy(): void {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    this.removeAllListeners();
  }
}
