// ================================================================================================
// ETHEREUM MAINNET CHAIN CONFIGURATION
// ================================================================================================

import type { ChainConfig } from '../types.ts';

const ethereum: ChainConfig = {
  chainId: 1,
  chainName: 'Ethereum',
  nativeToken: 'ETH',
  wrappedNativeTokenAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  preferredBorrowTokens: ['WETH', 'USDC', 'USDT', 'WBTC'],
  rpcEnvVar: 'ETH_RPC_URL_WS',

  // Gas
  fetchBlockDataInterval: 5,
  minPriorityFee: 50_000_000n, // 0.05 gwei
  maxPriorityFee: 100_000_000_000n, // 100 gwei

  tokens: [
    { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH' },
    { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC' },
    { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT' },
    // { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', symbol: 'WBTC' },
    // { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI' },
  ],

  dexConfigs: [
    {
      name: 'UniswapV2',
      type: 'uniswap-v2',
      factoryAddress: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
      routerAddress: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
    },
    {
      name: 'SushiswapV2',
      type: 'uniswap-v2',
      factoryAddress: '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac',
      routerAddress: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
    },
    {
      name: 'PancakeswapV2',
      type: 'uniswap-v2',
      factoryAddress: '0x1097053Fd2ea711dad45caCcc45EfF7548fCB362',
      routerAddress: '0xEfF92A263d31888d860bD50809A8D171709b7b1c',
    },
    {
      name: 'UniswapV3',
      type: 'uniswap-v3',
      factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
      routerAddress: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      quoterAddress: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
    },
  ],

  arbitrage: {
    minGrossProfitUSD: 50,
    maxSlippage: 50,
    minLiquidityUSD: 10_000,
    maxHops: 3,
  },
};

export default ethereum;
