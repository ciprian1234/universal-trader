// ================================================================================================
// BASE CHAIN CONFIGURATION
// ================================================================================================

import type { ChainConfig } from '../types.ts';

const base: ChainConfig = {
  chainId: 8453,
  chainName: 'Base',
  nativeToken: 'ETH',
  wrappedNativeTokenAddress: '0x4200000000000000000000000000000000000006',
  preferredBorrowTokens: ['WETH', 'USDC'],
  rpcEnvVar: 'BASE_RPC_URL_WS',

  fetchBlockDataInterval: 10,
  minPriorityFee: 1_000_000n, // 0.001 gwei
  maxPriorityFee: 500_000_000n, // 0.5 gwei

  tokens: [
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH' },
    { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC' },
  ],

  dexConfigs: [
    {
      name: 'UniswapV3-Base',
      type: 'uniswap-v3',
      factoryAddress: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
      routerAddress: '0x2626664c2603336E57B271c5C0b26F421741e481',
    },
    {
      name: 'Aerodrome',
      type: 'solidly',
      factoryAddress: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
      routerAddress: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
    },
  ],

  arbitrage: {
    minGrossProfitUSD: 3,
    maxSlippage: 50,
    minLiquidityUSD: 1_000,
    maxHops: 3,
  },
};

export default base;
