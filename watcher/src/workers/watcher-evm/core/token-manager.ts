/**
 * 🎯 TOKEN MANAGER: Central token information and price management
 */
import { ethers } from 'ethers';
import { Blockchain } from './blockchain';
import { createLogger, type Logger } from '@/utils';
import type { TokenOnChain, TokenPairOnChain } from '@/shared/data-model/token';
import type { WorkerDb } from '../db';
import type { EventBus } from './event-bus';
import type { ChainConfig } from '@/config/models';

export interface TokenManagerInput {
  db: WorkerDb;
  chainConfig: ChainConfig;
  blockchain: Blockchain;
  eventBus: EventBus;
}

// ================================================================================================
// TOKEN MANAGER CLASS
// ================================================================================================

export class TokenManager {
  private readonly logger: Logger;
  private readonly db: WorkerDb;
  private readonly chainConfig: ChainConfig;
  private readonly blockchain: Blockchain;
  private readonly eventBus: EventBus;

  // token its the main list of active tokens - we register only root tokens and stablecoins at startup
  // as pool events come in we register new tokens into this list => which triggers token pair creations with root tokens
  private tokens: Map<string, TokenOnChain> = new Map(); // the main list of activeTokens

  // cached list of all stored tokens from DB
  private storedTokens: TokenOnChain[] = [];

  // cached list of trusted tokens loaded from cache (e.g. coingecko or uniswap token lists)
  private trustedTokens: TokenOnChain[] = [];

  // TokenPair registry for quick lookup of trading pairs
  private tokenPairs: Map<string, TokenPairOnChain> = new Map(); // key is `${token0.symbol}-${token1.symbol}` (token0/1 are ordered by address)

  // Token metadata cache
  private erc20ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function totalSupply() view returns (uint256)',
    'function balanceOf(address) view returns (uint256)',
  ];

  constructor(input: TokenManagerInput) {
    this.logger = createLogger(`[${input.chainConfig.name}.token-manager]`);
    this.db = input.db;
    this.chainConfig = input.chainConfig;
    this.blockchain = input.blockchain;
    this.eventBus = input.eventBus;
  }

  // ================================================================================================
  // init - load tokens from db, also load trusted tokens and cache everthing
  // ================================================================================================
  async init() {
    const dbTokens = await this.db.loadAllTokens();

    this.storedTokens = dbTokens.map((token) => ({
      chainId: token.chainId,
      address: token.address,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      trusted: token.source === 'coingecko', // consider tokens from coingecko list as trusted
    }));

    this.logger.info(`📦 Cached ${this.storedTokens.length} stored tokens from DB`);

    // load trusted tokens in cache (coingecko or uniswap token lists)
    await this.loadTrustedTokens('coingecko');

    // ensure root tokens and stablecoins are registered
    await Promise.all(this.chainConfig.stablecoinTokens.map((symbol) => this.ensureTokenRegistered(symbol, 'symbol')));
    await Promise.all(this.chainConfig.rootTokens.map((symbol) => this.ensureTokenRegistered(symbol, 'symbol')));
  }

  /**
   * Load trusted tokens (make sure to have the corresponding cache file in data/cache/)
   * coingecho source: https://tokens.coingecko.com/uniswap/all.json
   * uniswap source: https://tokens.uniswap.org
   */
  async loadTrustedTokens(source: 'coingecko' | 'uniswap'): Promise<void> {
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
    this.logger.info(`📦 Cached ${this.trustedTokens.length} trusted tokens from ${source}`);
  }

  /**
   * 📝 REGISTER TOKEN: Either from trusted tokens or introspect on-chain
   */
  async ensureTokenRegistered(key: string, by: 'address' | 'symbol'): Promise<TokenOnChain> {
    if (by === 'address') {
      key = key.toLowerCase(); // normalize address to lowercase
      const registredToken = this.tokens.get(key);
      if (registredToken) return registredToken;
    } else {
      const registredToken = Array.from(this.tokens.values()).find((token) => token.symbol === key);
      if (registredToken) return registredToken;
    }

    // if token not registred:
    // 1. attempt to find token in storedTokens from DB
    let foundToken = this.storedTokens.find((token) => token[by] === key && token.chainId === this.blockchain.chainId);
    if (foundToken) {
      this.tokens.set(foundToken.address, foundToken);
      this.eventBus.emitTokenRegistered(foundToken);
      return foundToken;
    }

    // 2. if not found in db => attempt to find token in trusted list,
    // 3. otherwise introspect on chain (only by address, symbol-based lookup is not reliable)
    let tokenSource: 'coingecko' | 'introspected' = 'coingecko';
    foundToken = this.trustedTokens.find((token) => token[by] === key && token.chainId === this.blockchain.chainId);
    if (!foundToken && by === 'address') {
      this.logger.warn(`⚠️ Token with ${by} ${key} not found in trusted tokens list, introspecting on-chain...`);
      foundToken = await this.introspectToken(key); // introspect token on chain
      tokenSource = 'introspected';
    }

    // if still not found => throw error (token does not exist or is not ERC20 compliant)
    if (!foundToken) throw new Error(`Token with ${by} ${key} not found`);

    // => register token in main list, save it to DB and emit token-registered event
    this.tokens.set(foundToken.address, foundToken);
    this.storedTokens.push(foundToken); // also add to storedTokens cache to mark it as stored
    this.eventBus.emitTokenRegistered(foundToken);
    this.db.upsertToken({ ...foundToken, source: tokenSource, isEnabled: true }).catch((error) => {
      this.logger.error(`❌ Failed to save token ${foundToken.symbol} (${foundToken.address}) to DB: ${error}`);
    });
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

  /**
   * Create trading pairs between all root tokens
   * emits event for new token pairs which triggers pool discovery in PoolStatesManager
   */
  createTradingPairsBetweenRootTokens() {
    for (const symbol0 of this.chainConfig.rootTokens) {
      for (const symbol1 of this.chainConfig.rootTokens) {
        const token0 = this.findTokenBySymbol(symbol0);
        const token1 = this.findTokenBySymbol(symbol1);
        if (!token0 || !token1) throw new Error(`Root tokens ${symbol0} or ${symbol1} not found in registry`);
        if (token0.address === token1.address) continue; // Skip self-pairs
        // Enforce canonical order to avoid duplicates
        if (token0.address < token1.address) {
          const key = `${token0.symbol}-${token1.symbol}`;
          if (this.tokenPairs.has(key)) continue; // Skip if pair already exists
          const tokenPair: TokenPairOnChain = { key, token0, token1 };
          this.tokenPairs.set(key, tokenPair);
          this.eventBus.emitTokenPairRegistered(tokenPair); // Emit event for new token pair
        }
      }
    }
  }

  /**
   * Create token pairs between some input token and all root tokens
   * emits event for new token pairs which triggers pool discovery in PoolStatesManager
   */
  createTokenPairsForNewToken(newToken: TokenOnChain) {
    // TBD: improve this logic in future:
    // - create trading pairs only if some criteria are met to avoid unnecessary pool discoveries
    // - also cache token pairs stats to avoid creating pairs that are unlikely to be liquid (e.g. low market cap tokens)
    for (const rootSymbol of this.chainConfig.rootTokens) {
      const rootToken = this.findTokenBySymbol(rootSymbol);
      if (!rootToken) throw new Error(`Root token ${rootSymbol} not found in registry`);
      if (newToken.address === rootToken.address) continue; // Skip self-pair

      // Enforce canonical order to avoid duplicates
      const [token0, token1] = newToken.address < rootToken.address ? [newToken, rootToken] : [rootToken, newToken];
      const key = `${token0.symbol}-${token1.symbol}`;
      if (this.tokenPairs.has(key)) {
        this.logger.warn(`Token pair ${key} already exists, skipping creation`);
        continue; // Skip if pair already exists
      }
      const tokenPair: TokenPairOnChain = { key, token0, token1 };
      this.tokenPairs.set(key, tokenPair);
      this.eventBus.emitTokenPairRegistered(tokenPair); // Emit event for new token pair
    }
  }
}
