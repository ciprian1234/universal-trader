import { appConfig } from '@/config';
import type { ChainConfig } from '@/config/models';
import type { DexPoolState } from '@/shared/data-model/layer1';
import type { TokenOnChain } from '@/shared/data-model/token';
import { logger } from '@/utils';
import { CacheService } from '@/utils/cache-service';
import { Blockchain } from '@/workers/watcher-evm/core/blockchain';
import { EventBus } from '@/workers/watcher-evm/core/event-bus';
import { FlashArbitrageHandler } from '@/workers/watcher-evm/core/flash-arbitrage-handler';
import { type SwapStepOnContract } from '@/workers/watcher-evm/core/flash-arbitrage-handler/flash-arbitrage-config';
import { FLASH_ARBITRAGE_ABI } from '@/workers/watcher-evm/core/flash-arbitrage-handler/flash-arbitrage-contract-abi';
import { TokenManager } from '@/workers/watcher-evm/core/token-manager';
import { WorkerDb } from '@/workers/watcher-evm/db';
import { ethers } from 'ethers';

// ========================================================================================
// CONFIG — edit these for the swap you want to test
// ========================================================================================

// input pool from DB
const DB_POOL_ID = '1:0x0400e42dd46a7f1ee1d665d38a4b33e4cf791f41'; // Uniswap-V3 USDC-WETH 0.05% on Ethereum mainnet
const ZERO_FOR_ONE = false; // swap direction: token0 -> token1 if true, token1 -> token0 if false

// ========================================================================================
// INIT COMPONENTS
// ========================================================================================

const chainConfig = appConfig.platforms['ethereum'] as ChainConfig;
const CONTRACT_ADDRESS = chainConfig.arbitrageContractAddress; // set in deploy-local.ts
if (!CONTRACT_ADDRESS) throw new Error('CONTRACT_ADDRESS not set in config');

const cache = new CacheService(chainConfig.chainId);
const db = new WorkerDb(chainConfig.databaseUrl, chainConfig.chainId);
const eventBus = new EventBus();

// Core app services
const blockchain = new Blockchain({ chainConfig, cache });
const tokenManager = new TokenManager({ chainConfig, blockchain, eventBus, db });

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

const WETH_ABI = [...ERC20_ABI, 'function deposit() payable'];

// ========================================================================================
// SWAP STEP BUILDER HELPERS
// ========================================================================================

function buildSwapStep(params: {
  pool: DexPoolState;
  amountIn: bigint;
  amountOutMin: bigint;
  zeroForOne: boolean;
}): SwapStepOnContract {
  const { pool } = params;
  const { token0, token1 } = pool.tokenPair;

  return {
    dexProtocol: FlashArbitrageHandler.getDexTypeEnumValueFromPool(pool.protocol),
    poolAddress: pool.address,
    tokenIn: params.zeroForOne ? token0.address : token1.address,
    tokenOut: params.zeroForOne ? token1.address : token0.address,
    feeBps: pool.feeBps,
    amountIn: params.amountIn,
    amountOutMin: params.amountOutMin,
    zeroForOne: params.zeroForOne,
    poolId: ethers.ZeroHash,
    curveIndexIn: 0,
    curveIndexOut: 0,
    extraData: '0x',
  };
}

// ========================================================================================
// HELPERS
// ========================================================================================

function formatBalance(tokenAddress: string, rawBalance: bigint) {
  const { symbol, decimals } = tokenManager.getToken(tokenAddress)!;
  return `${symbol}: ${ethers.formatUnits(rawBalance, decimals)}`;
}

async function fundContract(signer: any, token: TokenOnChain, amount: bigint) {
  const tokenContract = new ethers.Contract(token.address, WETH_ABI, signer);
  await (await tokenContract.transfer(CONTRACT_ADDRESS, amount)).wait();
  logger.info(`📤 Contract funded with ${ethers.formatEther(amount)} ${token.symbol}`);
}

// WRAP/UNWRAP helpers
async function wrapETH(signer: any, amount: bigint) {
  const wethAddress = tokenManager.getTokenBySymbol('WETH')?.address;
  if (!wethAddress) throw new Error('WETH token not found in token manager');
  const wethContract = new ethers.Contract(wethAddress, WETH_ABI, signer);
  logger.info(`\n💰 Wrapping ${ethers.formatEther(amount)} ETH to WETH...`);
  await (await wethContract.deposit({ value: amount })).wait();
  logger.info(`✅ Wrapped ${ethers.formatEther(amount)} WETH`);
}

async function unwrapWETH(signer: any, amount: bigint) {
  const wethAddress = tokenManager.getTokenBySymbol('WETH')?.address;
  if (!wethAddress) throw new Error('WETH token not found in token manager');
  const wethContract = new ethers.Contract(wethAddress, WETH_ABI, signer);
  logger.info(`\n💰 Unwrapping ${ethers.formatEther(amount)} WETH to ETH...`);
  await (await wethContract.withdraw(amount)).wait();
  logger.info(`✅ Unwrapped ${ethers.formatEther(amount)} ETH`);
}

// ========================================================================================
// MAIN
// ========================================================================================
async function main() {
  await tokenManager.init(); // load tokens from DB and trusted tokens from coingecho

  const pools = await db.loadAllPools();
  const storedPool = pools.find((p) => p.id === DB_POOL_ID);
  if (!storedPool) throw new Error(`Pool with id ${DB_POOL_ID} not found in database`);
  const pool = storedPool.state;
  const { token0, token1 } = pool.tokenPair;
  logger.info(`🔍 Loaded pool from DB: ${pool.venue.name} ${pool.tokenPair.key} fee ${pool.feeBps}bps`);
  await tokenManager.ensureTokenRegistered(token0.address, 'address');
  await tokenManager.ensureTokenRegistered(token1.address, 'address');

  const wallet = new ethers.Wallet(chainConfig.walletPrivateKey, blockchain.getProvider());
  const walletAddress = await wallet.getAddress();
  logger.info(`👤 Wallet: ${walletAddress}`);
  const walletToken0Balance = await tokenManager.getTokenBalance(token0.address, walletAddress);
  const walletToken1Balance = await tokenManager.getTokenBalance(token1.address, walletAddress);
  logger.info(`Owner token0: ${formatBalance(token0.address, walletToken0Balance)}`);
  logger.info(`Owner token1: ${formatBalance(token1.address, walletToken1Balance)}`);

  const arbitrageContract = new ethers.Contract(CONTRACT_ADDRESS, FLASH_ARBITRAGE_ABI, wallet);
  const contractOwner = await arbitrageContract.owner();
  if (walletAddress.toLowerCase() !== contractOwner.toLowerCase()) throw new Error('Signer is not the contract owner');
  logger.info(`🏦 Arbitrage contract at ${CONTRACT_ADDRESS}, owner: ${contractOwner}`);

  // log what we are about to do
  const swapMsg = ZERO_FOR_ONE ? `${token0.symbol} -> ${token1.symbol}` : `${token1.symbol} -> ${token0.symbol}`;
  logger.info(`🚀 Executing direct swap on ${pool.venue.name} ${swapMsg}`);
  // await wrapETH(wallet, ethers.parseEther('10'));

  // Fund the contract with token0 or token1 (WETH in this case)
  const amountIn = ethers.parseUnits('0.0001', ZERO_FOR_ONE ? token0.decimals : token1.decimals); // 1 WETH
  await fundContract(wallet, ZERO_FOR_ONE ? token0 : token1, amountIn);

  // Balances before
  // logger.info('📊 Balances BEFORE swap:');
  const token0Before = await tokenManager.getTokenBalance(token0.address, CONTRACT_ADDRESS);
  const token1Before = await tokenManager.getTokenBalance(token1.address, CONTRACT_ADDRESS);

  // Build the swap step
  const step = buildSwapStep({
    pool,
    zeroForOne: ZERO_FOR_ONE,
    amountIn,
    amountOutMin: 0n, // set to 0 for testing — we will validate the actual output after the swap
  });

  // Execute
  // logger.info('🔄 Calling executeDirectSwap...', { step });
  const tx = await arbitrageContract.executeDirectSwap(step);
  const receipt = await tx.wait();
  logger.info(`✅ Tx confirmed — block: ${receipt.blockNumber}, gas used: ${receipt.gasUsed}`);

  // ========================================================================================
  // VALIDATION
  // ========================================================================================
  // logger.info('🔍 Balances AFTER swap:');
  // const token0After = await tokenManager.getTokenBalance(token0.address, CONTRACT_ADDRESS);
  // const token1After = await tokenManager.getTokenBalance(token1.address, CONTRACT_ADDRESS);
  // const token0Delta = token0After - token0Before;
  // const token1Delta = token1After - token1Before;
  // logger.info(`Delta token0: ${formatBalance(token0.address, token0Delta)}`);
  // logger.info(`Delta token1: ${formatBalance(token1.address, token1Delta)}`);

  // Withdraw result back to owner
  logger.info(`💸 Withdrawing ${ZERO_FOR_ONE ? token1.symbol : token0.symbol} to owner...`);
  await (await arbitrageContract.emergencyWithdraw(ZERO_FOR_ONE ? token1.address : token0.address)).wait();
  const newWalletToken0Balance = await tokenManager.getTokenBalance(token0.address, walletAddress);
  const newWalletToken1Balance = await tokenManager.getTokenBalance(token1.address, walletAddress);

  // log wallet delta
  const walletToken0Delta = newWalletToken0Balance - walletToken0Balance;
  const walletToken1Delta = newWalletToken1Balance - walletToken1Balance;
  logger.info(`Owner balance change token0: ${formatBalance(token0.address, walletToken0Delta)}`);
  logger.info(`Owner balance change token1: ${formatBalance(token1.address, walletToken1Delta)}`);
  logger.info(`New Owner token0: ${formatBalance(token0.address, newWalletToken0Balance)}`);
  logger.info(`New Owner token1: ${formatBalance(token1.address, newWalletToken1Balance)}`);
  logger.info('✅ Operation successful');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`❌ Error: ${err.message}`, { err });
    process.exit(1);
  })
  .finally(async () => {
    logger.info('Cleaning up resources...');
    await db.destroy();
    await blockchain.cleanup();
  });

// handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  process.exit(1);
});
