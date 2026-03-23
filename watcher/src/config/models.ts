// ================================================================================================
// MULTI-CHAIN CONFIGURATION
// ================================================================================================

import { DEX_VENUE_NAMES } from '@/shared/data-model/layer1';
import { z } from 'zod';

// ── DEX Config Schemas (protocol-specific) ──────────────────

const DexConfigBase = z.object({
  name: z.enum(DEX_VENUE_NAMES),
  routerAddress: z.string().length(42),
});

const DexV2ConfigSchema = DexConfigBase.extend({
  protocol: z.literal('v2'),
  factoryAddress: z.string().length(42),
  initCodeHash: z.string(),
});

const DexV3ConfigSchema = DexConfigBase.extend({
  protocol: z.literal('v3'),
  factoryAddress: z.string().length(42),
  quoterAddress: z.string().length(42),
  initCodeHash: z.string(),
});

const DexV4ConfigSchema = DexConfigBase.extend({
  protocol: z.literal('v4'),
  poolManagerAddress: z.string().length(42),
  positionManagerAddress: z.string().length(42),
  stateViewAddress: z.string().length(42),
  quoterAddress: z.string().length(42),
});

export const DexConfigSchema = z.discriminatedUnion('protocol', [DexV2ConfigSchema, DexV3ConfigSchema, DexV4ConfigSchema]);

export const PlatformConfigSchema = z.object({
  name: z.string(), // used as workerId and for logging, must be unique across platforms (e.g. 'ethereum', 'arbitrum', 'binance')
  platformType: z.string(), // 'chain', 'exchange'
  enabled: z.boolean(),
  internalArbitrageEnabled: z.boolean(),
  databaseUrl: z.string(), // required for chain platforms, optional for exchanges
});

export const ChainConfigSchema = PlatformConfigSchema.extend({
  platformType: z.literal('chain'),
  chainId: z.number(),
  providerRpcUrl: z.url(),

  // Tokens configuration
  nativeToken: z.string(),
  wrappedNativeToken: z.string(),
  wrappedNativeTokenAddress: z.string().length(42),
  stablecoinTokens: z.array(z.string()), // List of stablecoin symbols, e.g. ['USDC', 'DAI']
  discoveryTokens: z.array(z.string()), // List of token symbols used for pair discovery, e.g. ['WETH', 'USDC']
  priceAnchorTokens: z.array(z.string()), // List of token symbols as USD price anchors for liquidity/profit calculatons

  // DEXes
  dexConfigs: z.array(DexConfigSchema),

  // Gas
  gasDataFetchInterval: z.number(), // if 1 then fetch on every block, if >1 then fetch every N blocks
  minPriorityFee: z.bigint(),
  maxPriorityFee: z.bigint(),

  // Internal Arbitrage Configuration (on-chain only between DEXes, no cross-chain)
  arbitrage: z.object({
    minGrossProfitUSD: z.number(),
    maxSlippageBps: z.number(),
    minLiquidityUSD: z.number(),
    maxHops: z.number(),
  }),

  // flash loan arbitrage contract address
  arbitrageContractAddress: z.string().length(42),

  // wallet private key for signing transactions
  walletPrivateKey: z.string(),

  // flashbots
  flashbotsEnabled: z.boolean(),
  flashbots: z
    .object({
      relayUrl: z.string(),
      authSignerKey: z.string().optional(), // Optional: for authenticated bundles
    })
    .optional(),
});

export const ExchangeConfigSchema = PlatformConfigSchema.extend({
  platformType: z.literal('exchange'),
  apiEndpoint: z.string(),
  apiKeyEnvVar: z.string(),
});

export const AppConfigSchema = z.object({
  apiServerPort: z.number(),
  logLevel: z.string(),
  enabledPlatforms: z.array(z.string()),
  platforms: z.record(z.string(), PlatformConfigSchema),
});

export type DexConfig = z.infer<typeof DexConfigSchema>;
export type DexV2Config = z.infer<typeof DexV2ConfigSchema>;
export type DexV3Config = z.infer<typeof DexV3ConfigSchema>;
export type DexV4Config = z.infer<typeof DexV4ConfigSchema>;
export type PlatformConfig = z.infer<typeof PlatformConfigSchema>;
export type ChainConfig = z.infer<typeof ChainConfigSchema>;
export type ExchangeConfig = z.infer<typeof ExchangeConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;
