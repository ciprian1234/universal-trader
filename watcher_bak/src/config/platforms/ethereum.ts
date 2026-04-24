// ================================================================================================
// ETHEREUM MAINNET CHAIN CONFIGURATION
// ================================================================================================

import { ethers } from 'ethers';
import type { ChainConfig } from '../models.ts';

const ethereum: ChainConfig = {
  name: 'ethereum', // used as workerId and for logging, must be unique across platforms
  chainId: 1,
  platformType: 'chain',
  providerRpcUrl: process.env.PLATFORM_ETHEREUM_RPC_URL_WS!,

  // Tokens configuration
  nativeToken: 'ETH',
  wrappedNativeToken: 'WETH',
  wrappedNativeTokenAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'.toLowerCase(),
  stablecoinTokens: ['USDT', 'USDC', 'USDS', 'USD1', 'DAI', 'FRAX'], // USD stable coins
  discoveryTokens: ['WETH', 'USDT', 'USDC'], // used for pair discovery and as preferred borrow tokens
  priceAnchorTokens: [
    // core tokens
    'WETH',
    'WBTC',
    'LINK',
    'UNI',
    'AAVE',
    // stablecoins USD
    'USDT',
    'USDC',
    'USDS',
    'USD1',
    'DAI',
    'FRAX',
    // gold
    'PAXG',
    'XAUT',
    // additional tokens
    // 'fwWETH',
    // 'fwWBTC',
  ], // used as USD price anchors for liquidity/profit calculatons

  // database URL for this chain's worker
  databaseUrl: process.env.APP_CONFIG_DATABASE_URL!,

  // enabled
  enabled: true,
  internalArbitrageEnabled: true,

  // Gas
  gasDataFetchInterval: 5,
  minPriorityFee: ethers.parseUnits('1.13', 'gwei'), // 1.13 gwei (handled through bribe)
  maxPriorityFee: ethers.parseUnits('100', 'gwei'), // 100 gwei

  // DEX venues
  dexConfigs: [
    {
      name: 'uniswap-v2',
      protocol: 'v2',
      factoryAddress: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
      routerAddress: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
      initCodeHash: '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f',
    },
    {
      name: 'sushiswap-v2',
      protocol: 'v2',
      factoryAddress: '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac',
      routerAddress: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
      initCodeHash: '0xe18a34eb0e04b04f7a0ac29a6e80748dca96319b42c54d679cb821dca90c6303',
    },
    {
      name: 'pancakeswap-v2',
      protocol: 'v2',
      factoryAddress: '0x1097053Fd2ea711dad45caCcc45EfF7548fCB362',
      routerAddress: '0xEfF92A263d31888d860bD50809A8D171709b7b1c',
      initCodeHash: '0x57224589c67f3f30a6b0d7a1b54cf3153ab84563bc609ef41dfb34f8b2974d2d',
    },
    // {
    //   name: 'fraxswap-v2',
    //   protocol: 'v2',
    //   factoryAddress: '0x43eC799eAdd63848443E2347C49f5f52e8Fe0F6f',
    //   routerAddress: '0xC14d550632db8592D1243Edc8B95b0Ad06703867',
    //   initCodeHash: '0xe469e96d32cb39bca5416d9d901a18f36dd1f3efdd4231b546a7b85ec2264b90',
    // },
    {
      name: 'uniswap-v3',
      protocol: 'v3',
      factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
      routerAddress: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      quoterAddress: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
      initCodeHash: '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54',
    },
    {
      name: 'uniswap-v4',
      protocol: 'v4',
      poolManagerAddress: '0x000000000004444c5dc75cB358380D2e3dE08A90',
      positionManagerAddress: '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e',
      stateViewAddress: '0x7ffe42c4a5deea5b0fec41c94c136cf115597227',
      routerAddress: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af',
      quoterAddress: '0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203',
    },
  ],

  arbitrage: {
    minGrossProfitUSD: 5,
    maxSlippageBps: 500, // 5%
    minLiquidityUSD: 10_000,
    maxHops: 3,
  },

  // flash loan arbitrage contract address
  arbitrageContractAddress: process.env.PLATFORM_ETHEREUM_ARBITRAGE_CONTRACT_ADDRESS!,

  // wallet private key for signing transactions
  walletPrivateKey: process.env.PLATFORM_ETHEREUM_WALLET_PRIVATE_KEY!,

  // Flashbots
  flashbotsEnabled: process.env.PLATFORM_ETHEREUM_USE_FLASHBOTS === 'true',
  flashbots: {
    relayUrl: process.env.PLATFORM_ETHEREUM_FLASHBOTS_RELAY_URL!,
    authSignerKey: process.env.PLATFORM_ETHEREUM_FLASHBOTS_AUTH_KEY,
  },
};

export default ethereum;
