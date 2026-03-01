/**
 * 🎯 TOKEN MANAGER: Central token information and price management
 */
import { ethers } from 'ethers';
import { Blockchain } from './blockchain';
import type { Logger } from '@/utils';
import type { TokenOnChain, TokenPairOnChain } from '@/shared/data-model/token';

export interface TokenManagerConfig {
  logger: Logger;
  blockchain: Blockchain;
}

// ================================================================================================
// TOKEN MANAGER CLASS
// ================================================================================================

export class TokenManager {
  private readonly logger: Logger;
  private blockchain: Blockchain;

  private tokens: Map<string, TokenOnChain> = new Map();
  private trustedTokens: TokenOnChain[] = []; // List of trusted tokens loaded from cache (e.g. coingecko or uniswap token lists)

  // Token metadata cache
  private erc20ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function totalSupply() view returns (uint256)',
    'function balanceOf(address) view returns (uint256)',
  ];

  constructor(config: TokenManagerConfig) {
    this.blockchain = config.blockchain;
    this.logger = config.logger;
  }

  // ================================================================================================
  // TOKEN REGISTRATION AND MANAGEMENT
  // ================================================================================================

  /**
   * Load trusted tokens (make sure to have the corresponding cache file in data/cache/)
   * coingecho source: https://tokens.coingecko.com/uniswap/all.json
   * uniswap source: https://tokens.uniswap.org
   */
  async loadTrustedTokens(source: 'coingecko' | 'uniswap'): Promise<void> {
    this.logger.info(`🔍 Loading trusted tokens from ${source}...`);
    const cache = await import(`../../../../data/cache/${source}-token-list.json`);
    if (!cache || !cache.tokens) throw new Error(`No trusted tokens found in ${source} cache`);
    this.trustedTokens = cache.tokens.map((token: any) => ({
      chainId: token.chainId,
      address: token.address.toLowerCase(),
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
      trusted: true,
    }));
    this.logger.info(`✅ Loaded ${this.trustedTokens.length} trusted tokens from ${source}.`);
  }

  /**
   * 📝 REGISTER TOKEN: Either from trusted tokens or introspect on-chain
   */
  async ensureTokenRegistered(key: string, by: 'address' | 'symbol'): Promise<TokenOnChain> {
    if (by === 'address') {
      key = key.toLowerCase(); // normalize address to lowercase
      const registredToken = this.tokens.get(key);
      if (registredToken) return registredToken;
    }

    // find token in trusted list otherwise introspect on chain (only by address, symbol-based lookup is not reliable)
    let foundToken = this.trustedTokens.find((token) => token[by] === key && token.chainId === this.blockchain.chainId);
    if (!foundToken && by === 'address') {
      this.logger.warn(`⚠️ Token with ${by} ${key} not found in trusted tokens list, introspecting on-chain...`);
      foundToken = await this.introspectToken(key); // introspect token on chain
    }
    if (!foundToken) throw new Error(`Token with ${by} ${key} not found`);

    // Register token if not already registered
    this.tokens.set(foundToken.address, foundToken);
    this.logger.info(`✅ Registered token ${foundToken.symbol} (addr: ${foundToken.address})`);
    return foundToken;
  }

  /**
   * 📝 Introspect token by address on chain
   */
  async introspectToken(address: string): Promise<TokenOnChain> {
    const normalizedAddress = address.toLowerCase();

    // init erc20 token contract
    const contract = this.blockchain.initContract(address, this.erc20ABI);

    try {
      const [name, symbol, decimals] = await Promise.all([contract.name(), contract.symbol(), contract.decimals()]);

      const token: TokenOnChain = {
        chainId: this.blockchain.chainId,
        address: normalizedAddress,
        symbol,
        name,
        decimals: Number(decimals),
        trusted: false,
      };

      this.logger.info(`Introspected token (${symbol.padEnd(1)}) ${name.padEnd(20)} (TokenAddress: ${normalizedAddress})`);

      return token;
    } catch (error) {
      throw new Error(`Failed to introspect token ${address}: ${error}`);
    }
  }

  /**
   * 🔍 GET TOKEN: Retrieve token information
   */
  getToken(address: string): TokenOnChain | undefined {
    return this.tokens.get(address.toLowerCase());
  }

  /**
   * Get all registered tokens as array
   */
  getAllTokensArray(): TokenOnChain[] {
    return Array.from(this.tokens.values());
  }

  /*
   * Get all tokens
   */
  getAllTokens(): Map<string, TokenOnChain> {
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
  findTokenBySymbol(symbol: string): TokenOnChain | undefined {
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
    if (!contract) throw new Error(`Contract for token ${tokenAddress} not found`);
    return await contract.balanceOf(walletAddress);
  }

  // ================================================================================================
  // UTILITY METHODS
  // ================================================================================================

  createTradingPairs(): TokenPairOnChain[] {
    const allTokens = this.getAllTokensArray();
    const pairs: TokenPairOnChain[] = [];

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
            key: `${tokenA.symbol}-${tokenB.symbol}`,
          });
        }
      }
    }

    return pairs;
  }
}
