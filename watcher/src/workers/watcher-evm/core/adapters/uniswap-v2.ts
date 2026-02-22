/**
 * 🦄 UNISWAP V2 ADAPTER: High-performance V2 DEX adapter with optimized calculations
 */
import { ethers } from 'ethers';
import { BaseDexAdapter, DexUtils } from '../base';
import type { DexType, PoolState, TradeQuote, PoolEvent, Token } from '../interfaces';
import { TokenManager } from '../token-manager';
import { Blockchain } from '../blockchain';

export interface UniswapV2Config {
  name: string; // Exchange name
  factoryAddress: string;
  routerAddress: string;
}

// ================================================================================================
// UNISWAP V2 ADAPTER
// ================================================================================================

export class UniswapV2Adapter extends BaseDexAdapter {
  readonly name: string;
  readonly type: DexType = 'uniswap-v2';
  readonly factoryAddress: string;
  readonly routerAddress: string;
  readonly feeBasisPoints: number = 30; // 0.3% fee (30 bps) (denominated by 10,000)

  private factoryContract: ethers.Contract;
  // private routerContract: ethers.Contract;

  // ABI definitions
  public readonly FACTORY_ABI = [
    'function getPair(address tokenA, address tokenB) external view returns (address pair)',
    'function allPairs(uint) external view returns (address pair)',
    'function allPairsLength() external view returns (uint)',
    'event PairCreated(address indexed token0, address indexed token1, address pair, uint)',
  ];

  public readonly POOL_ABI = [
    'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
    'function token0() external view returns (address)',
    'function token1() external view returns (address)',
    'function totalSupply() external view returns (uint)',
    'function kLast() external view returns (uint)',
    'event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)',
    'event Sync(uint112 reserve0, uint112 reserve1)',
  ];

  private readonly ROUTER_ABI = [
    'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
    'function getAmountsIn(uint amountOut, address[] calldata path) external view returns (uint[] memory amounts)',
    'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
  ];

  constructor(config: UniswapV2Config, blockchain: Blockchain, tokenManager: TokenManager) {
    super(config, blockchain, tokenManager);
    this.name = config.name;
    this.factoryAddress = config.factoryAddress;
    this.routerAddress = config.routerAddress;

    // Initialize contracts
    this.factoryContract = this.blockchain.initContract(config.factoryAddress, this.FACTORY_ABI);
    // this.routerContract = this.blockchain.initContract(config.routerAddress, this.ROUTER_ABI);
  }

  // ================================================================================================
  // POOL DISCOVERY AND STATE MANAGEMENT
  // ================================================================================================

  /**
   * 🔍 FIND POOLS: Find all V2 pools for a token pair
   */
  async discoverPools(token0: string, token1: string): Promise<PoolState[]> {
    const symbol0 = this.tokenManager.getToken(token0)?.symbol || token0;
    const symbol1 = this.tokenManager.getToken(token1)?.symbol || token1;
    try {
      const poolAddress = await this.factoryContract.getPair(token0, token1);
      if (poolAddress === ethers.ZeroAddress) throw new Error('No pool found');
      const poolState = await this.initPool(poolAddress);

      return [poolState];
    } catch (error) {
      this.logger.warn(`❌ Failed to find pools on ${this.name} for ${symbol0}/${symbol1}: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * 🏗 INIT POOL: Initialize V2 pool state with static data (called once when pool is first discovered)
   */
  async initPool(id: string): Promise<PoolState> {
    const poolAddress = id.toLowerCase();

    // init pool contract
    const contract = this.blockchain.initContract(poolAddress, this.POOL_ABI);

    // Fetch pool static data
    const [token0Address, token1Address] = await Promise.all([contract.token0(), contract.token1()]);
    if (!token0Address || !token1Address) throw new Error(`Failed to fetch token addresses for pool ${poolAddress}`);

    // Get token objects from TokenManager
    const token0 = this.tokenManager.getToken(token0Address);
    const token1 = this.tokenManager.getToken(token1Address);
    if (!token0 || !token1) throw new Error(`Tokens not found for addresses: ${token0Address}, ${token1Address}`);

    return {
      id: poolAddress,
      tokenPair: { token0, token1, pairKey: `${token0.symbol}-${token1.symbol}` },
      dexName: this.name,
      dexType: this.type,
      routerAddress: this.routerAddress,
      fee: this.feeBasisPoints, // Convert to basis points (0.3% = 30 bps (denominated by 10,000))

      // init dynamic fields to zero (updated later)
      reserve0: 0n,
      reserve1: 0n,
      spotPrice0to1: 0,
      spotPrice1to0: 0,
      totalLiquidityInUSD: 0,
    };
  }

  /**
   * 📊 GET POOL STATE: Fetch current pool state
   */
  async updatePool(pool: PoolState): Promise<PoolState> {
    const poolAddress = pool.id;

    const contract = this.blockchain.getContract(poolAddress);
    if (!contract) throw new Error(`Pool contract not found: ${poolAddress}`);

    // Fetch reserves
    const reserves = await contract.getReserves();
    if (!reserves) throw new Error(`Failed to fetch reserves for pool: ${poolAddress}`);

    // derived fields
    const { token0, token1 } = pool.tokenPair;

    pool.reserve0 = reserves.reserve0;
    pool.reserve1 = reserves.reserve1;
    pool.spotPrice0to1 = UniswapV2Adapter.calculateSpotPrice(reserves.reserve0, reserves.reserve1, token0, token1, true);
    pool.spotPrice1to0 = UniswapV2Adapter.calculateSpotPrice(reserves.reserve0, reserves.reserve1, token0, token1, false);
    return pool;
  }

  // ================================================================================================
  // TRADING AND QUOTES
  // ================================================================================================

  /**
   * 💰 GET SPOT PRICE: Get current spot price for a pool
   * Returns price as a floating-point number, normalized for token decimals.
   * If zeroForOne is true, returns price of token0 in token1 (token1/token0).
   * If false, returns price of token1 in token0 (token0/token1).
   */
  static calculateSpotPrice(reserve0: bigint, reserve1: bigint, token0: Token, token1: Token, zeroForOne: boolean): number {
    if (!reserve0 || !reserve1) throw new Error('Invalid reserves');
    if (zeroForOne) {
      const norm0 = parseFloat(ethers.formatUnits(reserve0, token0.decimals));
      const norm1 = parseFloat(ethers.formatUnits(reserve1, token1.decimals));
      return norm1 / norm0;
    } else {
      const norm0 = parseFloat(ethers.formatUnits(reserve0, token0.decimals));
      const norm1 = parseFloat(ethers.formatUnits(reserve1, token1.decimals));
      return norm0 / norm1;
    }
  }

  /**
   * 💰 GET TRADE QUOTE: Calculate V2 trade quote with perfect math
   */
  async getTradeQuote(poolState: PoolState, amountIn: bigint, zeroForOne: boolean): Promise<TradeQuote> {
    if (amountIn <= 0n) throw new Error(`Invalid trade amount: ${amountIn} (must be > 0)`);
    const { token0, token1 } = poolState.tokenPair;

    // Set reserves based on direction
    const reserveIn = zeroForOne ? poolState.reserve0! : poolState.reserve1!;
    const reserveOut = zeroForOne ? poolState.reserve1! : poolState.reserve0!;

    if (reserveIn <= 0n || reserveOut <= 0n) throw new Error(`Insufficient liquidity in pool: ${poolState.id}`);
    if (amountIn > reserveIn) throw new Error(`Trade amount exceeds available liquidity in pool: ${poolState.id}`);

    // Convert fee to basis points for precision
    const feeRateBasisPoints = BigInt(this.feeBasisPoints); // 30n
    const keepRateBasisPoints = 10000n - feeRateBasisPoints; // 9970n

    // V2 constant product formula with fee
    const amountInWithFee = (amountIn * keepRateBasisPoints) / 10000n;
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn + amountInWithFee;
    const amountOut = numerator / denominator;

    if (amountOut <= 0n) throw new Error(`Trade quote invalid amountOut: ${amountOut}`);

    // Use correct spot price for direction
    const spotPrice = zeroForOne ? poolState.spotPrice0to1 : poolState.spotPrice1to0;

    // Calculate execution price
    const normalizedAmountIn = parseFloat(ethers.formatUnits(amountIn, zeroForOne ? token0.decimals : token1.decimals));
    const normalizedAmountOut = parseFloat(ethers.formatUnits(amountOut, zeroForOne ? token1.decimals : token0.decimals));
    const executionPrice = normalizedAmountOut / normalizedAmountIn;
    const priceImpact = DexUtils.calculatePriceImpact(spotPrice, executionPrice);

    // Calculate slippage (for V2, slippage equals price impact)
    const slippage = priceImpact;

    return {
      poolState,
      amountIn,
      amountOut,
      executionPrice,
      priceImpact,
      slippage,
      confidence: 0.99, // V2 quotes are very reliable
    };
  }

  /**
   * 💰 GET TRADE QUOTE: Calculate V2 trade quote with perfect math
   */
  simulateSwap(poolState: PoolState, amountIn: bigint, zeroForOne: boolean): bigint {
    if (amountIn <= 0n) throw new Error(`Invalid trade amount: ${amountIn} (must be > 0)`);

    // Set reserves based on direction
    const reserveIn = zeroForOne ? poolState.reserve0! : poolState.reserve1!;
    const reserveOut = zeroForOne ? poolState.reserve1! : poolState.reserve0!;

    if (reserveIn <= 0n || reserveOut <= 0n) throw new Error(`Insufficient liquidity in pool: ${poolState.id}`);
    if (amountIn > reserveIn)
      throw new Error(
        `Trade amount exceeds available liquidity in pool: ${poolState.id} - reserveIn: ${reserveIn} amountIn: ${amountIn}`,
      );

    // Convert fee to basis points for precision
    const feeRateBasisPoints = BigInt(this.feeBasisPoints); // 30n
    const keepRateBasisPoints = 10000n - feeRateBasisPoints; // 9970n

    // V2 constant product formula with fee
    const amountInWithFee = (amountIn * keepRateBasisPoints) / 10000n;
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn + amountInWithFee;
    const amountOut = numerator / denominator;
    return amountOut;
  }

  /**
   * 💰 GET FEE PERCENT: Get V2 pool fee percentage
   */
  getFeePercent(poolState: PoolState): number {
    return poolState.fee / 100; // Convert from basis points to percentage (30 bps = 0.3%)
  }

  // ================================================================================================
  // EVENT HANDLING
  // ================================================================================================

  /**
   * 🔄 UPDATE POOL STATE FROM EVENT: Fast V2 state updates
   * Only allow sync events!!!
   */
  updatePoolFromEvent(pool: PoolState, event: PoolEvent): PoolState {
    if (!event.reserve0 || !event.reserve1) throw new Error(`❌ Invalid sync event for: ${event.dexName} - ${event.poolId}`);
    pool.reserve0 = event.reserve0;
    pool.reserve1 = event.reserve1;

    // Update derived fields
    const { token0, token1 } = pool.tokenPair;
    pool.spotPrice0to1 = UniswapV2Adapter.calculateSpotPrice(event.reserve0!, event.reserve1!, token0, token1, true);
    pool.spotPrice1to0 = UniswapV2Adapter.calculateSpotPrice(event.reserve0!, event.reserve1!, token0, token1, false);

    // calculate liquidityUSD (requires external price feed)
    try {
      // TODO: update this when implemented price oracle
      // const v0 = this.tokenManager.calculateUSDValue(pool.tokenPair.token0.address, pool.reserve0!) || 0;
      // const v1 = this.tokenManager.calculateUSDValue(pool.tokenPair.token1.address, pool.reserve1!) || 0;
      // pool.totalLiquidityInUSD = v0 + v1;
    } catch (error) {
      // this.logger.warn(`❌ Failed to calculate USD liquidity for pool ${event.poolId}: ${(error as Error).message}`);
      pool.totalLiquidityInUSD = 0;
    }

    pool.latestEventMeta = { ...event.meta };
    return pool;
  }
}
