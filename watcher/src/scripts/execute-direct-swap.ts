import { appConfig } from '@/config';
import type { ChainConfig } from '@/config/models';
import type { DexPoolState } from '@/shared/data-model/layer1';
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
const DB_POOL_ID = '1:0x00b9edc1583bf6ef09ff3a09f6c23ecb57fd7d0bb75625717ec81eed181e22d7';
const ZERO_FOR_ONE = true;
const amountInFormatted = '0.01'; // human readable amount to swap

// WRAP ETH if needed
let WRAP_ETH_AMOUNT: string | null = null;
// WRAP_ETH_AMOUNT = '10';

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
const WETH_ADDRESS = chainConfig.wrappedNativeTokenAddress;

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

  const abiCoder = new ethers.AbiCoder();

  let tokenIn = params.zeroForOne ? token0.address : token1.address;
  let tokenOut = params.zeroForOne ? token1.address : token0.address;

  tokenIn = tokenIn === ethers.ZeroAddress ? WETH_ADDRESS : tokenIn;
  tokenOut = tokenOut === ethers.ZeroAddress ? WETH_ADDRESS : tokenOut;

  // if (tokenIn === ethers.ZeroAddress)
  return {
    dexProtocol: FlashArbitrageHandler.getDexTypeEnumValueFromPool(pool.protocol),
    poolAddress: pool.address,
    tokenIn,
    tokenOut,
    feeBps: pool.feeBps,
    amountIn: params.amountIn,
    amountOutMin: params.amountOutMin,
    zeroForOne: params.zeroForOne,
    extraData:
      pool.protocol === 'v4'
        ? abiCoder.encode(
            ['address', 'address', 'address', 'int24'],
            [token0.address, token1.address, pool.hooks, pool.tickSpacing],
          )
        : '0x',
  };
}

// ========================================================================================
// HELPERS
// ========================================================================================

function formatBalance(tokenAddress: string, rawBalance: bigint) {
  const { symbol, decimals } = tokenManager.getToken(tokenAddress)!;
  return `${symbol}: ${ethers.formatUnits(rawBalance, decimals)}`;
}

async function fundContract(signer: any, tokenAddr: string, amountInString: string): Promise<bigint> {
  let tx: any;

  // If token is ETH => send always WETH instead of ETH
  if (tokenAddr === ethers.ZeroAddress) {
    // tx = await signer.sendTransaction({ to: CONTRACT_ADDRESS, value: amount }); // do not send ETH anymore
    tokenAddr = WETH_ADDRESS;
  }

  const token = await tokenManager.ensureTokenRegistered(tokenAddr, 'address');
  const amount = ethers.parseUnits(amountInString, token.decimals);
  const tokenContract = new ethers.Contract(tokenAddr, WETH_ABI, signer);
  tx = await tokenContract.transfer(CONTRACT_ADDRESS, amount);

  await tx.wait();
  logger.info(`📤 Contract funded with ${ethers.formatUnits(amount, token.decimals)} ${token.symbol}`);
  return amount;
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
  // const { token0, token1 } = pool.tokenPair;
  const t0Addr = pool.tokenPair.token0.address === ethers.ZeroAddress ? WETH_ADDRESS : pool.tokenPair.token0.address;
  const t1Addr = pool.tokenPair.token1.address === ethers.ZeroAddress ? WETH_ADDRESS : pool.tokenPair.token1.address;

  logger.info(`🔍 Loaded pool from DB: ${pool.venue.name} ${pool.tokenPair.key} fee ${pool.feeBps}bps`);
  const t0 = await tokenManager.ensureTokenRegistered(t0Addr, 'address');
  const t1 = await tokenManager.ensureTokenRegistered(t1Addr, 'address');

  const wallet = new ethers.Wallet(chainConfig.walletPrivateKey, blockchain.getProvider());
  const walletAddress = await wallet.getAddress();
  const walletEthBalance = await tokenManager.getTokenBalance(ethers.ZeroAddress, walletAddress);
  const walletWethBalance = await tokenManager.getTokenBalance(WETH_ADDRESS, walletAddress);
  logger.info(`👤 Wallet: ${walletAddress}`);
  logger.info(`👤 Wallet ${formatBalance(ethers.ZeroAddress, walletEthBalance)}`);
  logger.info(`👤 Wallet ${formatBalance(WETH_ADDRESS, walletWethBalance)}`);

  const walletToken0Balance = await tokenManager.getTokenBalance(t0Addr, walletAddress);
  const walletToken1Balance = await tokenManager.getTokenBalance(t1Addr, walletAddress);
  logger.info(`Owner token0: ${formatBalance(t0Addr, walletToken0Balance)}`);
  logger.info(`Owner token1: ${formatBalance(t1Addr, walletToken1Balance)}`);

  const arbitrageContract = new ethers.Contract(CONTRACT_ADDRESS, FLASH_ARBITRAGE_ABI, wallet);
  const contractOwner = await arbitrageContract.owner();
  if (walletAddress.toLowerCase() !== contractOwner.toLowerCase()) throw new Error('Signer is not the contract owner');
  logger.info(`🏦 Arbitrage contract at ${CONTRACT_ADDRESS}, owner: ${contractOwner}`);

  // wrap ETH to WETH if needed
  if (WRAP_ETH_AMOUNT) await wrapETH(wallet, ethers.parseEther(WRAP_ETH_AMOUNT));

  // log what we are about to do
  const swapMsg = ZERO_FOR_ONE ? `${t0.symbol} -> ${t1.symbol}` : `${t1.symbol} -> ${t0.symbol}`;
  logger.info(`🚀 Executing direct swap on ${pool.venue.name} ${swapMsg}`);

  // Fund the contract with token0 or token1 (WETH in this case)
  const amountFunded = await fundContract(wallet, ZERO_FOR_ONE ? t0Addr : t1Addr, amountInFormatted);

  // Balances before
  // logger.info('📊 Balances BEFORE swap:');
  // const token0Before = await tokenManager.getTokenBalance(t0Addr, CONTRACT_ADDRESS);
  // const token1Before = await tokenManager.getTokenBalance(t1Addr, CONTRACT_ADDRESS);
  // logger.info(`Contract token0: ${formatBalance(t0Addr, token0Before)}`);
  // logger.info(`Contract token1: ${formatBalance(t1Addr, token1Before)}`);

  // Build the swap step
  const step = buildSwapStep({
    pool,
    zeroForOne: ZERO_FOR_ONE,
    amountIn: amountFunded,
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
  // const token0After = await tokenManager.getTokenBalance(t0Addr, CONTRACT_ADDRESS);
  // const token1After = await tokenManager.getTokenBalance(t1Addr, CONTRACT_ADDRESS);
  // const token0Delta = token0After - token0Before;
  // const token1Delta = token1After - token1Before;
  // logger.info(`Delta token0: ${formatBalance(t0Addr, token0Delta)}`);
  // logger.info(`Delta token1: ${formatBalance(t1Addr, token1Delta)}`);

  // Withdraw result back to owner
  logger.info(`💸 Withdrawing ${ZERO_FOR_ONE ? t1.symbol : t0.symbol} to owner...`);
  await (await arbitrageContract.emergencyWithdraw(ZERO_FOR_ONE ? t1Addr : t0Addr)).wait();
  const newWalletToken0Balance = await tokenManager.getTokenBalance(t0Addr, walletAddress);
  const newWalletToken1Balance = await tokenManager.getTokenBalance(t1Addr, walletAddress);

  // log wallet delta
  const walletToken0Delta = newWalletToken0Balance - walletToken0Balance;
  const walletToken1Delta = newWalletToken1Balance - walletToken1Balance;
  logger.info(`Owner balance change token0: ${formatBalance(t0Addr, walletToken0Delta)}`);
  logger.info(`Owner balance change token1: ${formatBalance(t1Addr, walletToken1Delta)}`);
  logger.info(`New Owner token0: ${formatBalance(t0Addr, newWalletToken0Balance)}`);
  logger.info(`New Owner token1: ${formatBalance(t1Addr, newWalletToken1Balance)}`);
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
