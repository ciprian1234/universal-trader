import type { DexProtocol, VenueId, DexVenueId, CexVenueId } from './layer1';

// ════════════════════════════════════════════════════════════
// VENUE KEY — string key for config registry lookups
// ════════════════════════════════════════════════════════════

export type VenueKey = string;

export function toVenueKey(venue: VenueId): VenueKey {
  if (venue.type === 'dex') return `dex:${venue.name}:${venue.chainId}`;
  return `cex:${venue.name}`;
}

// ════════════════════════════════════════════════════════════
// VENUE CONFIG — static, immutable, loaded once at startup
// ════════════════════════════════════════════════════════════

interface VenueConfigBase {
  key: VenueKey;
  name: string; // "uniswap", "sushiswap", "binance"
  type: 'dex' | 'cex';
}

// ── DEX Config ──────────────────────────────────────────────

interface DexVenueConfigBase extends VenueConfigBase {
  type: 'dex';
  chainId: number;
  protocol: DexProtocol;
  factoryAddress: string;
  routerAddress: string;
}

export interface DexV2VenueConfig extends DexVenueConfigBase {
  protocol: 'v2';
  initCodeHash: string; // for deterministic pool address computation
}

export interface DexV3VenueConfig extends DexVenueConfigBase {
  protocol: 'v3';
  quoterAddress: string; // V3 Quoter/QuoterV2 for simulation
  initCodeHash: string;
}

export interface DexV4VenueConfig extends DexVenueConfigBase {
  protocol: 'v4';
  poolManagerAddress: string;
  stateViewAddress: string;
  // V4 doesn't use factory/initCodeHash — pools are created via PoolManager
}

export type DexVenueConfig = DexV2VenueConfig | DexV3VenueConfig | DexV4VenueConfig;

// ── CEX Config ──────────────────────────────────────────────

export interface CexVenueConfig extends VenueConfigBase {
  type: 'cex';
  apiBaseUrl: string;
  wsUrl: string;
  rateLimitPerSecond: number;
  // API keys stay in env vars, NOT here
}

export type VenueConfig = DexVenueConfig | CexVenueConfig;

// ════════════════════════════════════════════════════════════
// VENUE CONFIG REGISTRY — read-only after initialization
// ════════════════════════════════════════════════════════════

export interface IVenueConfigRegistry {
  // Registration (called once at startup)
  register(config: VenueConfig): void;

  // Read — by key
  get(venueKey: VenueKey): VenueConfig | undefined;
  getDex(venueKey: VenueKey): DexVenueConfig | undefined;
  getCex(venueKey: VenueKey): CexVenueConfig | undefined;

  // Read — filtered
  getAll(): VenueConfig[];
  getAllDex(): DexVenueConfig[];
  getAllCex(): CexVenueConfig[];
  getByChain(chainId: number): DexVenueConfig[];
  getByProtocol(protocol: DexProtocol): DexVenueConfig[];

  // Lookup from VenueId (convenience — derives key internally)
  getForVenue(venue: VenueId): VenueConfig | undefined;
}
