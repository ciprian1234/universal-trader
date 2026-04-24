// ════════════════════════════════════════════════════════════
// WIRING (in main.ts)
// ════════════════════════════════════════════════════════════

import type { IVenueStateStore } from './layer1';

// Layer 2 subscribes to Layer 1 changes and rebuilds its view:

interface MarketIndexConfig {
  venueStateStore: IVenueStateStore;
  symbolResolver: ISymbolResolver; // maps (chainId, address) → canonical symbol
  staleThresholdMs: number; // quotes older than this are excluded
}

/**
 * Symbol resolver — critical bridge between address-world and symbol-world.
 * Built from your config's token whitelist.
 */
interface ISymbolResolver {
  /** Get canonical symbol for a token address on a chain */
  resolve(chainId: number, address: string): string | undefined;

  /** Get address for a canonical symbol on a chain (reverse lookup) */
  getAddress(symbol: string, chainId: number): string | undefined;

  /** Check if a token is whitelisted */
  isWhitelisted(chainId: number, address: string): boolean;

  /** Register WETH→ETH style mappings */
  registerAlias(alias: string, canonical: string): void;
}
