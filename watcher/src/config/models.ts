// ================================================================================================
// MULTI-CHAIN CONFIGURATION
// ================================================================================================

import { z } from 'zod';

export const TokenConfigSchema = z.object({
  address: z.string(),
  symbol: z.string(),
  decimals: z.number().optional(),
});

export const DexConfigSchema = z.object({
  name: z.string(),
  type: z.string(), // 'uniswap-v2', 'uniswap-v3', 'solidly', 'curve', etc.
  factoryAddress: z.string(),
  routerAddress: z.string(),
  quoterAddress: z.string().optional(),
  poolManagerAddress: z.string().optional(), // V4
  stateViewAddress: z.string().optional(), // V4
});

export const PlatformConfigSchema = z.object({
  id: z.string(), // unique identifier, e.g. 'ethereum', 'arbitrum', 'binance'
  workerName: z.string(),
  platformType: z.string(), // 'chain', 'exchange'
  name: z.string(), // e.g. 'ethereum', 'arbitrum', 'binance'
  enabled: z.boolean(),
  internalArbitrageEnabled: z.boolean(),
});

export const ChainConfigSchema = PlatformConfigSchema.extend({
  platformType: z.literal('chain'),
  chainId: z.number(),
  nativeToken: z.string(),
  providerRpcUrl: z.url(),
  wrappedNativeTokenAddress: z.string(),
  preferredBorrowTokens: z.array(z.string()),

  // Tokens
  tokens: z.array(TokenConfigSchema),

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

export type TokenConfig = z.infer<typeof TokenConfigSchema>;
export type DexConfig = z.infer<typeof DexConfigSchema>;
export type PlatformConfig = z.infer<typeof PlatformConfigSchema>;
export type ChainConfig = z.infer<typeof ChainConfigSchema>;
export type ExchangeConfig = z.infer<typeof ExchangeConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;
