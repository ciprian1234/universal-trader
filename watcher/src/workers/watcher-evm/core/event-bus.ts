/**
 * 📡 EVENT BUS: Central event coordination and arbitrage opportunity detection
 */
import { EventEmitter } from 'events';
import type { PoolEvent, ArbitrageOpportunity, PoolState } from './interfaces';
import type { BlockEntry } from './block-manager';
import type { Logger } from '@/utils';

export interface EventBusConfig {
  logger: Logger;
}

// ================================================================================================
// EVENT BUS CLASS
// ================================================================================================

export class EventBus extends EventEmitter {
  private readonly logger: Logger;
  private recentOpportunities: Map<string, number> = new Map(); // For deduplication
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: EventBusConfig) {
    super();
    this.logger = config.logger;
    this.setMaxListeners(1024); // Allow many subscribers

    // Start cleanup interval
    // this.cleanupInterval = setInterval(() => {
    //   this.cleanupStaleOpportunities();
    // }, 30000); // Cleanup every 30 seconds
  }

  // ================================================================================================
  // EVENT EMISSION
  // ================================================================================================

  emitApplicationEvent(event: { name: string; data?: any }): void {
    this.emit('application-event', event);
  }

  emitNewBlock(blockEntry: BlockEntry): void {
    this.emit('newBlock', blockEntry);
  }

  emitPoolEventsBatch(data: { events: PoolEvent[] }): void {
    this.emit('poolEventsBatch', data);
  }

  /**
   * 📊 EMIT POOL UPDATE
   * This its emited after sync/swap event gets processed and pool state is updated
   * ArbitrageService listens to this event
   */
  emitPoolUpdate(poolState: PoolState, previousState?: PoolState): void {
    const updateInfo = {
      current: poolState,
      previous: previousState,
      // TODO: maybe add more info like price change, liquidity change, etc.
    };

    this.emit('pool-update', updateInfo);
  }

  /**
   * 🎯 EMIT ARBITRAGE OPPORTUNITY: Opportunity emission with filtering
   */
  emitArbitrageOpportunity(opportunity: ArbitrageOpportunity): void {
    // Check for duplicates
    // const opportunityKey = this.generateOpportunityKey(opportunity);
    // const lastEmitted = this.recentOpportunities.get(opportunityKey);
    // if (lastEmitted && Date.now() - lastEmitted < this.config.dedupTimeWindow) {
    //   this.logger.warn(`⚠️  [EventBus] Skipping duplicate opportunity: ${opportunity.id}`);
    //   return; // Skip duplicate
    // }

    // Mark as emitted
    // this.recentOpportunities.set(opportunityKey, Date.now());

    // Emit the opportunity
    this.emit('arbitrage-opportunity', opportunity);
  }

  // ================================================================================================
  // EVENT SUBSCRIPTION HELPERS
  // ================================================================================================

  onApplicationEvent(callback: (event: { name: string; data: any }) => void): () => void {
    this.on('application-event', callback);
    return () => this.off('application-event', callback); // Return unsubscribe function
  }

  onNewBlock(callback: (data: BlockEntry) => void): () => void {
    this.on('newBlock', callback);
    return () => this.off('newBlock', callback); // Return unsubscribe function
  }

  onPoolEventsBatch(callback: (data: { blockData: BlockEntry; events: PoolEvent[] }) => void): () => void {
    this.on('poolEventsBatch', callback);
    return () => this.off('poolEventsBatch', callback); // Return unsubscribe function
  }

  onArbitrageOpportunity(callback: (opportunity: ArbitrageOpportunity) => void): () => void {
    this.on('arbitrage-opportunity', callback);
    return () => this.off('arbitrage-opportunity', callback); // Return unsubscribe function
  }

  onPoolUpdate(callback: (updateInfo: any) => void): () => void {
    this.on('pool-update', callback);
    return () => this.off('pool-update', callback); // Return unsubscribe function
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
