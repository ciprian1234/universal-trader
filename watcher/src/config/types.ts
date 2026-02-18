// ================================================================================================
// MULTI-CHAIN CONFIGURATION
// ================================================================================================

export interface TokenConfig {
  address: string;
  symbol: string;
  decimals?: number; // default 18
}

export interface DexConfig {
  name: string;
  type: string; // 'uniswap-v2', 'uniswap-v3', 'solidly', 'curve', etc.
  factoryAddress: string;
  routerAddress: string;
  quoterAddress?: string;
  poolManagerAddress?: string; // V4
  stateViewAddress?: string; // V4
}

export interface ChainConfig {
  chainId: number;
  chainName: string;
  nativeToken: string;
  wrappedNativeTokenAddress: string;
  preferredBorrowTokens: string[]; // symbols

  // RPC (resolved from env at runtime)
  rpcEnvVar: string; // e.g. 'ETH_RPC_URL_WS'

  // Gas
  fetchBlockDataInterval: number;
  minPriorityFee: bigint;
  maxPriorityFee: bigint;

  // Tokens to monitor
  tokens: TokenConfig[];

  // DEXes to monitor
  dexConfigs: DexConfig[];

  // Arbitrage thresholds
  arbitrage: {
    minGrossProfitUSD: number;
    maxSlippage: number; // basis points
    minLiquidityUSD: number;
    maxHops: number;
  };
}

export interface AppConfig {
  /** Which chains to run (subset of CHAIN_CONFIGS keys) */
  enabledChainIds: number[];

  /** Admin API port */
  adminPort: number;

  /** Flash arbitrage contract addresses per chain */
  flashContracts: Record<number, string>;

  /** Flashbots config (Ethereum only) */
  flashbots?: {
    relayUrl: string;
    authSignerKey: string;
  };

  /** Per-chain configs */
  chains: Record<number, ChainConfig>;
}
