import type { DexPoolState } from '@/shared/data-model/layer1';
import { logger } from '@/utils';
import { FlashArbitrageHandler } from '@/core/flash-arbitrage-handler';
import { type SwapStepOnContract } from '@/core/flash-arbitrage-handler/flash-arbitrage-config';
import { FLASH_ARBITRAGE_ABI } from '@/core/flash-arbitrage-handler/flash-arbitrage-contract-abi';
import { ethers } from 'ethers';
import { chainConfig, balanceStrWithSymbol, fundContract, WETH_ADDRESS, balanceDeltaStr } from './helpers';
import { CacheService } from '@/utils/cache-service';
import { WorkerDb } from '@/db';
import { EventBus } from '@/core/event-bus';
import { Blockchain } from '@/core/blockchain';
import { TokenManager } from '@/core/token-manager';

// ========================================================================================
// CONFIG — edit these for the swap you want to test
// ========================================================================================

// NOTE: those are safe to commit => from hardhat default hardhat.accounts(1)
const CONTRACT_ADDRESS = '0x147f6149c42481Ec43CF893DA581ACBCeBB89068';
const WALLET_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // (hardhat[1].privateKey)

if (!CONTRACT_ADDRESS) throw new Error('CONTRACT_ADDRESS not set in config');
if (!WALLET_PRIVATE_KEY) throw new Error('WALLET_PRIVATE_KEY not set in config');

// ========================================================================================
// Some common pools to test with (uncomment the one you want to test)
const DB_POOL_ID = '1:0xe0554a476a092703abdb3ef35c80e0d76d32939f'; // uniswap v3 USDC:WETH(100bps)
// const DB_POOL_ID = '1:0xc7bbec68d12a0d1830360f8ec58fa599ba1b0e9b'; // uniswap v3 WETH:USDT(100bps)
// ========================================================================================

// input pool from DB
// const DB_POOL_ID = '1:0x00b9edc1583bf6ef09ff3a09f6c23ecb57fd7d0bb75625717ec81eed181e22d7';
const ZERO_FOR_ONE = false;
const amountInFormatted = '1'; // human readable amount to swap
const amountOutMinFormatted = '0'; // human readable minimum amount to receive

// ========================================================================================
// COMPONENT INITIALIZATION
// ========================================================================================
chainConfig.providerRpcUrl = 'ws://127.0.0.1:8545';

const cache = new CacheService(chainConfig.chainId);
const db = new WorkerDb(chainConfig.databaseUrl, chainConfig.chainId);
const eventBus = new EventBus();

// Core app services
const blockchain = new Blockchain({ chainConfig, cache, eventBus });
const tokenManager = new TokenManager({ chainConfig, blockchain, eventBus, db });

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

  return {
    dexProtocol: FlashArbitrageHandler.getDexTypeEnumValueFromPool(pool.protocol),
    poolTokens: [pool.tokenPair.token0.address, pool.tokenPair.token1.address],
    poolAddress: pool.address,
    tokenIn,
    tokenOut,
    amountSpecified: 0n, // computed by contract by amount sent to contract
    amountOutMin: params.amountOutMin,
    poolFee: pool.feeBps,
    extraData: pool.protocol === 'v4' ? abiCoder.encode(['address', 'int24'], [token0.address, pool.tickSpacing]) : '0x',
  };
}

// ========================================================================================
// MAIN
// ========================================================================================
async function main() {
  await tokenManager.init(); // load tokens from DB and trusted tokens from coingecho
  const ethToken = tokenManager.getToken(ethers.ZeroAddress)!;
  const wethToken = tokenManager.getToken(WETH_ADDRESS)!;

  const pools = await db.loadAllPools();
  const storedPool = pools.find((p) => p.id === DB_POOL_ID);
  if (!storedPool) throw new Error(`Pool with id ${DB_POOL_ID} not found in database`);
  const pool = storedPool.state;

  logger.info(`🔍 Loaded pool from DB: ${pool.venue.name} ${pool.tokenPair.key} fee ${pool.feeBps}bps`);
  const t0 = await tokenManager.ensureTokenRegistered(pool.tokenPair.token0.address, 'address');
  const t1 = await tokenManager.ensureTokenRegistered(pool.tokenPair.token1.address, 'address');

  const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, blockchain.getProvider());
  const walletAddress = await wallet.getAddress();
  const walletEthBalance = await tokenManager.getTokenBalance(ethers.ZeroAddress, walletAddress);
  const walletWethBalance = await tokenManager.getTokenBalance(WETH_ADDRESS, walletAddress);
  logger.info(`👤 Wallet: ${walletAddress}`);
  logger.info(`👤 Wallet ${balanceStrWithSymbol(ethToken, walletEthBalance)}`);
  logger.info(`👤 Wallet ${balanceStrWithSymbol(wethToken, walletWethBalance)}`);

  const walletToken0Balance = await tokenManager.getTokenBalance(t0.address, walletAddress);
  const walletToken1Balance = await tokenManager.getTokenBalance(t1.address, walletAddress);
  logger.info(`Owner token0: ${balanceStrWithSymbol(t0, walletToken0Balance)}`);
  logger.info(`Owner token1: ${balanceStrWithSymbol(t1, walletToken1Balance)}`);

  const arbitrageContract = new ethers.Contract(CONTRACT_ADDRESS, FLASH_ARBITRAGE_ABI, wallet);
  const contractOwner = await arbitrageContract.owner();
  if (walletAddress.toLowerCase() !== contractOwner.toLowerCase()) throw new Error('Signer is not the contract owner');
  logger.info(`🏦 Arbitrage contract at ${CONTRACT_ADDRESS}, owner: ${contractOwner}`);

  // log what we are about to do
  const swapMsg = ZERO_FOR_ONE ? `${t0.symbol} -> ${t1.symbol}` : `${t1.symbol} -> ${t0.symbol}`;
  logger.info(`🚀 Executing direct swap on ${pool.venue.name} ${swapMsg}`);

  // Fund the contract with token0 or token1 (WETH in this case)
  const amountFunded = await fundContract(ZERO_FOR_ONE ? t0 : t1, CONTRACT_ADDRESS, amountInFormatted, wallet);

  // Build the swap step
  const step = buildSwapStep({
    pool,
    zeroForOne: ZERO_FOR_ONE,
    amountIn: amountFunded,
    // amountOutMin: 0n, // set to 0 for testing — we will validate the actual output after the swap
    amountOutMin: ethers.parseUnits(amountOutMinFormatted, ZERO_FOR_ONE ? t1.decimals : t0.decimals), // set to human readable minimum amount to receive
  });

  try {
    // Execute
    // logger.info('🔄 Calling executeDirectSwap...', { step });
    const staticCallResult = await arbitrageContract.executeDirectSwap.staticCall(step);
    logger.info('Static call result (amountOut):', { staticCallResult });

    const tx = await arbitrageContract.executeDirectSwap(step);
    const receipt = await tx.wait();
    logger.info(`✅ Tx confirmed — block: ${receipt.blockNumber}, gas used: ${receipt.gasUsed}`);

    // ========================================================================================
    // SWAP EXECUTED, LOG RESULTS
    // ========================================================================================
    logger.info(`💸 Withdrawing ${ZERO_FOR_ONE ? t1.symbol : t0.symbol} to owner...`);
    await (await arbitrageContract.emergencyWithdraw(ZERO_FOR_ONE ? t1.address : t0.address)).wait();
    // await (await arbitrageContract.emergencyWithdraw(ethers.ZeroAddress)).wait(); // clear any leftover ETH (from unwrapping WETH if tokenOut was WETH)
    // await (await arbitrageContract.emergencyWithdraw(WETH_ADDRESS)).wait(); // clear any leftover WETH (from wrapping ETH if tokenIn was ETH)
    const newWalletToken0Balance = await tokenManager.getTokenBalance(t0.address, walletAddress);
    const newWalletToken1Balance = await tokenManager.getTokenBalance(t1.address, walletAddress);

    // log wallet delta
    logger.info(`Owner Token0: ${balanceDeltaStr(t0, walletToken0Balance, newWalletToken0Balance)}`);
    logger.info(`Owner Token1: ${balanceDeltaStr(t1, walletToken1Balance, newWalletToken1Balance)}`);
  } catch (error) {
    logger.error('Swap error', { error: error });

    // withdraw sent funds back to owner in case of error to avoid locking funds in the contract
    logger.info('Withdrawing funds back to owner due to error...');
    await (await arbitrageContract.emergencyWithdraw(ZERO_FOR_ONE ? t0.address : t1.address)).wait();
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
