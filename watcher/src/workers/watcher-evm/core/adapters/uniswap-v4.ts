/**
 * 🦄 UNISWAP V4 ADAPTER: Support for V4 Singleton Architecture and Hooks
 */
import { ethers, AbiCoder } from 'ethers';
import { BaseDexAdapter } from '../base';
import type { DexType, PoolState, TradeQuote, PoolEvent, Token } from '../interfaces';
import { TokenManager } from '../token-manager';
import { Blockchain } from '../blockchain';
import {
  Q96,
  getAmount0Delta,
  getAmount1Delta,
  getNextSqrtPriceFromAmount0RoundingUp,
  getNextSqrtPriceFromAmount1RoundingDown,
  sqrtPriceX96ToPrice,
  calculateVirtualReserves,
} from './lib/sqrtPriceMath';

export interface UniswapV4Config {
  name: string;
  poolManagerAddress: string; // The Singleton Contract
  stateViewAddress: string; // State Viewer Contract
  routerAddress: string; // Router address for swaps
  quoterAddress: string;
}

// ================================================================================================
// Types specific to Uniswap V4
// ================================================================================================
export type PoolKey = {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
};

// ================================================================================================
// UNISWAP V4 ADAPTER
// ================================================================================================

export class UniswapV4Adapter extends BaseDexAdapter {
  readonly name: string;
  readonly type: DexType = 'uniswap-v4'; // Assuming you add 'uniswap-v4' to DexType
  readonly poolManagerAddress: string;
  readonly routerAddress: string;
  readonly stateViewAddress: string;
  private poolManagerContract: ethers.Contract;
  private stateViewContract: ethers.Contract;
  private quoterContract: ethers.Contract | null = null;

  // Standard fee tier / tick spacing combos often used as defaults
  // Fee is uint24, TickSpacing is int24
  private readonly POOL_COMBINATIONS = [
    { fee: 100, tickSpacing: 2 }, // 0.01%
    { fee: 500, tickSpacing: 10 }, // 0.05%
    { fee: 3000, tickSpacing: 60 }, // 0.30%
    { fee: 10000, tickSpacing: 200 }, // 1.00%
  ];

  // Not applicable in V4
  readonly factoryAddress = 'N/A';
  readonly POOL_ABI = [];
  readonly FACTORY_ABI = [];

  // ABI definitions
  public readonly POOL_MANAGER_ABI = [
    // extsload for advanced queries
    'function extsload(bytes32 slot) external view returns (bytes32)',

    // Events
    'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks)',
    'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
    'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta)',
  ];

  private readonly QUOTER_ABI = [
    'function quoteExactInputSingle(tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks, bytes hookData) params, uint128 amountIn) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
    'function quoteExactOutputSingle(tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks, bytes hookData) params, uint128 amountOut) external returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  ];

  // ✅ ABI for the StateView / Lens contract
  private readonly STATE_VIEW_ABI = [
    'function getSlot0(address manager, bytes32 poolId) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
    'function getLiquidity(address manager, bytes32 poolId) external view returns (uint128 liquidity)',
  ];

  private readonly STATE_VIEW_ABI_2 = [
    {
      inputs: [{ internalType: 'contract IPoolManager', name: '_poolManager', type: 'address' }],
      stateMutability: 'nonpayable',
      type: 'constructor',
    },
    {
      inputs: [{ internalType: 'PoolId', name: 'poolId', type: 'bytes32' }],
      name: 'getFeeGrowthGlobals',
      outputs: [
        { internalType: 'uint256', name: 'feeGrowthGlobal0', type: 'uint256' },
        { internalType: 'uint256', name: 'feeGrowthGlobal1', type: 'uint256' },
      ],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [
        { internalType: 'PoolId', name: 'poolId', type: 'bytes32' },
        { internalType: 'int24', name: 'tickLower', type: 'int24' },
        { internalType: 'int24', name: 'tickUpper', type: 'int24' },
      ],
      name: 'getFeeGrowthInside',
      outputs: [
        { internalType: 'uint256', name: 'feeGrowthInside0X128', type: 'uint256' },
        { internalType: 'uint256', name: 'feeGrowthInside1X128', type: 'uint256' },
      ],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [{ internalType: 'PoolId', name: 'poolId', type: 'bytes32' }],
      name: 'getLiquidity',
      outputs: [{ internalType: 'uint128', name: 'liquidity', type: 'uint128' }],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [
        { internalType: 'PoolId', name: 'poolId', type: 'bytes32' },
        { internalType: 'bytes32', name: 'positionId', type: 'bytes32' },
      ],
      name: 'getPositionInfo',
      outputs: [
        { internalType: 'uint128', name: 'liquidity', type: 'uint128' },
        { internalType: 'uint256', name: 'feeGrowthInside0LastX128', type: 'uint256' },
        { internalType: 'uint256', name: 'feeGrowthInside1LastX128', type: 'uint256' },
      ],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [
        { internalType: 'PoolId', name: 'poolId', type: 'bytes32' },
        { internalType: 'address', name: 'owner', type: 'address' },
        { internalType: 'int24', name: 'tickLower', type: 'int24' },
        { internalType: 'int24', name: 'tickUpper', type: 'int24' },
        { internalType: 'bytes32', name: 'salt', type: 'bytes32' },
      ],
      name: 'getPositionInfo',
      outputs: [
        { internalType: 'uint128', name: 'liquidity', type: 'uint128' },
        { internalType: 'uint256', name: 'feeGrowthInside0LastX128', type: 'uint256' },
        { internalType: 'uint256', name: 'feeGrowthInside1LastX128', type: 'uint256' },
      ],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [
        { internalType: 'PoolId', name: 'poolId', type: 'bytes32' },
        { internalType: 'bytes32', name: 'positionId', type: 'bytes32' },
      ],
      name: 'getPositionLiquidity',
      outputs: [{ internalType: 'uint128', name: 'liquidity', type: 'uint128' }],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [{ internalType: 'PoolId', name: 'poolId', type: 'bytes32' }],
      name: 'getSlot0',
      outputs: [
        { internalType: 'uint160', name: 'sqrtPriceX96', type: 'uint160' },
        { internalType: 'int24', name: 'tick', type: 'int24' },
        { internalType: 'uint24', name: 'protocolFee', type: 'uint24' },
        { internalType: 'uint24', name: 'lpFee', type: 'uint24' },
      ],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [
        { internalType: 'PoolId', name: 'poolId', type: 'bytes32' },
        { internalType: 'int16', name: 'tick', type: 'int16' },
      ],
      name: 'getTickBitmap',
      outputs: [{ internalType: 'uint256', name: 'tickBitmap', type: 'uint256' }],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [
        { internalType: 'PoolId', name: 'poolId', type: 'bytes32' },
        { internalType: 'int24', name: 'tick', type: 'int24' },
      ],
      name: 'getTickFeeGrowthOutside',
      outputs: [
        { internalType: 'uint256', name: 'feeGrowthOutside0X128', type: 'uint256' },
        { internalType: 'uint256', name: 'feeGrowthOutside1X128', type: 'uint256' },
      ],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [
        { internalType: 'PoolId', name: 'poolId', type: 'bytes32' },
        { internalType: 'int24', name: 'tick', type: 'int24' },
      ],
      name: 'getTickInfo',
      outputs: [
        { internalType: 'uint128', name: 'liquidityGross', type: 'uint128' },
        { internalType: 'int128', name: 'liquidityNet', type: 'int128' },
        { internalType: 'uint256', name: 'feeGrowthOutside0X128', type: 'uint256' },
        { internalType: 'uint256', name: 'feeGrowthOutside1X128', type: 'uint256' },
      ],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [
        { internalType: 'PoolId', name: 'poolId', type: 'bytes32' },
        { internalType: 'int24', name: 'tick', type: 'int24' },
      ],
      name: 'getTickLiquidity',
      outputs: [
        { internalType: 'uint128', name: 'liquidityGross', type: 'uint128' },
        { internalType: 'int128', name: 'liquidityNet', type: 'int128' },
      ],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [],
      name: 'poolManager',
      outputs: [{ internalType: 'contract IPoolManager', name: '', type: 'address' }],
      stateMutability: 'view',
      type: 'function',
    },
  ];

  constructor(config: UniswapV4Config, blockchain: Blockchain, tokenManager: TokenManager) {
    super(config, blockchain, tokenManager);
    this.name = config.name;
    this.poolManagerAddress = config.poolManagerAddress;
    this.routerAddress = config.routerAddress;
    this.stateViewAddress = config.stateViewAddress;
    // Initialize contracts
    this.poolManagerContract = this.blockchain.initContract(config.poolManagerAddress, this.POOL_MANAGER_ABI);
    this.quoterContract = this.blockchain.initContract(config.quoterAddress, this.QUOTER_ABI);
    this.stateViewContract = this.blockchain.initContract(config.stateViewAddress, this.STATE_VIEW_ABI_2);
  }

  private isWETH(address: string): boolean {
    const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'; // Ethereum mainnet
    return address.toLowerCase() === WETH_ADDRESS.toLowerCase();
  }

  // ================================================================================================
  // POOL DISCOVERY AND STATE MANAGEMENT
  // ================================================================================================

  /**
   * 🔍 FIND POOLS: Find initialized V4 pools for a token pair
   * Note: V4 pools are defined by a PoolKey (Tokens + Fee + TickSpacing + Hooks).
   * This logic assumes standard no-hook pools.
   */
  async discoverPools(token0: string, token1: string): Promise<PoolState[]> {
    const symbol0 = this.tokenManager.getToken(token0)?.symbol || token0;
    const symbol1 = this.tokenManager.getToken(token1)?.symbol || token1;
    const pools: PoolState[] = [];

    // // Convert WETH to address(0) if needed
    // const currency0 = this.isWETH(token0) ? ethers.ZeroAddress : token0;
    // const currency1 = this.isWETH(token1) ? ethers.ZeroAddress : token1;

    // Check standard combinations
    for (const combo of this.POOL_COMBINATIONS) {
      try {
        // 1. Generate Pool Key
        const poolKey = {
          currency0: token0,
          currency1: token1,
          fee: combo.fee,
          tickSpacing: combo.tickSpacing,
          hooks: ethers.ZeroAddress, // Assuming standard pools without hooks (TBD: review)
        };

        // 2. Calculate Pool ID (Hash of Key)
        const poolIdHash = this.getPoolId(poolKey); // previous version for testing

        // 3. Check if initialized via Slot0 => If sqrtPriceX96 is 0, pool is not initialized
        // console.log(
        //   `Checking V4 pool for ${symbol0}/${symbol1} (Fee: ${combo.fee}, TickSpacing: ${combo.tickSpacing}) at ID: ${poolIdHash}`,
        // );
        // Use raw storage reader
        const slot0 = await this.stateViewContract.getSlot0(poolIdHash);
        if (!slot0.sqrtPriceX96 || slot0.sqrtPriceX96 === 0n) {
          this.logger.warn(`No V4 pool found for ${symbol0}/${symbol1} (Fee: ${combo.fee})`);
          continue; // Pool not initialized
        }

        // Found a pool!
        const poolState = await this.initPool(poolIdHash, poolKey);
        pools.push(poolState);
      } catch (error) {
        // Pool check failed
        this.logger.debug(
          `Trace check failed for V4 pool ${symbol0}/${symbol1} (Fee: ${combo.fee}): ${(error as Error).message}\n\n`,
        );
      }
    }

    return pools;
  }

  /**
   * 🏗 INIT POOL: Initialize V4 pool state
   * Note: In V4, we don't have a specific pool contract, we interact with PoolManager
   */
  // @ts-ignore - Signature mismatch with base due to extra poolKey params needed for initialization logic
  async initPool(id, poolKeyData?: any): Promise<PoolState> {
    // Use provided key or basic recovery (Tokens must be known contextually or passed in)
    if (!poolKeyData) {
      throw new Error('PoolKey data required to initialize V4 Pool State structure');
    }

    const token0 = this.tokenManager.getToken(poolKeyData.currency0);
    const token1 = this.tokenManager.getToken(poolKeyData.currency1);

    if (!token0 || !token1) throw new Error(`Tokens not found: ${poolKeyData.currency0}, ${poolKeyData.currency1}`);

    const poolState: PoolState = {
      id,
      tokenPair: { token0, token1, pairKey: `${token0.symbol}-${token1.symbol}` },
      dexName: this.name,
      dexType: this.type,
      routerAddress: this.routerAddress,
      // Metadata specific to V4 for key reconstruction
      meta: {
        tickSpacing: poolKeyData.tickSpacing,
        hooks: poolKeyData.hooks,
      },
      fee: poolKeyData.fee,

      sqrtPriceX96: 0n,
      tick: 0,
      liquidity: 0n,
      reserve0: 0n,
      reserve1: 0n,
      spotPrice0to1: 0,
      spotPrice1to0: 0,
      totalLiquidityInUSD: 0,
    };

    return poolState;
  }

  /**
   * Update pool state via Singleton PoolManager
   */
  async updatePool(pool: PoolState): Promise<PoolState> {
    const { token0, token1 } = pool.tokenPair;
    const poolKey = pool.id;

    // Call PoolManager for this specific ID
    const [slot0, liquidity] = await Promise.all([
      this.stateViewContract.getSlot0(poolKey),
      this.stateViewContract.getLiquidity(poolKey),
    ]);
    if (!slot0) throw new Error(`Failed to fetch slot0 for pool ID ${poolKey}`);

    const { reserve0, reserve1 } = calculateVirtualReserves(slot0.sqrtPriceX96, liquidity);

    pool.reserve0 = reserve0;
    pool.reserve1 = reserve1;
    pool.sqrtPriceX96 = slot0.sqrtPriceX96;
    pool.tick = Number(slot0.tick); // Convert BigInt to number for tick
    pool.liquidity = liquidity;

    pool.spotPrice0to1 = UniswapV4Adapter.calculateSpotPrice(slot0.sqrtPriceX96, token0, token1, true);
    pool.spotPrice1to0 = UniswapV4Adapter.calculateSpotPrice(slot0.sqrtPriceX96, token0, token1, false);

    return pool;
  }

  /**
   * ✅ FIXED: Sort tokens correctly
   */
  private sortTokens(tokenA: string, tokenB: string): [string, string] {
    const addrA = tokenA.toLowerCase();
    const addrB = tokenB.toLowerCase();
    return addrA < addrB ? [addrA, addrB] : [addrB, addrA];
  }

  // ================================================================================================
  // TRADING AND QUOTES
  // ================================================================================================

  /**
   * 💰 GET SPOT PRICE: Get current spot price from sqrtPriceX96
   */
  static calculateSpotPrice(sqrtPriceX96: bigint, token0: Token, token1: Token, zeroForOne: boolean): number {
    const price = sqrtPriceX96ToPrice(sqrtPriceX96, token0.decimals, token1.decimals);
    if (zeroForOne)
      return price; // Price of token0 in token1
    else return 1 / price; // Price of token1 in token0
  }

  /**
   * 💰 GET TRADE QUOTE: Calculate V4 trade quote
   */
  async getTradeQuote(poolState: PoolState, amountIn: bigint, zeroForOne: boolean): Promise<TradeQuote> {
    if (!this.quoterContract) throw new Error('Quoter contract not supported');
    const { token0, token1 } = poolState.tokenPair;

    // Ensure Key logic matches discovery
    const [currency0, currency1] =
      token0.address.toLowerCase() < token1.address.toLowerCase()
        ? [token0.address, token1.address]
        : [token1.address, token0.address];

    // Reconstruct Key Parameter
    const params = {
      currency0: currency0,
      currency1: currency1,
      fee: poolState.fee,
      tickSpacing: poolState.meta?.tickSpacing || 60,
      hooks: poolState.meta?.hooks || ethers.ZeroAddress,
      hookData: '0x', // Empty bytes
    };

    try {
      // V4 Quoter returns a tuple
      // quoteExactInputSingle(params, amountIn) returns (amountOut, ...)
      const result = await this.quoterContract.quoteExactInputSingle.staticCall(params, amountIn);

      const amountOut = result[0]; // first return value

      // Calculate execution metrics
      const spotPrice = poolState.spotPrice0to1!; // Base assumption
      const normalizedIn = parseFloat(ethers.formatUnits(amountIn, zeroForOne ? token0.decimals : token1.decimals));
      const normalizedOut = parseFloat(ethers.formatUnits(amountOut, zeroForOne ? token1.decimals : token0.decimals));

      const executionPrice = normalizedOut / normalizedIn;

      return {
        poolState,
        amountIn,
        amountOut,
        executionPrice,
        priceImpact: 0, // Simplified
        slippage: 0,
        confidence: 0.9,
      };
    } catch (e: any) {
      throw new Error(`V4 Quote failed: ${e.message}`);
    }
  }

  /**
   * 🧮 SIMULATE SWAP (Reusing V3 Math)
   * V4 calculation logic for standard pools is identical to V3's concentrated liquidity math.
   * However, hooks can alter this behavior. This assumes NO hooks affecting swap logic.
   */
  simulateSwap(poolState: PoolState, amountIn: bigint, zeroForOne: boolean): bigint {
    const sqrtPriceX96 = poolState.sqrtPriceX96!;
    const liquidity = poolState.liquidity!;

    // TBD: check how hooks affect swap calculations
    const hooks = poolState.meta?.hooks || ethers.ZeroAddress;
    if (hooks !== ethers.ZeroAddress) {
      this.logger.warn('⚠️ Pool uses hooks - simulation accuracy not guaranteed');
    }

    if (amountIn <= 0n) throw new Error(`Invalid trade amount: ${amountIn}`);
    if (liquidity <= 0n) throw new Error(`Insufficient liquidity`);

    // Fee calculations in V4 can be dynamic via hooks, but we assume static fee here
    const feePpm = BigInt(poolState.fee);
    const amountInAfterFee = (amountIn * (1_000_000n - feePpm)) / 1_000_000n;

    if (zeroForOne) {
      const sqrtPriceX96Next = getNextSqrtPriceFromAmount0RoundingUp(sqrtPriceX96, liquidity, amountInAfterFee, true);
      return getAmount1Delta(sqrtPriceX96Next, sqrtPriceX96, liquidity, false);
    } else {
      const sqrtPriceX96Next = getNextSqrtPriceFromAmount1RoundingDown(sqrtPriceX96, liquidity, amountInAfterFee, true);
      return getAmount0Delta(sqrtPriceX96, sqrtPriceX96Next, liquidity, false);
    }
  }

  /**
   * 💰 GET FEE PERCENT: Get V4 pool fee percentage
   */
  getFeePercent(poolState: PoolState): number {
    return Number(poolState.fee) / 10000; // Convert from basis points to percentage (3000 bps = 0.3%)
  }

  // ================================================================================================
  // EVENT HANDLING
  // ================================================================================================

  /**
   * 🔄 UPDATE POOL STATE FROM EVENT: Fast V4 state updates
   */
  updatePoolFromEvent(pool: PoolState, event: PoolEvent): PoolState {
    if (!event.sqrtPriceX96 || !event.liquidity) throw new Error(`❌ Invalid PoolEvent for: ${event.dexName} - ${event.poolId}`);
    pool.latestEventMeta = { ...event.meta };

    // virtual reserves are directly from event
    // V4 specific data from Swap event
    const { reserve0, reserve1 } = calculateVirtualReserves(event.sqrtPriceX96, event.liquidity); // virtual reserve0 and reserve1

    // Update V4 specific state if available
    pool.reserve0 = reserve0;
    pool.reserve1 = reserve1;
    pool.sqrtPriceX96 = event.sqrtPriceX96!;
    pool.tick = event.tick!;
    pool.liquidity = event.liquidity!;

    // Update derived fields
    const { token0, token1 } = pool.tokenPair;
    pool.spotPrice0to1 = UniswapV4Adapter.calculateSpotPrice(event.sqrtPriceX96, token0, token1, true);
    pool.spotPrice1to0 = UniswapV4Adapter.calculateSpotPrice(event.sqrtPriceX96, token0, token1, false);

    // calculate liquidityUSD (requires external price feed)
    try {
      // TODO: update this when implemented price oracle
      // const v0 = this.tokenManager.calculateUSDValue(pool.tokenPair.token0.address, pool.reserve0!) || 0;
      // const v1 = this.tokenManager.calculateUSDValue(pool.tokenPair.token1.address, pool.reserve1!) || 0;
      // pool.totalLiquidityInUSD = v0 + v1; // note: liquidity calculated from virtual reserves
    } catch (error) {
      // this.logger.warn(`❌ Failed to calculate USD liquidity for pool ${event.poolId}: ${(error as Error).message}`);
      pool.totalLiquidityInUSD = 0;
    }

    return pool;
  }

  // Example: Read pool's active tick
  async getTickBitmap(poolId: string, wordPos: number): Promise<bigint> {
    // Calculate storage slot for tick bitmap
    const slot = ethers.solidityPackedKeccak256(['bytes32', 'uint256'], [poolId, wordPos]);

    const value = await this.poolManagerContract.extsload(slot);
    return BigInt(value);
  }

  // ================================================================================================
  // V4 SPECIFIC HELPERS
  // ================================================================================================

  /**
   * Calculate V4 Pool ID from Key
   * Note: V4 Pool ID is keccak256 hash of the ABI-encoded PoolKey struct
   */
  private getPoolId(key: PoolKey): string {
    const abiCoder = AbiCoder.defaultAbiCoder();
    return ethers.keccak256(
      abiCoder.encode(
        ['address', 'address', 'uint24', 'int24', 'address'],
        [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
      ),
    );
  }

  /**
   * 🕷️ READ POOL STATE: Use extsload to read raw storage
   * Assumes _pools mapping is at Slot 0 and standard Struct layout
   */
  private async getPoolStateFromStorage(poolId: string): Promise<{ sqrtPriceX96: bigint; tick: number; liquidity: bigint }> {
    // 1. Calculate the base storage slot for this pool's struct in the mapping
    // mapping slot for key k is keccak256(abi.encode(k, padding_slot))
    // Assuming _pools is at slot 0
    const MAPPING_SLOT = 0;
    const abiCoder = AbiCoder.defaultAbiCoder();

    const baseSlotHash = ethers.keccak256(abiCoder.encode(['bytes32', 'uint256'], [poolId, MAPPING_SLOT]));
    const baseSlot = BigInt(baseSlotHash);

    // 2. Read Slot 0 (State.slot0)
    // Layout:
    // - sqrtPriceX96: bits 0-159 (160 bits)
    // - tick:         bits 160-183 (24 bits)
    // - protocolFee:  bits 184-207 (24 bits)
    // - lpFee:        bits 208-231 (24 bits)
    const slot0Bytes = await this.poolManagerContract.extsload(baseSlotHash);
    const slot0Val = BigInt(slot0Bytes);
    console.log(`Slot0 Raw Value: ${slot0Bytes.toString('hex')}`);

    const sqrtPriceX96 = slot0Val & ((1n << 160n) - 1n);

    // Extract Tick (24 bits signed)
    let tickVal = (slot0Val >> 160n) & 0xffffffn;
    // Handle int24 sign extension
    if (tickVal & 0x800000n) {
      tickVal = tickVal - 0x1000000n;
    }
    const tick = Number(tickVal);

    // 3. Read Slot 3 (State.liquidity)
    // Offset 0: slot0
    // Offset 1: feeGrowth0
    // Offset 2: feeGrowth1
    // Offset 3: liquidity
    const liquiditySlot = baseSlot + 3n;
    // Format as hex bytes32 for extsload
    const liquiditySlotHex = '0x' + liquiditySlot.toString(16).padStart(64, '0');

    const liquidityBytes = await this.poolManagerContract.extsload(liquiditySlotHex);
    const liquidityVal = BigInt(liquidityBytes);
    const liquidity = liquidityVal & ((1n << 128n) - 1n); // Mask 128 bits just in case

    return {
      sqrtPriceX96,
      tick,
      liquidity,
    };
  }
}
