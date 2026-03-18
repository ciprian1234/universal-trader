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

export interface ApplicationEventPayload {
  name: string;
  data?: any;
}

export interface PoolStateUpsertEventPayload {
  pool: DexPoolState;
  previousState?: DexPoolState; // only available for 'update' actions
}

export interface PoolsBatchEventPayload {
  blockData: BlockEntry;
  poolIds: Set<string>; // list of unique pool IDs that had events in this block
}

// ================================================================================================
// EVENT BUS CLASS
// ================================================================================================

export class EventBus extends EventEmitter {
  private recentOpportunities: Map<string, number> = new Map(); // For deduplication
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.setMaxListeners(1024); // Allow many subscribers

    // Start cleanup interval
    // this.cleanupInterval = setInterval(() => {
    //   this.cleanupStaleOpportunities();
    // }, 30000); // Cleanup every 30 seconds
  }

  // ================================================================================================
  // EVENT EMISSION
  // ================================================================================================

  emitApplicationEvent(payload: ApplicationEventPayload): void {
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

  emitPoolStateUpsert(payload: PoolStateUpsertEventPayload): void {
    this.emit('pool-state-upsert', payload);
  }

  emitPoolsBatchEvent(payload: PoolsBatchEventPayload): void {
    this.emit('pools-batch-event', payload);
  }

  /**
   * 🎯 EMIT ARBITRAGE OPPORTUNITY: Opportunity emission with filtering
   */
  emitArbitrageOpportunity(payload: ArbitrageOpportunity): void {
    // Check for duplicates
    // const opportunityKey = this.generateOpportunityKey(payload);
    // const lastEmitted = this.recentOpportunities.get(opportunityKey);
    // if (lastEmitted && Date.now() - lastEmitted < this.config.dedupTimeWindow) {
    //   this.logger.warn(`⚠️  [EventBus] Skipping duplicate opportunity: ${payload.id}`);
    //   return; // Skip duplicate
    // }

    // Mark as emitted
    // this.recentOpportunities.set(opportunityKey, Date.now());

    // Emit the opportunity
    this.emit('arbitrage-opportunity', payload);
  }

  // ================================================================================================
  // EVENT SUBSCRIPTION HELPERS
  // ================================================================================================

  onApplicationEvent(callback: (payload: ApplicationEventPayload) => void): () => void {
    this.on('application-event', callback);
    return () => this.off('application-event', callback); // Return unsubscribe function
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

  onArbitrageOpportunity(callback: (payload: ArbitrageOpportunity) => void): () => void {
    this.on('arbitrage-opportunity', callback);
    return () => this.off('arbitrage-opportunity', callback); // Return unsubscribe function
  }

  onPoolStateUpsert(callback: (payload: PoolStateUpsertEventPayload) => void): () => void {
    this.on('pool-state-upsert', callback);
    return () => this.off('pool-state-upsert', callback); // Return unsubscribe function
  }

  onPoolsBatchEvent(callback: (payload: PoolsBatchEventPayload) => void): () => void {
    this.on('pools-batch-event', callback);
    return () => this.off('pools-batch-event', callback); // Return unsubscribe function
  }

  // ================================================================================================
  // UTILITY METHODS
  // ================================================================================================

  // private generateOpportunityKey(opportunity: ArbitrageOpportunity): string {
  //   const dexPair = [opportunity.entryPool.dexName, opportunity.exitPool.dexName].sort().join('-');
  //   return `${opportunity.tokenPair.pairKey}:${dexPair}`;
  // }

  // private cleanupStaleOpportunities(): void {
  //   const now = Date.now();
  //   const staleThreshold = this.config.dedupTimeWindow * 2;

  //   for (const [key, timestamp] of this.recentOpportunities.entries()) {
  //     if (now - timestamp > staleThreshold) {
  //       this.recentOpportunities.delete(key);
  //     }
  //   }
  // }

  // ================================================================================================
  // STATISTICS AND MONITORING
  // ================================================================================================

  /**
   * 📊 GET EVENT STATISTICS: Get event bus performance metrics
   */
  getStatistics() {
    const listenersByEvent: Record<string, number> = {};

    for (const eventName of this.eventNames()) {
      listenersByEvent[eventName.toString()] = this.listenerCount(eventName);
    }

    return {
      totalListeners: Object.values(listenersByEvent).reduce((sum, count) => sum + count, 0),
      listenersByEvent,
      recentOpportunityCount: this.recentOpportunities.size,
    };
  }

  /**
   * 🧹 CLEANUP: Clean up resources
   */
  cleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.removeAllListeners();
    this.recentOpportunities.clear();
  }
}
