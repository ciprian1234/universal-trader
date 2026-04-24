import { exec, spawn } from 'child_process';
import { appConfig } from '@/config';
import type { ChainConfig } from '@/config/models';
import { logger } from '@/utils';
import { ethers } from 'ethers';
import { FLASH_ARBITRAGE_ABI } from '@/workers/watcher-evm/core/flash-arbitrage-handler/flash-arbitrage-contract-abi';
import { CacheService } from '@/utils/cache-service';
import { WorkerDb } from '@/workers/watcher-evm/db';
import { EventBus } from '@/workers/watcher-evm/core/event-bus';
import { Blockchain } from '@/workers/watcher-evm/core/blockchain';
import { TokenManager } from '@/workers/watcher-evm/core/token-manager';
import path from 'path/win32';
import { balanceStrWithSymbol } from './helpers';
import type { ArbitrageOpportunity } from '@/workers/watcher-evm/core/interfaces';

// ========================================================================================
// CONFIG — edit these for the swap you want to test
// ========================================================================================

const SPAWN_HARDHAT_NODE = false;
const HARDHAT_PORT = 8545;
const HARDHAT_RPC_URL = `http://127.0.0.1:${HARDHAT_PORT}`;
const HARDHAT_PROJECT_PATH = path.resolve(__dirname, '../../../eth-flash-contract'); // path to Hardhat project

// hardhat process handle
let hardhatProcess: any = null;
let hardhatOutput = '';

// NOTE: those are safe to commit => from hardhat default accounts(0)
const CONTRACT_ADDRESS = '0xeB6032426EA61f65321A95C21432f4E19fC961B6';
const WALLET_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // (hardhat[0].privateKey)
if (!WALLET_PRIVATE_KEY) throw new Error('WALLET_PRIVATE_KEY not set in config');

// input pool from DB
const DB_OPPORTUNITY_ID = '1776733825017@uniswap-v2(30)[WETH->PUNK]___uniswap-v4(30000)[PUNK->ETH]';

// chain config (note: we override the RPC URL if we're spawning a hardhat node)
const chainConfig = appConfig.platforms['ethereum'] as ChainConfig;
const WETH_ADDRESS = chainConfig.wrappedNativeTokenAddress;
if (SPAWN_HARDHAT_NODE) chainConfig.providerRpcUrl = HARDHAT_RPC_URL;

// Core app services
if (!process.env.SCRIPTS_DATABASE_URL) throw new Error('SCRIPTS_DATABASE_URL not set in environment variables');
const cache = new CacheService(chainConfig.chainId);
const db = new WorkerDb(process.env.SCRIPTS_DATABASE_URL, chainConfig.chainId);
const eventBus = new EventBus();
let blockchain: Blockchain;
let tokenManager: TokenManager;

// ========================================================================================
// MAIN
// ========================================================================================
async function main() {
  try {
    const opportunity = await db.getArbitrageOpportunityById(DB_OPPORTUNITY_ID);
    if (!opportunity) throw new Error(`Opportunity with ID ${DB_OPPORTUNITY_ID} not found in DB`);
    if (!opportunity.foundAtBlock) throw new Error(`Opportunity with ID ${DB_OPPORTUNITY_ID} does not have foundAtBlock set`);
    const { trade, grossProfitUSD, grossProfitToken, foundAtBlock } = opportunity;
    logger.info(`🔍 Loaded opportunity: ${opportunity.id} with profit ${grossProfitUSD}$`);
    logger.info(`🔗 Opportunity found at block: ${foundAtBlock}`);

    // Start Hardhat fork at the specific block
    if (SPAWN_HARDHAT_NODE) await startHardhatFork(foundAtBlock);

    // init core app services
    blockchain = new Blockchain({ chainConfig, cache, eventBus });
    tokenManager = new TokenManager({ chainConfig, blockchain, eventBus, db });
    await tokenManager.init(); // load tokens from DB and trusted tokens from coingecho
    const ethToken = tokenManager.getToken(ethers.ZeroAddress)!;
    const wethToken = tokenManager.getToken(WETH_ADDRESS)!;

    // check wallet
    const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, blockchain.getProvider());
    const walletAddress = await wallet.getAddress();
    const walletEthBalance = await tokenManager.getTokenBalance(ethers.ZeroAddress, walletAddress);
    const walletWethBalance = await tokenManager.getTokenBalance(WETH_ADDRESS, walletAddress);
    logger.info(`👤 Wallet: ${walletAddress}`);
    logger.info(`👤 Wallet ${balanceStrWithSymbol(ethToken, walletEthBalance)}`);
    logger.info(`👤 Wallet ${balanceStrWithSymbol(wethToken, walletWethBalance)}`);

    // deploy if needed and check contract ownership
    let contractAddress = CONTRACT_ADDRESS;
    if (SPAWN_HARDHAT_NODE) contractAddress = await deployFlashArbitrageContract(blockchain.getProvider(), wallet);
    const arbitrageContract = new ethers.Contract(contractAddress, FLASH_ARBITRAGE_ABI, wallet);
    const contractOwner = await arbitrageContract.owner();
    if (walletAddress.toLowerCase() !== contractOwner.toLowerCase()) throw new Error('Signer is not the contract owner');
    logger.info(`🏦 Arbitrage contract at ${contractAddress}, owner: ${contractOwner}`);

    // execute the arbitrage
    try {
      await simulateArbitrage(arbitrageContract, opportunity);
      throw 'stop';

      logger.info('🚀 Executing arbitrage...');
      const tx = await arbitrageContract.executeTrade(trade);
      logger.info(`📡 Transaction sent: ${tx.hash}`);
      const receipt = await tx.wait();
      logger.info(`✅ Transaction confirmed in block ${receipt.blockNumber} with status ${receipt.status}`);
    } catch (error) {
      logger.error('Error executing arbitrage', { error });
    }
  } catch (error) {
    logger.error('Error in main execution', { error });
    process.exit(1);
  }
}

main()
  .then(() => logger.info('✅ Operation successful'))
  .catch((err) => {
    logger.error(`❌ Error: ${err.message}`, { err });
    process.exit(1);
  })
  .finally(async () => {
    logger.info('Cleaning up resources...');
    await db.destroy();
    await blockchain.cleanup();
    process.exit(0);
  });

// ================================================================================================
// Simulate Arbitrage
// ================================================================================================
async function simulateArbitrage(contract: ethers.Contract, opportunity: ArbitrageOpportunity) {
  const CONTRACT_INTERFACE = new ethers.Interface(FLASH_ARBITRAGE_ABI);
  const borrowToken = opportunity.borrowToken;
  try {
    await contract.simulateTrade.staticCall(opportunity.trade!);
  } catch (result: any) {
    // simulation always throws an error because the contract reverts at the end
    try {
      const parsed = CONTRACT_INTERFACE.parseError(result.data);
      if (parsed?.name === 'SimulationSuccess') {
        const expectedProfit = ethers.formatUnits(opportunity.grossProfitToken, borrowToken.decimals);
        const profitOut = ethers.formatUnits(parsed.args[0] as bigint, borrowToken.decimals); // NOTE: this its profit after loan repayment
        logger.info(`✅ Simulation succesful for ${opportunity.id}, expected: ${expectedProfit}, profitOut: ${profitOut}`);
      } else if (parsed?.name === 'SimulationError') {
        const innerErrBytes = parsed.args[0] as string;
        const innerError = CONTRACT_INTERFACE.parseError(innerErrBytes);

        if (innerError?.name === 'SwapStepFailed') {
          const stepIndex = Number(innerError.args[0] as bigint);
          const stepReasonBytes = innerError.args[1] as string;

          // Optionally decode the inner-inner reason (pool's actual error)
          // if (stepReasonBytes && stepReasonBytes !== '0x') {
          //   try {
          //     const poolParsed = this.CONTRACT_INTERFACE.parseError(stepReasonBytes);
          //     poolError = poolParsed?.name ?? `selector: ${stepReasonBytes.slice(0, 10)}`;
          //   } catch {
          //     poolError = `raw: ${stepReasonBytes.slice(0, 100)}`;
          //   }
          // }

          const failedStep = opportunity.steps[stepIndex];
          logger.warn(`Simulation for ${opportunity.id} failed at step ${stepIndex}`, { failedStep, stepReasonBytes });
        } else if (innerError?.name === 'LoanRepaymentNotMet' || innerError?.name === 'MinProfitNotMet') {
          const formattedExpected = ethers.formatUnits(innerError.args[1] as bigint, borrowToken.decimals);
          const formattedActual = ethers.formatUnits(innerError.args[2] as bigint, borrowToken.decimals);
          const errorMsg = `${innerError?.name}: expected: ${formattedExpected}, actual: ${formattedActual}`;
          logger.warn(`Simulation for ${opportunity.id} failed with ${errorMsg}`);
        } else {
          // NOTE: other types of errors aren't expected in simulation
          logger.error(`❌ Simulation for ${opportunity.id} failed with error`, { innerError });
        }
      }
    } catch (err) {
      logger.error('Error simulating arbitrage', { err });
    }
  }
}

// ================================================================================================
// HARDHAT FORK MANAGEMENT
// ================================================================================================
async function startHardhatFork(blockNumber: number): Promise<void> {
  console.log(`🔧 Starting Hardhat fork at block ${blockNumber}...`);
  console.log(`   Hardhat project path: ${HARDHAT_PROJECT_PATH}`);
  console.log(`   Forking from: ${process.env.PLATFORM_ETHEREUM_RPC_URL_HTTP}`);

  return new Promise((resolve, reject) => {
    // Start Hardhat node with forking
    hardhatProcess = spawn(
      'npx',
      [
        'hardhat',
        'node',
        '--fork',
        process.env.PLATFORM_ETHEREUM_RPC_URL_HTTP!,
        '--fork-block-number',
        blockNumber.toString(),
        '--port',
        HARDHAT_PORT.toString(),
      ],
      {
        cwd: HARDHAT_PROJECT_PATH, // run from hardhat project directory
        shell: true,
      },
    );

    hardhatProcess.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      hardhatOutput += text;
      // Wait for "Started HTTP and WebSocket JSON-RPC server"
      if (text.includes('Started HTTP and WebSocket JSON-RPC server')) {
        console.log('✅ Hardhat fork ready');
        // Give it a moment to fully initialize
        setTimeout(() => resolve(), 2000);
      }
    });

    hardhatProcess.stderr.on('data', (data: Buffer) => {
      hardhatOutput += data.toString();
    });

    hardhatProcess.on('error', (error: Error) => {
      reject(new Error(`Failed to start Hardhat: ${error.message}`));
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (!hardhatOutput.includes('Started HTTP and WebSocket JSON-RPC server')) {
        reject(new Error('Hardhat fork timed out'));
      }
    }, 30000);
  });
}

// ================================================================================================
// Deploy Flash Arbitrage Contract
// ================================================================================================
async function deployFlashArbitrageContract(provider: ethers.Provider, wallet: ethers.Wallet) {
  console.log('\n🚀 Deploying Flash Arbitrage Contract...');

  // compile contract first
  console.log('🔨 Compiling contract...');
  await exec('npx hardhat compile', { cwd: HARDHAT_PROJECT_PATH });
  console.log('✅ Contract compiled');

  const artifact = require('../../../eth-flash-contract/artifacts/contracts/FlashArbitrage.sol/FlashArbitrage.json');
  const contractFactory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);

  const contract = await contractFactory.deploy();
  await contract.waitForDeployment();

  const contractAddress = await contract.getAddress();
  console.log(`✅ Contract deployed at: ${contractAddress}`);
  return contractAddress;
}
