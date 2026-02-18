// ================================================================================================
// APP CONFIG — resolves enabled chains from environment
// ================================================================================================

import type { AppConfig, ChainConfig } from './types.ts';
import * as chains from './chains/index.ts';

export type { AppConfig, ChainConfig, DexConfig, TokenConfig } from './types.ts';

// All known chain configs
const ALL_CHAINS: Record<number, ChainConfig> = {
  1: chains.ethereum,
  42161: chains.arbitrum,
  8453: chains.base,
};

/** Parse ENABLED_CHAINS env var (default: "1") */
function parseEnabledChains(): number[] {
  const env = process.env.ENABLED_CHAINS ?? '1';
  return env
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && ALL_CHAINS[n] !== undefined);
}

/** Resolve the full application config from environment */
export function resolveConfig(): AppConfig {
  const enabledChainIds = parseEnabledChains();

  // Build chains map with only enabled chains that have RPC URLs
  const resolvedChains: Record<number, ChainConfig> = {};
  for (const id of enabledChainIds) {
    const chain = ALL_CHAINS[id];
    if (!chain) continue;

    // Verify RPC URL is set
    const rpcUrl = process.env[chain.rpcEnvVar];
    if (!rpcUrl) {
      console.warn(
        `⚠️  Chain ${chain.chainName} (${id}) enabled but ${chain.rpcEnvVar} not set — skipping`,
      );
      continue;
    }

    resolvedChains[id] = chain;
  }

  // Flash contract addresses per chain
  const flashContracts: Record<number, string> = {};
  for (const id of enabledChainIds) {
    const addr =
      process.env[`FLASH_CONTRACT_${id}`] ?? process.env.FLASH_ARBITRAGE_CONTRACT_ADDRESS;
    if (addr) flashContracts[id] = addr;
  }

  return {
    enabledChainIds: Object.keys(resolvedChains).map(Number),
    adminPort: parseInt(process.env.ADMIN_PORT ?? '4040', 10),
    flashContracts,
    flashbots:
      process.env.FLASHBOTS_RELAY_URL && process.env.FLASHBOTS_AUTH_KEY
        ? {
            relayUrl: process.env.FLASHBOTS_RELAY_URL,
            authSignerKey: process.env.FLASHBOTS_AUTH_KEY,
          }
        : undefined,
    chains: resolvedChains,
  };
}

/** Get RPC URL for a chain from env */
export function getChainRpcUrl(chain: ChainConfig): string {
  return process.env[chain.rpcEnvVar] ?? '';
}
