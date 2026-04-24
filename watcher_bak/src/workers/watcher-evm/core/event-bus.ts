/**
 * 📡 EVENT BUS: Central event coordination and arbitrage opportunity detection
 */
import { EventEmitter } from 'events';
import type { ArbitrageOpportunity } from './interfaces';
import type { BlockEntry } from './block-manager';
import type { DexPoolState } from '@/shared/data-model/layer1';
import type { TokenOnChain, TokenPairOnChain } from '@/shared/data-model/token';

// ================================================================================================
// EVENT TYPES
// ================================================================================================

export type ApplicationEventName = 'initialized' | 'connection-lost' | 'reorg-detected' | 'reorg-recovered';

export interface ApplicationEventBase {
  name: ApplicationEventName;
}

export interface InitializedApplicationEvent extends ApplicationEventBase {
  name: 'initialized';
}

export interface ConnectionLostApplicationEvent extends ApplicationEventBase {
  name: 'connection-lost';
  data: {
    blockNumber: number;
  };
}

export interface ReorgDetectedApplicationEvent extends ApplicationEventBase {
  name: 'reorg-detected';
  data: {
    blockNumber: number;
  };
}

export interface ReorgRecoveredApplicationEvent extends ApplicationEventBase {
  name: 'reorg-recovered';
  data: {
    blockNumber: number;
    affectedPoolIds: Set<string>;
    error?: boolean; // Indicates if recovery had issues
  };
}

export type ApplicationEvent =
  | InitializedApplicationEvent
  | ConnectionLostApplicationEvent
  | ReorgDetectedApplicationEvent
  | ReorgRecoveredApplicationEvent;

export interface PoolsUpsertBatchPayload {
  pools: DexPoolState[];
  block: BlockEntry;
  silent?: boolean; // If true, skip opportunity searching after applying the batch
}

// ================================================================================================
// EVENT BUS CLASS
// ================================================================================================

export class EventBus extends EventEmitter {
  // private readonly logger = createLogger('[EventBus]');

  constructor() {
    super();
    this.setMaxListeners(1024); // Allow many subscribers
  }

  /**
   * Wraps a listener so that async errors don't become unhandled rejections.
   * Node EventEmitter ignores Promises returned by listeners — this fills that gap.
   */
  // private safeOn<T>(event: string, callback: (payload: T) => void | Promise<void>): () => void {
  //   const safeCallback = (payload: T) => {
  //     try {
  //       const result = callback(payload);
  //       if (result instanceof Promise) {
  //         result.catch((err: unknown) => {
  //           const msg = err instanceof Error ? err.message : String(err);
  //           this.logger.error(`Async error in "${event}" listener: ${msg}`);
  //         });
  //       }
  //     } catch (err: unknown) {
  //       const msg = err instanceof Error ? err.message : String(err);
  //       this.logger.error(`Sync error in "${event}" listener: ${msg}`);
  //     }
  //   };
  //   this.on(event, safeCallback);
  //   return () => this.off(event, safeCallback);
  // }

  // ================================================================================================
  // EVENT EMISSION
  // ================================================================================================

  emitApplicationEvent(payload: ApplicationEvent): void {
    this.emit('application-event', payload);
  }

  emitNewBlock(payload: BlockEntry): void {
    this.emit('new-block', payload);
  }

  emitTokenRegistered(payload: TokenOnChain): void {
    this.emit('token-registered', payload);
  }

  emitTokenPairRegistered(payload: TokenPairOnChain): void {
    this.emit('token-pair-registered', payload);
  }

  emitNativeTokenPriceUpdated(price: number): void {
    this.emit('native-token-price-updated', price);
  }

  emitPoolsUpsertBatch(payload: PoolsUpsertBatchPayload): void {
    if (payload.pools.length === 0) return; // Skip empty batches
    this.emit('pools-upsert-batch', payload);
  }

  emitNewArbitrageOpportunitiesBatch(payload: ArbitrageOpportunity[]): void {
    this.emit('new-arbitrage-opportunities-batch', payload);
  }

  emitArbitrageOpportunityEvent(payload: ArbitrageOpportunity): void {
    this.emit('arbitrage-opportunity-event', payload);
  }

  // ================================================================================================
  // EVENT SUBSCRIPTION HELPERS
  // ================================================================================================

  onApplicationEvent(callback: (payload: ApplicationEvent) => void): () => void {
    this.on('application-event', callback);
    return () => this.off('application-event', callback); // Return unsubscribe function
    // return this.safeOn('application-event', callback);
  }

  onNewBlock(callback: (payload: BlockEntry) => void): () => void {
    this.on('new-block', callback);
    return () => this.off('new-block', callback); // Return unsubscribe function
  }

  onTokenRegistered(callback: (payload: TokenOnChain) => void): () => void {
    this.on('token-registered', callback);
    return () => this.off('token-registered', callback); // Return unsubscribe function
  }

  onTokenPairRegistered(callback: (payload: TokenPairOnChain) => void): () => void {
    this.on('token-pair-registered', callback);
    return () => this.off('token-pair-registered', callback); // Return unsubscribe function
  }

  onNativeTokenPriceUpdated(callback: (price: number) => void): () => void {
    this.on('native-token-price-updated', callback);
    return () => this.off('native-token-price-updated', callback);
  }

  onPoolsUpsertBatch(callback: (payload: PoolsUpsertBatchPayload) => void): () => void {
    this.on('pools-upsert-batch', callback);
    return () => this.off('pools-upsert-batch', callback); // Return unsubscribe function
  }

  onNewArbitrageOpportunitiesBatch(callback: (payload: ArbitrageOpportunity[]) => void): () => void {
    this.on('new-arbitrage-opportunities-batch', callback);
    return () => this.off('new-arbitrage-opportunities-batch', callback); // Return unsubscribe function
  }

  onArbitrageOpportunityEvent(callback: (payload: ArbitrageOpportunity) => void): () => void {
    this.on('arbitrage-opportunity-event', callback);
    return () => this.off('arbitrage-opportunity-event', callback); // Return unsubscribe function
  }
}
