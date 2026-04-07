import type { DexPoolState } from '@/shared/data-model/layer1';
import { logger } from '@/utils';
import { FlashArbitrageHandler } from '@/workers/watcher-evm/core/flash-arbitrage-handler';
import { type SwapStepOnContract } from '@/workers/watcher-evm/core/flash-arbitrage-handler/flash-arbitrage-config';
import { FLASH_ARBITRAGE_ABI } from '@/workers/watcher-evm/core/flash-arbitrage-handler/flash-arbitrage-contract-abi';
import { ethers } from 'ethers';
import { blockchain, db, tokenManager, WETH_ADDRESS } from './helpers/initialize';
import { formatBalance, fundContract } from './helpers';

// ========================================================================================
// CONFIG — edit these for the swap you want to test
// ========================================================================================

// NOTE: those are safe to commit => from hardhat default hardhat.accounts(1)
const CONTRACT_ADDRESS = '0x8b4D4A6fFebDd4028cF0E59d43a3423f7F8d7CC1';
const WALLET_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // (hardhat[1].privateKey)

if (!CONTRACT_ADDRESS) throw new Error('CONTRACT_ADDRESS not set in config');
if (!WALLET_PRIVATE_KEY) throw new Error('WALLET_PRIVATE_KEY not set in config');

// input pool from DB
const DB_POOL_ID = '1:0x00b9edc1583bf6ef09ff3a09f6c23ecb57fd7d0bb75625717ec81eed181e22d7';
const ZERO_FOR_ONE = true;
const amountInFormatted = '0.0001'; // human readable amount to swap
const amountOutMinFormatted = '0'; // human readable minimum amount to receive

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

  const pools = await db.loadAllPools();
  const storedPool = pools.find((p) => p.id === DB_POOL_ID);
  if (!storedPool) throw new Error(`Pool with id ${DB_POOL_ID} not found in database`);
  const pool = storedPool.state;
  const t0Addr = pool.tokenPair.token0.address;
  const t1Addr = pool.tokenPair.token1.address;

  logger.info(`🔍 Loaded pool from DB: ${pool.venue.name} ${pool.tokenPair.key} fee ${pool.feeBps}bps`);
  const t0 = await tokenManager.ensureTokenRegistered(t0Addr, 'address');
  const t1 = await tokenManager.ensureTokenRegistered(t1Addr, 'address');

  const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, blockchain.getProvider());
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

  // log what we are about to do
  const swapMsg = ZERO_FOR_ONE ? `${t0.symbol} -> ${t1.symbol}` : `${t1.symbol} -> ${t0.symbol}`;
  logger.info(`🚀 Executing direct swap on ${pool.venue.name} ${swapMsg}`);

  // Fund the contract with token0 or token1 (WETH in this case)
  const amountFunded = await fundContract(CONTRACT_ADDRESS, wallet, ZERO_FOR_ONE ? t0Addr : t1Addr, amountInFormatted);

  // Balances before
  // logger.info('📊 Balances BEFORE swap:');
  // const contractEthBalance = await tokenManager.getTokenBalance(ethers.ZeroAddress, CONTRACT_ADDRESS);
  // const token0Before = await tokenManager.getTokenBalance(t0Addr, CONTRACT_ADDRESS);
  // const token1Before = await tokenManager.getTokenBalance(t1Addr, CONTRACT_ADDRESS);
  // logger.info(`Contract: ${formatBalance(ethers.ZeroAddress, contractEthBalance)}`);
  // logger.info(`Contract token0: ${formatBalance(t0Addr, token0Before)}`);
  // logger.info(`Contract token1: ${formatBalance(t1Addr, token1Before)}`);

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
  } catch (error) {
    logger.error('Swap error', { error: error });

    // withdraw sent funds back to owner in case of error to avoid locking funds in the contract
    logger.info('Withdrawing funds back to owner due to error...');
    await (await arbitrageContract.emergencyWithdraw(ZERO_FOR_ONE ? t0Addr : t1Addr)).wait();
    process.exit(1);
  }

  // ========================================================================================
  // VALIDATION
  // ========================================================================================
  // logger.info('🔍 Balances AFTER swap:');
  // const contractEthBalanceAfter = await tokenManager.getTokenBalance(ethers.ZeroAddress, CONTRACT_ADDRESS);
  // const token0After = await tokenManager.getTokenBalance(t0Addr, CONTRACT_ADDRESS);
  // const token1After = await tokenManager.getTokenBalance(t1Addr, CONTRACT_ADDRESS);
  // const token0Delta = token0After - token0Before;
  // const token1Delta = token1After - token1Before;
  // logger.info(`Contract: ${formatBalance(ethers.ZeroAddress, contractEthBalanceAfter)}`);
  // logger.info(`Contract token0: ${formatBalance(t0Addr, token0After)}`);
  // logger.info(`Contract token1: ${formatBalance(t1Addr, token1After)}`);
  // logger.info(`Delta: ${formatBalance(ethers.ZeroAddress, contractEthBalanceAfter - contractEthBalance)}`);
  // logger.info(`Delta token0: ${formatBalance(t0Addr, token0Delta)}`);
  // logger.info(`Delta token1: ${formatBalance(t1Addr, token1Delta)}`);

  // Withdraw result back to owner
  logger.info(`💸 Withdrawing ${ZERO_FOR_ONE ? t1.symbol : t0.symbol} to owner...`);
  await (await arbitrageContract.emergencyWithdraw(ZERO_FOR_ONE ? t1Addr : t0Addr)).wait();
  // await (await arbitrageContract.emergencyWithdraw(ethers.ZeroAddress)).wait(); // clear any leftover ETH (from unwrapping WETH if tokenOut was WETH)
  // await (await arbitrageContract.emergencyWithdraw(WETH_ADDRESS)).wait(); // clear any leftover WETH (from wrapping ETH if tokenIn was ETH)
  const newWalletToken0Balance = await tokenManager.getTokenBalance(t0Addr, walletAddress);
  const newWalletToken1Balance = await tokenManager.getTokenBalance(t1Addr, walletAddress);

  // log wallet delta
  const walletToken0Delta = newWalletToken0Balance - walletToken0Balance;
  const walletToken1Delta = newWalletToken1Balance - walletToken1Balance;
  logger.info(`Owner balance change token0: ${formatBalance(t0Addr, walletToken0Delta)}`);
  logger.info(`Owner balance change token1: ${formatBalance(t1Addr, walletToken1Delta)}`);
  logger.info(`New Owner token0: ${formatBalance(t0Addr, newWalletToken0Balance)}`);
  logger.info(`New Owner token1: ${formatBalance(t1Addr, newWalletToken1Balance)}`);
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
