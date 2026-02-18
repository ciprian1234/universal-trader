// ================================================================================================
// ARBITRUM CHAIN CONFIGURATION
// ================================================================================================

import type { ChainConfig } from '../types.ts';

const arbitrum: ChainConfig = {
  chainId: 42161,
  chainName: 'Arbitrum',
  nativeToken: 'ETH',
  wrappedNativeTokenAddress: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  preferredBorrowTokens: ['WETH', 'USDC', 'USDT'],
  rpcEnvVar: 'ARB_RPC_URL_WS',

  // Gas (L2 — lower fees, more frequent blocks)
  fetchBlockDataInterval: 10,
  minPriorityFee: 10_000_000n, // 0.01 gwei
  maxPriorityFee: 1_000_000_000n, // 1 gwei

  tokens: [
    { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH' },
    { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC' },
    { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT' },
  ],

  dexConfigs: [
    {
      name: 'UniswapV3-Arb',
      type: 'uniswap-v3',
      factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
      routerAddress: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      quoterAddress: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
    },
    {
      name: 'Camelot',
      type: 'uniswap-v2',
      factoryAddress: '0x6EcCab422D763aC031210895C81787E87B43A652',
      routerAddress: '0xc873fEcbd354f5A56E00E710B90EF4201db2448d',
    },
    {
      name: 'SushiswapV2-Arb',
      type: 'uniswap-v2',
      factoryAddress: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
      routerAddress: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
    },
  ],

  arbitrage: {
    minGrossProfitUSD: 5, // lower threshold on L2
    maxSlippage: 50,
    minLiquidityUSD: 1_000,
    maxHops: 3,
  },
};

export default arbitrum;
