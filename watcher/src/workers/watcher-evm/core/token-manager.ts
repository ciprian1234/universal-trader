/**
 * 🎯 TOKEN MANAGER: Central token information and price management
 */
import { ethers } from 'ethers';
import { Blockchain } from './blockchain';
import type { Logger } from '@/utils';
import type { Token, TokenPair } from './interfaces';
import type { TokenConfig } from '@/config/models';

export interface TokenManagerConfig {
  logger: Logger;
  blockchain: Blockchain;
  inputTokens: Array<TokenConfig>; // input tokens at initialization
}

// ================================================================================================
// TOKEN MANAGER CLASS
// ================================================================================================

export class TokenManager {
  private readonly logger: Logger;
  private blockchain: Blockchain;
  private tokens: Map<string, Token> = new Map();
  private inputTokens: Array<TokenConfig>; // Configured input tokens to register at startup

  // Token metadata cache
  private erc20ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function totalSupply() view returns (uint256)',
    'function balanceOf(address) view returns (uint256)',
  ];

  constructor(config: TokenManagerConfig) {
    this.inputTokens = config.inputTokens;
    this.blockchain = config.blockchain;
    this.logger = config.logger;
  }

  // ================================================================================================
  // TOKEN REGISTRATION AND MANAGEMENT
  // ================================================================================================

  /**
   * 📝 REGISTER TOKEN: Add token to manager with metadata
   */
  async registerToken(address: string): Promise<Token> {
    const normalizedAddress = address.toLowerCase();

    // Check if already registered
    const existing = this.tokens.get(normalizedAddress);
    if (existing) throw new Error(`Token ${address} already registered`);

    // init erc20 token contract
    const contract = this.blockchain.initContract(address, this.erc20ABI);

    try {
      const [name, symbol, decimals] = await Promise.all([contract.name(), contract.symbol(), contract.decimals()]);

      const token: Token = {
        address: normalizedAddress,
        symbol,
        name,
        decimals: Number(decimals),
      };

      this.tokens.set(normalizedAddress, token);
      this.logger.info(`💰 Token registered: (${symbol.padEnd(1)}) ${name.padEnd(20)} (TokenAddress: ${normalizedAddress})`);

      return token;
    } catch (error) {
      throw new Error(`Failed to register token ${address}: ${error}`);
    }
  }

  /**
   * 📦 BATCH REGISTER: Register multiple tokens efficiently
   */
  async batchRegisterTokens(): Promise<Token[]> {
    const results = await Promise.allSettled(this.inputTokens.map(({ address }) => this.registerToken(address)));

    const registeredTokens: Token[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') registeredTokens.push(result.value);
      else throw new Error(`Failed to register token ${this.inputTokens[i].address}: ${result.reason}`);
    }

    this.logger.info(`✅ Registered ${registeredTokens.length} tokens\n`);
    return registeredTokens;
  }

  /**
   * 🔍 GET TOKEN: Retrieve token information
   */
  getToken(address: string): Token | undefined {
    return this.tokens.get(address.toLowerCase());
  }

  /**
   * Get all registered tokens as array
   */
  getAllTokensArray(): Token[] {
    return Array.from(this.tokens.values());
  }

  /*
   * Get all tokens
   */
  getAllTokens() {
    return this.tokens;
  }

  // ================================================================================================
  // UTILITY METHODS
  // ================================================================================================

  /**
   * 🔢 FORMAT TOKEN AMOUNT: Convert raw amount to human-readable
   */
  formatTokenAmount(address: string, rawAmount: bigint): string {
    const token = this.getToken(address);
    if (!token) throw new Error(`Token ${address} not registered`);
    return ethers.formatUnits(rawAmount, token.decimals);
  }

  /**
   * 🔢 PARSE TOKEN AMOUNT: Convert human-readable to raw amount
   */
  parseTokenAmount(address: string, amount: string): bigint {
    const token = this.getToken(address);
    if (!token) throw new Error(`Token ${address} not registered`);
    return ethers.parseUnits(amount, token.decimals);
  }

  /**
   * 🔍 FIND TOKEN BY SYMBOL: Find token by symbol (case-insensitive)
   */
  findTokenBySymbol(symbol: string): Token | undefined {
    for (const token of this.tokens.values()) {
      if (token.symbol === symbol) return token;
    }
    return undefined;
  }

  /**
   * 📊 GET TOKEN BALANCE: Get balance for an address
   */
  async getTokenBalance(tokenAddress: string, walletAddress: string): Promise<bigint> {
    const contract = this.blockchain.getContract(tokenAddress);
    return await contract.balanceOf(walletAddress);
  }

  // ================================================================================================
  // UTILITY METHODS
  // ================================================================================================

  createTradingPairs(): TokenPair[] {
    const allTokens = this.getAllTokensArray();
    const pairs: TokenPair[] = [];

    // Create pairs for major tokens
    const majorTokens = allTokens.filter((token) => ['WETH', 'WBTC', 'USDC'].includes(token.symbol));

    for (const tokenA of allTokens) {
      for (const tokenB of allTokens) {
        if (tokenA.address === tokenB.address) continue; // Skip self-pairs

        // Enforce canonical order to avoid duplicates
        if (tokenA.address < tokenB.address) {
          pairs.push({
            token0: tokenA,
            token1: tokenB,
            pairKey: `${tokenA.symbol}-${tokenB.symbol}`,
          });
        }
      }
    }

    return pairs;
  }
}
