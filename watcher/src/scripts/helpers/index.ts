import { ethers } from 'ethers';
import { logger } from '@/utils';
import { tokenManager, WETH_ABI, WETH_ADDRESS } from './initialize';

// ========================================================================================
// HELPERS
// ========================================================================================

export function formatBalance(tokenAddress: string, rawBalance: bigint) {
  const { symbol, decimals } = tokenManager.getToken(tokenAddress)!;
  return `${symbol}: ${ethers.formatUnits(rawBalance, decimals)}`;
}

export async function fundContract(to: string, signer: any, tokenAddr: string, amountInString: string): Promise<bigint> {
  let tx: any;

  // ETH
  if (tokenAddr === ethers.ZeroAddress) {
    const amount = ethers.parseEther(amountInString);
    tx = await signer.sendTransaction({ to, value: amount }); // do not send ETH anymore
    await tx.wait();
    logger.info(`📤 Contract funded with ${ethers.formatEther(amount)} ETH`);
    return amount;
  } else {
    // if WETH => WRAP
    if (tokenAddr === WETH_ADDRESS) await wrapETH(signer, ethers.parseEther(amountInString));

    // transfer ERC20 token to contract
    const token = await tokenManager.ensureTokenRegistered(tokenAddr, 'address');
    const amount = ethers.parseUnits(amountInString, token.decimals);
    const tokenContract = new ethers.Contract(tokenAddr, WETH_ABI, signer);
    tx = await tokenContract.transfer(to, amount);

    await tx.wait();
    logger.info(`📤 Contract funded with ${ethers.formatUnits(amount, token.decimals)} ${token.symbol}`);
    return amount;
  }
}

// WRAP/UNWRAP helpers
export async function wrapETH(signer: any, amount: bigint) {
  const wethAddress = tokenManager.getTokenBySymbol('WETH')?.address;
  if (!wethAddress) throw new Error('WETH token not found in token manager');
  const wethContract = new ethers.Contract(wethAddress, WETH_ABI, signer);
  logger.info(`\n💰 Wrapping ${ethers.formatEther(amount)} ETH to WETH...`);
  await (await wethContract.deposit({ value: amount })).wait();
  logger.info(`✅ Wrapped ${ethers.formatEther(amount)} WETH`);
}

export async function unwrapWETH(signer: any, amount: bigint) {
  const wethAddress = tokenManager.getTokenBySymbol('WETH')?.address;
  if (!wethAddress) throw new Error('WETH token not found in token manager');
  const wethContract = new ethers.Contract(wethAddress, WETH_ABI, signer);
  logger.info(`\n💰 Unwrapping ${ethers.formatEther(amount)} WETH to ETH...`);
  await (await wethContract.withdraw(amount)).wait();
  logger.info(`✅ Unwrapped ${ethers.formatEther(amount)} ETH`);
}
