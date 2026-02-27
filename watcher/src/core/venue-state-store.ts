import type {
  VenueState,
  DexPoolState,
  CexMarketState,
  VenueChangeType,
  VenueChangeListener,
  IVenueStateStore,
  Venue,
} from '@/shared/data-model/layer1';
import type { PairId } from '@/shared/data-model/token';

/**
 * Layer 1 Store — raw venue states, indexed for fast lookup.
 * Pure storage. No derived data. No business logic.
 */
export class VenueStateStore implements IVenueStateStore {
  private readonly states = new Map<string, VenueState>();

  // Indices
  private readonly byChain = new Map<number, Set<string>>();
  private readonly byPairId = new Map<string, Set<string>>();
  private readonly byVenueKey = new Map<string, Set<string>>();
  private readonly byToken = new Map<string, Set<string>>(); // "chainId:tokenAddr" → state IDs

  // Listeners
  private readonly listeners: VenueChangeListener[] = [];

  set(state: VenueState): void {
    const isNew = !this.states.has(state.id);
    this.states.set(state.id, state);

    if (isNew) this.index(state);

    for (const fn of this.listeners) {
      fn(state, isNew ? 'add' : 'update');
    }
  }

  setBatch(states: VenueState[]): void {
    for (const state of states) {
      this.set(state);
    }
  }

  // ... rest of IVenueStateStore implementation (get, remove, getByChain, etc.)
  // Same pattern as your current GlobalDataStore but ONLY stores VenueState.
  // No price calculations, no USD values, no pair aggregation.

  onChange(listener: VenueChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  // ...index helpers same as GlobalDataStore.indexPool...
}
