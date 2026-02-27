/**
 * 🦄 UNISWAP V2 ADAPTER: High-performance V2 DEX adapter with optimized calculations
 */
import { ethers } from 'ethers';
import type { TradeQuote, PoolEvent, DexAdapter } from '../interfaces';
import { TokenManager } from '../token-manager';
import { Blockchain } from '../blockchain';
import { dexPoolId, type DexV2PoolState, type DexVenueName } from '@/shared/data-model/layer1';
import { getCanonicalPairId, type TokenOnChain } from '@/shared/data-model/token';
import { calculatePriceImpact } from './lib/math';
import type { DexV2Config } from '@/config/models';
import { createLogger } from '@/utils';

// ================================================================================================
// UNISWAP V2 ADAPTER
// ================================================================================================

export class DexV2Adapter implements DexAdapter {
  readonly name: DexVenueName;
  readonly protocol = 'v2';
  readonly config: DexV2Config;
  readonly feeBasisPoints: number = 30; // 0.3% fee (30 bps) (denominated by 10,000)

  private readonly factoryContract: ethers.Contract;
  private readonly blockchain: Blockchain;
  private readonly tokenManager: TokenManager;

  private readonly logger = createLogger('DexV2Adapter');

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

  constructor(config: DexV2Config, blockchain: Blockchain, tokenManager: TokenManager) {
    this.name = config.name;
    this.config = config;
    this.blockchain = blockchain;
    this.tokenManager = tokenManager;

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
  async discoverPools(token0: string, token1: string): Promise<DexV2PoolState[]> {
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
  async initPool(address: string): Promise<DexV2PoolState> {
    const poolAddress = address.toLowerCase();

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
      id: dexPoolId(this.blockchain.chainId, poolAddress),
      address: poolAddress,
      venue: { name: this.name, type: 'dex', chainId: this.blockchain.chainId },
      protocol: 'v2',
      pairId: getCanonicalPairId(token0, token1),
      tokenPair: { token0, token1, key: `${token0.symbol}-${token1.symbol}` },
      feeBps: this.feeBasisPoints, // Convert to basis points (0.3% = 30 bps (denominated by 10,000))

      // init dynamic fields to zero (updated later)
      reserve0: 0n,
      reserve1: 0n,
      spotPrice0to1: 0,
      spotPrice1to0: 0,
      // totalLiquidityInUSD: 0,
    };
  }

  /**
   * 📊 GET POOL STATE: Fetch current pool state
   */
  async updatePool(pool: DexV2PoolState): Promise<DexV2PoolState> {
    const contract = this.blockchain.getContract(pool.address);
    if (!contract) throw new Error(`Pool contract not found: ${pool.address}`);

    // Fetch reserves
    const reserves = await contract.getReserves();
    if (!reserves) throw new Error(`Failed to fetch reserves for pool: ${pool.address}`);

    // derived fields
    const { token0, token1 } = pool.tokenPair;

    pool.reserve0 = reserves.reserve0;
    pool.reserve1 = reserves.reserve1;
    pool.spotPrice0to1 = DexV2Adapter.calculateSpotPrice(reserves.reserve0, reserves.reserve1, token0, token1, true);
    pool.spotPrice1to0 = DexV2Adapter.calculateSpotPrice(reserves.reserve0, reserves.reserve1, token0, token1, false);
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
  static calculateSpotPrice(
    reserve0: bigint,
    reserve1: bigint,
    token0: TokenOnChain,
    token1: TokenOnChain,
    zeroForOne: boolean,
  ): number {
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
  async getTradeQuote(poolState: DexV2PoolState, amountIn: bigint, zeroForOne: boolean): Promise<TradeQuote> {
    if (amountIn <= 0n) throw new Error(`Invalid trade amount: ${amountIn} (must be > 0)`);
    const { token0, token1 } = poolState.tokenPair;

    // Set reserves based on direction
    const reserveIn = zeroForOne ? poolState.reserve0! : poolState.reserve1!;
    const reserveOut = zeroForOne ? poolState.reserve1! : poolState.reserve0!;

    if (reserveIn <= 0n || reserveOut <= 0n) throw new Error(`Insufficient liquidity in pool: ${poolState.id}`);
    if (amountIn > reserveIn) throw new Error(`Trade amount exceeds available liquidity in pool: ${poolState.id}`);

    // Convert fee to basis points for precision
    const feeRateBasisPoints = BigInt(poolState.feeBps); // 30n
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
    const priceImpact = calculatePriceImpact(spotPrice, executionPrice);

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
  simulateSwap(poolState: DexV2PoolState, amountIn: bigint, zeroForOne: boolean): bigint {
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
    const feeRateBasisPoints = BigInt(poolState.feeBps); // 30n
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
  getFeePercent(poolState: DexV2PoolState): number {
    return poolState.feeBps / 100; // Convert from basis points to percentage (30 bps = 0.3%)
  }

  // ================================================================================================
  // EVENT HANDLING
  // ================================================================================================

  /**
   * 🔄 UPDATE POOL STATE FROM EVENT: Fast V2 state updates
   * Only allow sync events!!!
   */
  updatePoolFromEvent(pool: DexV2PoolState, event: PoolEvent): DexV2PoolState {
    if (event.protocol !== 'v2' || event.name !== 'sync') throw new Error(`Invalid event type: ${event.protocol} ${event.name}`);
    pool.reserve0 = event.reserve0;
    pool.reserve1 = event.reserve1;
    pool.latestEventMeta = event.meta;

    // Update derived fields
    const { token0, token1 } = pool.tokenPair;
    pool.spotPrice0to1 = DexV2Adapter.calculateSpotPrice(event.reserve0!, event.reserve1!, token0, token1, true);
    pool.spotPrice1to0 = DexV2Adapter.calculateSpotPrice(event.reserve0!, event.reserve1!, token0, token1, false);

    // calculate liquidityUSD (requires external price feed)
    try {
      // TODO: update this when implemented price oracle
      // const v0 = this.tokenManager.calculateUSDValue(pool.tokenPair.token0.address, pool.reserve0!) || 0;
      // const v1 = this.tokenManager.calculateUSDValue(pool.tokenPair.token1.address, pool.reserve1!) || 0;
      // pool.totalLiquidityInUSD = v0 + v1;
    } catch (error) {
      // this.logger.warn(`❌ Failed to calculate USD liquidity for pool ${event.poolId}: ${(error as Error).message}`);
      // pool.totalLiquidityInUSD = 0;
    }

    return pool;
  }
}
