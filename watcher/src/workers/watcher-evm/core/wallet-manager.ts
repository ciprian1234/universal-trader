import { ethers } from 'ethers';
import { TokenManager } from '../core/token-manager';
import { Blockchain } from '../core/blockchain';
import { createLogger, type Logger } from '@/utils';
import type { TokenOnChain } from '@/shared/data-model/token';
import type { ChainConfig } from '@/config/models';
import type { PriceOracle } from './price-oracle';

export interface TokenBalance {
  token: TokenOnChain;
  balance: bigint;
  balanceFormatted: string;
  lastUpdated: number;
}

export interface WalletState {
  address: string;
  nativeTokenBalance: bigint;
  lastUpdated: number;
}

export type BalanceChangesType = Record<
  string,
  {
    oldBalance: bigint;
    oldBalanceFormatted: string;
    oldBalanceValueInUSD: string;
    newBalance: bigint;
    newBalanceFormatted: string;
    newBalanceValueInUSD: string;
    diff: bigint;
    diffFormatted: string;
    diffValueInUSD: string;
  }
>;

type WalletManagerInput = {
  chainConfig: ChainConfig;
  blockchain: Blockchain;
  tokenManager: TokenManager;
  priceOracle: PriceOracle;
};

export class WalletManager {
  private readonly logger: Logger;
  private readonly chainConfig: ChainConfig;
  private readonly blockchain: Blockchain;
  private signer: ethers.Wallet;
  private walletState: WalletState;
  private tokenManager: TokenManager;
  private priceOracle: PriceOracle;

  private readonly NATIVE_TOKEN: string;
  private readonly WRAPPED_NATIVE_TOKEN_ADDRESS: string;

  // 💾 IN-MEMORY STORAGE: Token balances by address
  private tokenBalances: Map<string, TokenBalance> = new Map();

  constructor(input: WalletManagerInput) {
    this.logger = createLogger(`[${input.chainConfig.name}.WalletManager]`);
    if (!input.chainConfig.walletPrivateKey) throw new Error('Wallet private key not provided in chain config');

    this.chainConfig = input.chainConfig;
    this.blockchain = input.blockchain;
    this.tokenManager = input.tokenManager;
    this.priceOracle = input.priceOracle;
    this.signer = new ethers.Wallet(input.chainConfig.walletPrivateKey, input.blockchain.getProvider());

    this.NATIVE_TOKEN = this.chainConfig.nativeToken;
    this.WRAPPED_NATIVE_TOKEN_ADDRESS = this.chainConfig.wrappedNativeTokenAddress.toLowerCase();

    // init walletState with default values
    this.walletState = { address: '', nativeTokenBalance: 0n, lastUpdated: Date.now() };
  }

  /**
   * 🔍 VALIDATE WALLET: Check if wallet is valid and accessible
   */
  async initAndValidateWallet() {
    this.logger.info(`🔍 Validating wallet`);
    const address = await this.signer.getAddress();
    const nativeTokenBalance = await this.blockchain.getBalance(address);
    this.walletState = { address, nativeTokenBalance, lastUpdated: Date.now() }; // Update wallet state

    // Check if wallet has min NATIVE TOKEN for transaction
    const minNativeTokenRequired = ethers.parseEther('0.01'); // 0.01 NATIVE TOKEN minimum
    if (process.env.ENABLE_FLASH_ARBITRAGE && nativeTokenBalance < minNativeTokenRequired) {
      throw new Error(
        `Insufficient ${this.NATIVE_TOKEN} balance: ${ethers.formatEther(nativeTokenBalance)} ${this.NATIVE_TOKEN} (minimum: 0.01 ${this.NATIVE_TOKEN})`,
      );
    }

    // Load balances for discovery tokens at startup
    await Promise.all(this.chainConfig.discoveryTokens.map((symbol) => this.loadTokenBalance(symbol)));
    this.logger.info(this.getWalletSummary());
    this.logger.info(`✅ Wallet validated: ${address} (${ethers.formatEther(nativeTokenBalance)} ${this.NATIVE_TOKEN})`);
  }

  /**
   * LOAD TOKEN BALANCE: Get balance for a specified token
   */
  async loadTokenBalance(tokenSymbol: string): Promise<void> {
    // Get token info from token manager
    const token = this.tokenManager.getTokenBySymbol(tokenSymbol);
    if (!token) throw new Error(`Token ${tokenSymbol} not found in token manager`);
    const balance = await this.tokenManager.getTokenBalance(token.address, this.walletState.address);

    const tokenBalance: TokenBalance = {
      token,
      balance,
      balanceFormatted: ethers.formatUnits(balance, token.decimals),
      lastUpdated: Date.now(),
    };

    // Store by token address
    this.tokenBalances.set(token.address, tokenBalance);
  }

  /**
   * 🔄 REFRESH NATIVE TOKEN BALANCE: Update native token balance only
   */
  async refreshNativeTokenBalance(): Promise<void> {
    const nativeTokenBalance = await this.blockchain.getBalance(this.walletState.address);
    this.walletState.nativeTokenBalance = nativeTokenBalance;
    this.walletState.lastUpdated = Date.now();
  }

  /**
   * ⛽ CHECK GAS AFFORDABILITY: Verify wallet can afford gas for transaction
   */
  canAffordGas(totalGasCostWEI: bigint) {
    const canAfford = this.walletState.nativeTokenBalance >= totalGasCostWEI;
    const nativeTokenBalanceBeforeGas = this.walletState.nativeTokenBalance;

    return {
      canAfford,
      nativeTokenBalanceBeforeGas,
      nativeTokenBalanceAfterGas: nativeTokenBalanceBeforeGas - totalGasCostWEI,
    };
  }

  /**
   * 🔄 UPDATE BALANCES AFTER TRANSACTION: Refresh balances and log changes
   */
  async updateBalancesAfterTransaction(involvedTokens: TokenOnChain[]) {
    this.logger.info('🔄 Updating balances after transaction...');

    // Store old balances for comparison
    const oldNativeTokenBalance = this.walletState.nativeTokenBalance;
    const oldTokenBalances = new Map<string, bigint>();

    involvedTokens.forEach((token) => {
      const balance = this.tokenBalances.get(token.address);
      if (balance) oldTokenBalances.set(token.address, balance.balance);
    });

    // refresh native and ERC20 token balances
    const refreshPromises = involvedTokens.map((token) => this.loadTokenBalance(token.symbol)); // Refresh involved token balances
    await Promise.all([this.refreshNativeTokenBalance(), ...refreshPromises]);

    // get balance changes and log them
    const balanceChanges = this.getBalanceChanges(oldNativeTokenBalance, oldTokenBalances, involvedTokens);
    this.displayBalanceChanges(balanceChanges);
    return balanceChanges;
  }

  /**
   * 📋 Get Balance Changes: Compare old and new balances
   */
  private getBalanceChanges(
    oldNativeTokenBalance: bigint,
    oldTokenBalances: Map<string, bigint>,
    involvedTokens: TokenOnChain[],
  ): BalanceChangesType {
    const balanceChanges: BalanceChangesType = {};

    // NATIVE_TOKEN balance change
    const nativeTokenDiff = this.walletState!.nativeTokenBalance - oldNativeTokenBalance;

    balanceChanges[this.NATIVE_TOKEN] = {
      oldBalance: oldNativeTokenBalance,
      oldBalanceFormatted: ethers.formatEther(oldNativeTokenBalance),
      oldBalanceValueInUSD: this.priceOracle
        .calculateUSDValue(this.WRAPPED_NATIVE_TOKEN_ADDRESS, oldNativeTokenBalance)
        .toFixed(4),
      newBalance: this.walletState.nativeTokenBalance,
      newBalanceFormatted: ethers.formatEther(this.walletState.nativeTokenBalance),
      newBalanceValueInUSD: this.priceOracle
        .calculateUSDValue(this.WRAPPED_NATIVE_TOKEN_ADDRESS, this.walletState.nativeTokenBalance)
        .toFixed(4),
      diff: nativeTokenDiff,
      diffFormatted: ethers.formatEther(nativeTokenDiff),
      diffValueInUSD: this.priceOracle.calculateUSDValue(this.WRAPPED_NATIVE_TOKEN_ADDRESS, nativeTokenDiff).toFixed(4),
    };

    // Token balance changes
    involvedTokens.forEach((token) => {
      const oldBalance = oldTokenBalances.get(token.address)!;
      const newBalance = this.tokenBalances.get(token.address)!;

      const diff = newBalance.balance - oldBalance;

      balanceChanges[token.symbol] = {
        oldBalance,
        oldBalanceFormatted: ethers.formatUnits(oldBalance, token.decimals),
        oldBalanceValueInUSD: this.priceOracle.calculateUSDValue(token.address, oldBalance).toFixed(4),
        newBalance: newBalance.balance,
        newBalanceFormatted: newBalance.balanceFormatted,
        newBalanceValueInUSD: this.priceOracle.calculateUSDValue(token.address, newBalance.balance).toFixed(4),
        diff,
        diffFormatted: ethers.formatUnits(diff, token.decimals),
        diffValueInUSD: this.priceOracle.calculateUSDValue(token.address, diff).toFixed(4),
      };
    });

    return balanceChanges;
  }

  /**
   * 📋 LOG BALANCE CHANGES: Compare and log balance differences
   */
  private displayBalanceChanges(balanceChanges: BalanceChangesType) {
    this.logger.info('📊 Wallet balance changes:');
    for (const [symbol, change] of Object.entries(balanceChanges)) {
      const sign = change.diff > 0n ? '+' : ''; // minus sign it's already on formatted string
      this.logger.info(
        `  ${symbol}: ${change.oldBalanceFormatted} → ${change.newBalanceFormatted} (${sign}${change.diffFormatted}) (Value in USD: ${sign}${change.diffValueInUSD})`,
      );
    }
  }

  // ================================================================================================
  // GETTERS
  // ================================================================================================

  /**
   * Get signer
   */
  getSigner(): ethers.Wallet {
    return this.signer;
  }

  /**
   * 🪙 GET NATIVE TOKEN BALANCE
   */
  getNativeTokenBalance() {
    return this.walletState.nativeTokenBalance;
  }
  /**
   * 🪙 GET TOKEN BALANCE: Get balance for specific token by address
   */
  getTokenBalance(tokenAddress: string): TokenBalance | null {
    return this.tokenBalances.get(tokenAddress) || null;
  }

  /**
   * 📊 GET ALL TOKEN BALANCES: Get all tracked token balances
   */
  getAllTokenBalances(): TokenBalance[] {
    return Array.from(this.tokenBalances.values());
  }

  /**
   * 📋 GET WALLET SUMMARY: Get formatted summary
   */
  getWalletSummary(): string {
    const allBalances = this.getAllTokenBalances();
    const nativeTokenBalanceFormatted = ethers.formatEther(this.walletState.nativeTokenBalance);
    const summary = [`Address: ${this.walletState.address}`, `${this.NATIVE_TOKEN}: ${nativeTokenBalanceFormatted}`];

    allBalances.forEach((balance) => summary.push(`${balance.token.symbol}: ${balance.balanceFormatted}`));
    return summary.join('\n');
  }
}
