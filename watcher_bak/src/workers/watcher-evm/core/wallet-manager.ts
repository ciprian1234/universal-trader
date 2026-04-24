import { ethers } from 'ethers';
import { TokenManager } from './token-manager';
import { Blockchain } from './blockchain';
import { createLogger, type Logger } from '@/utils';
import type { ChainConfig } from '@/config/models';
import type { PriceOracle } from './price-oracle';

export interface WalletState {
  address: string;
  nonce: number;
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

  // 💾 IN-MEMORY STORAGE: Token balances by address
  private tokenBalances: Map<string, bigint> = new Map();

  constructor(input: WalletManagerInput) {
    this.logger = createLogger(`[${input.chainConfig.name}.WalletManager]`);
    if (!input.chainConfig.walletPrivateKey) throw new Error('Wallet private key not provided in chain config');

    this.chainConfig = input.chainConfig;
    this.blockchain = input.blockchain;
    this.tokenManager = input.tokenManager;
    this.priceOracle = input.priceOracle;
    this.signer = new ethers.Wallet(input.chainConfig.walletPrivateKey, input.blockchain.getProvider());

    this.NATIVE_TOKEN = this.chainConfig.nativeToken;

    // init walletState with default values
    this.walletState = { address: '', nativeTokenBalance: 0n, lastUpdated: Date.now(), nonce: 0 };
  }

  /**
   * 🔍 VALIDATE WALLET: Check if wallet is valid and accessible
   */
  async initAndValidateWallet() {
    this.logger.info(`🔍 Validating wallet`);
    const address = await this.signer.getAddress();
    const nativeTokenBalance = await this.blockchain.getBalance(address);
    const nonce = await this.signer.getNonce();
    this.walletState = { address, nativeTokenBalance, lastUpdated: Date.now(), nonce }; // Update wallet state

    // Check if wallet has min NATIVE TOKEN for transaction
    const minNativeTokenRequired = ethers.parseEther('0.01'); // 0.01 NATIVE TOKEN minimum
    if (process.env.ENABLE_FLASH_ARBITRAGE && nativeTokenBalance < minNativeTokenRequired) {
      throw new Error(
        `Insufficient ${this.NATIVE_TOKEN} balance: ${ethers.formatEther(nativeTokenBalance)} ${this.NATIVE_TOKEN} (minimum: 0.01 ${this.NATIVE_TOKEN})`,
      );
    }

    // Load balances for discovery tokens at startup
    await Promise.all(
      this.chainConfig.discoveryTokens.map((symbol) => {
        const token = this.tokenManager.getTokenBySymbol(symbol);
        if (!token) throw new Error(`Discovery token ${symbol} not found in token manager, skipping balance load`);
        this.loadTokenBalance(token.address);
      }),
    );
    this.logger.info(`👤 Wallet ${this.getWalletSummary()}`);
  }

  /**
   * LOAD TOKEN BALANCE: Get balance for a specified token
   */
  async loadTokenBalance(tokenAddress: string): Promise<void> {
    const balance = await this.tokenManager.getTokenBalance(tokenAddress, this.walletState.address);
    this.tokenBalances.set(tokenAddress, balance); // Store by token address
  }

  /**
   * 🔄 REFRESH WALLET STATE: Update native token balance and nonce
   */
  async refreshWalletState(): Promise<void> {
    const [nativeTokenBalance, nonce] = await Promise.all([
      this.blockchain.getBalance(this.walletState.address),
      this.signer.getNonce(),
    ]);
    this.walletState.nativeTokenBalance = nativeTokenBalance;
    this.walletState.nonce = nonce;
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
  async updateBalancesAfterTransaction(involvedTokens: string[]) {
    this.logger.info('🔄 Updating balances after transaction...');

    // get new wallet nonce
    const nonce = await this.signer.getNonce();
    this.walletState.nonce = nonce;
    this.logger.info(`Updated wallet nonce: ${nonce}`);

    // Store old balances for comparison
    const oldNativeTokenBalance = this.walletState.nativeTokenBalance;
    const oldTokenBalances = new Map<string, bigint>();
    involvedTokens.forEach((addr) => oldTokenBalances.set(addr, this.tokenBalances.get(addr) ?? 0n));

    // refresh native and ERC20 token balances
    const refreshPromises = involvedTokens.map((addr) => this.loadTokenBalance(addr)); // Refresh involved token balances
    await Promise.all([this.refreshWalletState(), ...refreshPromises]);

    // get new balances after refresh
    const newNativeTokenBalance = this.walletState.nativeTokenBalance;
    const newTokenBalances = new Map<string, bigint>();
    involvedTokens.forEach((addr) => newTokenBalances.set(addr, this.tokenBalances.get(addr) ?? 0n));

    // get balance changes and log them
    const balanceChanges = this.getBalanceChanges({
      oldNativeTokenBalance,
      newNativeTokenBalance,
      oldTokenBalances,
      newTokenBalances,
      involvedTokens,
    });
    this.displayBalanceChanges(balanceChanges);
    return balanceChanges;
  }

  /**
   * 📋 Get Balance Changes: Compare old and new balances
   */
  private getBalanceChanges(input: {
    oldNativeTokenBalance: bigint;
    newNativeTokenBalance: bigint;
    oldTokenBalances: Map<string, bigint>;
    newTokenBalances: Map<string, bigint>;
    involvedTokens: string[];
  }): BalanceChangesType {
    const { oldNativeTokenBalance, newNativeTokenBalance, oldTokenBalances, newTokenBalances, involvedTokens } = input;

    const balanceChanges: BalanceChangesType = {};

    // NATIVE_TOKEN balance change
    const nativeTokenDiff = newNativeTokenBalance - oldNativeTokenBalance;

    balanceChanges[this.NATIVE_TOKEN] = {
      oldBalance: oldNativeTokenBalance,
      oldBalanceFormatted: ethers.formatEther(oldNativeTokenBalance),
      oldBalanceValueInUSD: this.priceOracle.calculateUSDValue(ethers.ZeroAddress, oldNativeTokenBalance).toFixed(4),
      newBalance: newNativeTokenBalance,
      newBalanceFormatted: ethers.formatEther(newNativeTokenBalance),
      newBalanceValueInUSD: this.priceOracle.calculateUSDValue(ethers.ZeroAddress, newNativeTokenBalance).toFixed(4),
      diff: nativeTokenDiff,
      diffFormatted: ethers.formatEther(nativeTokenDiff),
      diffValueInUSD: this.priceOracle.calculateUSDValue(ethers.ZeroAddress, nativeTokenDiff).toFixed(4),
    };

    // Token balance changes
    involvedTokens.forEach((addr) => {
      const oldBalance = oldTokenBalances.get(addr)!;
      const newBalance = newTokenBalances.get(addr)!;
      const token = this.tokenManager.getToken(addr)!;

      const diff = newBalance - oldBalance;

      balanceChanges[token.symbol] = {
        oldBalance,
        oldBalanceFormatted: ethers.formatUnits(oldBalance, token.decimals),
        oldBalanceValueInUSD: this.priceOracle.calculateUSDValue(token.address, oldBalance).toFixed(4),
        newBalance: newBalance,
        newBalanceFormatted: ethers.formatUnits(newBalance, token.decimals),
        newBalanceValueInUSD: this.priceOracle.calculateUSDValue(token.address, newBalance).toFixed(4),
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

  getWalletState() {
    return this.walletState;
  }

  /**
   * 📋 GET WALLET SUMMARY: Get formatted summary
   */
  getWalletSummary(): string {
    const nativeTokenBalanceFormatted = ethers.formatEther(this.walletState.nativeTokenBalance);
    const summary = [`Address: ${this.walletState.address}`, `${this.NATIVE_TOKEN}: ${nativeTokenBalanceFormatted}`];

    for (const [tokenAddress, balance] of this.tokenBalances.entries()) {
      const token = this.tokenManager.getToken(tokenAddress);
      if (token) summary.push(`${token.symbol}: ${ethers.formatUnits(balance, token.decimals)}`);
    }
    return summary.join('\n');
  }
}
