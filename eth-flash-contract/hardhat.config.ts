import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';
require('dotenv').config();

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.30',
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {
      chainId: 1,
      forking: {
        url: process.env.ETHEREUM_RPC_URL as string,
        // blockNumber: undefined,
        blockNumber: 24005636,
      },
      mining: {
        auto: true,
        interval: 0,
      },
      loggingEnabled: true,
      allowUnlimitedContractSize: true,
    },
    localhost: {
      url: 'http://127.0.0.1:8545',
      chainId: 1,
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL,
      accounts: [process.env.MAINNET_PRIVATE_KEY!],
      chainId: 11155111,
      // Increase timeouts and gas settings
      timeout: 120000, // 2 minutes
      // gas: 'auto',
      // gasPrice: 'auto',
      // // Add retry configuration
      // httpHeaders: {},
    },
    eth_mainnet: {
      url: process.env.ETHEREUM_RPC_URL,
      accounts: [process.env.MAINNET_PRIVATE_KEY!],
      chainId: 1,
      timeout: 180000, // 3 minutes
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY,
  },
};

export default config;
