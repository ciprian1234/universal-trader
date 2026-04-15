import { ethers } from 'ethers';
import { logger } from '@/utils';
import type { TokenOnChain } from '@/shared/data-model/token';
import { appConfig } from '@/config';
import type { ChainConfig } from '@/config/models';

export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

export const WETH_ABI = [...ERC20_ABI, 'function deposit() payable'];

export const chainConfig = appConfig.platforms['ethereum'] as ChainConfig;
export const WETH_ADDRESS = chainConfig.wrappedNativeTokenAddress;

// ========================================================================================
// HELPERS
// ========================================================================================

export function balanceStr(token: TokenOnChain, rawBalance: bigint): string {
  return ethers.formatUnits(rawBalance, token.decimals);
}

export function balanceStrWithSymbol(token: TokenOnChain, rawBalance: bigint): string {
  return `${ethers.formatUnits(rawBalance, token.decimals)} ${token.symbol}`;
}

export function balanceDeltaStr(token: TokenOnChain, oldRawBalance: bigint, newRawBalance: bigint): string {
  const delta = newRawBalance - oldRawBalance;
  const sign = delta >= 0 ? '+' : '';
  return `${balanceStr(token, oldRawBalance)} -> ${balanceStr(token, newRawBalance)} (${sign}${balanceStr(token, delta)}) ${token.symbol}`;
}

export async function fundContract(token: TokenOnChain, to: string, amountInString: string, signer: any): Promise<bigint> {
  let tx: any;

  // ETH
  if (token.address === ethers.ZeroAddress) {
    const amount = ethers.parseEther(amountInString);
    tx = await signer.sendTransaction({ to, value: amount }); // do not send ETH anymore
    await tx.wait();
    logger.info(`📤 Contract funded with ${ethers.formatEther(amount)} ETH`);
    return amount;
  } else {
    // if WETH => WRAP
    if (token.address === WETH_ADDRESS) await wrapETH(signer, ethers.parseEther(amountInString));

    // transfer ERC20 token to contract
    const amount = ethers.parseUnits(amountInString, token.decimals);
    const tokenContract = new ethers.Contract(token.address, WETH_ABI, signer);
    tx = await tokenContract.transfer(to, amount);

    await tx.wait();
    logger.info(`📤 Contract funded with ${ethers.formatUnits(amount, token.decimals)} ${token.symbol}`);
    return amount;
  }
}

// WRAP/UNWRAP helpers
export async function wrapETH(signer: any, amount: bigint) {
  const wethContract = new ethers.Contract(WETH_ADDRESS, WETH_ABI, signer);
  logger.info(`\n💰 Wrapping ${ethers.formatEther(amount)} ETH to WETH...`);
  await (await wethContract.deposit({ value: amount })).wait();
  logger.info(`✅ Wrapped ${ethers.formatEther(amount)} WETH`);
}

export async function unwrapWETH(signer: any, amount: bigint) {
  const wethContract = new ethers.Contract(WETH_ADDRESS, WETH_ABI, signer);
  logger.info(`\n💰 Unwrapping ${ethers.formatEther(amount)} WETH to ETH...`);
  await (await wethContract.withdraw(amount)).wait();
  logger.info(`✅ Unwrapped ${ethers.formatEther(amount)} ETH`);
}
