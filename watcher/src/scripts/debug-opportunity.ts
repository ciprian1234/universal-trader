import { appConfig } from '@/config';
import type { ChainConfig } from '@/config/models';
import { logger } from '@/utils';
import { ethers } from 'ethers';
import { formatBalance } from './helpers';
import { FLASH_ARBITRAGE_ABI } from '@/workers/watcher-evm/core/flash-arbitrage-handler/flash-arbitrage-contract-abi';
import { blockchain, db, tokenManager } from './helpers/initialize';

// ========================================================================================
// CONFIG — edit these for the swap you want to test
// ========================================================================================

const chainConfig = appConfig.platforms['ethereum'] as ChainConfig;

// NOTE: those are safe to commit => from hardhat default accounts(0)
const CONTRACT_ADDRESS = '0x9DE1E23445685a4fcF18CfF491ADad76A806c54d';
const WALLET_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // (hardhat[0].privateKey)
const WETH_ADDRESS = chainConfig.wrappedNativeTokenAddress;

if (!CONTRACT_ADDRESS) throw new Error('CONTRACT_ADDRESS not set in config');
if (!WALLET_PRIVATE_KEY) throw new Error('WALLET_PRIVATE_KEY not set in config');

// input pool from DB
const DB_OPPORTUNITY_ID = '1775451709543@uniswap-v2(30)[USDT->REACT]___uniswap-v3(3000)[REACT->USDT]';

// ========================================================================================
// MAIN
// ========================================================================================
async function main() {
  await tokenManager.init(); // load tokens from DB and trusted tokens from coingecho

  const opportunity = await db.getArbitrageOpportunityById(DB_OPPORTUNITY_ID);
  logger.info(`🔍 Loaded opportunity from DB: ${opportunity.id} with profit ${opportunity.grossProfitUSD} USD`);
  logger.info('Opportunity data', { opportunity });
  // const pool = storedPool.state;
  // const t0Addr = pool.tokenPair.token0.address;
  // const t1Addr = pool.tokenPair.token1.address;

  // logger.info(`🔍 Loaded pool from DB: ${pool.venue.name} ${pool.tokenPair.key} fee ${pool.feeBps}bps`);
  // const t0 = await tokenManager.ensureTokenRegistered(t0Addr, 'address');
  // const t1 = await tokenManager.ensureTokenRegistered(t1Addr, 'address');

  const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, blockchain.getProvider());
  const walletAddress = await wallet.getAddress();
  const walletEthBalance = await tokenManager.getTokenBalance(ethers.ZeroAddress, walletAddress);
  const walletWethBalance = await tokenManager.getTokenBalance(WETH_ADDRESS, walletAddress);
  logger.info(`👤 Wallet: ${walletAddress}`);
  logger.info(`👤 Wallet ${formatBalance(ethers.ZeroAddress, walletEthBalance)}`);
  logger.info(`👤 Wallet ${formatBalance(WETH_ADDRESS, walletWethBalance)}`);

  const arbitrageContract = new ethers.Contract(CONTRACT_ADDRESS, FLASH_ARBITRAGE_ABI, wallet);
  const contractOwner = await arbitrageContract.owner();
  if (walletAddress.toLowerCase() !== contractOwner.toLowerCase()) throw new Error('Signer is not the contract owner');
  logger.info(`🏦 Arbitrage contract at ${CONTRACT_ADDRESS}, owner: ${contractOwner}`);

  // try {
  //   // Execute
  //   // logger.info('🔄 Calling executeDirectSwap...', { step });
  //   const staticCallResult = await arbitrageContract.executeDirectSwap.staticCall(step);
  //   logger.info('Static call result (amountOut):', { staticCallResult });

  //   const tx = await arbitrageContract.executeDirectSwap(step);
  //   const receipt = await tx.wait();
  //   logger.info(`✅ Tx confirmed — block: ${receipt.blockNumber}, gas used: ${receipt.gasUsed}`);
  // } catch (error) {
  //   logger.error('Swap error', { error: error });

  //   // withdraw sent funds back to owner in case of error to avoid locking funds in the contract
  //   logger.info('Withdrawing funds back to owner due to error...');
  //   await (await arbitrageContract.emergencyWithdraw(ZERO_FOR_ONE ? t0Addr : t1Addr)).wait();
  //   process.exit(1);
  // }
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
