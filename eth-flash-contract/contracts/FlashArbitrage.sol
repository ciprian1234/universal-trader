// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {IERC20 as IERC20Z} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {IERC20} from '@balancer-labs/v2-interfaces/contracts/solidity-utils/openzeppelin/IERC20.sol';
import {IVault} from '@balancer-labs/v2-interfaces/contracts/vault/IVault.sol';
import {IAsset} from '@balancer-labs/v2-interfaces/contracts/vault/IAsset.sol';
import {IFlashLoanRecipient} from '@balancer-labs/v2-interfaces/contracts/vault/IFlashLoanRecipient.sol';
// import 'hardhat/console.sol';

// ========================================================================================
// UNISWAP V2 INTERFACES
// ========================================================================================
interface IUniswapV2Pair {
  function swap(uint amount0Out, uint amount1Out, address to, bytes calldata data) external;
  function token0() external view returns (address);
  function token1() external view returns (address);
  function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
}

// ========================================================================================
// UNISWAP V3 INTERFACES
// ========================================================================================
interface IUniswapV3Pool {
  function swap(
    address recipient,
    bool zeroForOne,
    int256 amountSpecified,
    uint160 sqrtPriceLimitX96,
    bytes calldata data
  ) external returns (int256 amount0, int256 amount1);
}

// ========================================================================================
// UNISWAP V4 INTERFACES
// ========================================================================================
interface IPoolManager {
  struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
  }

  struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
  }

  function unlock(bytes calldata data) external returns (bytes memory);
  function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256 delta);
  function sync(address currency) external;
  function settle() external payable returns (uint256);
  function take(address currency, address to, uint256 amount) external;
}

// ============================================
// CURVE INTERFACES
// ============================================

// Standard Curve pool interface (works for most pools)
interface ICurvePool {
  function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) external returns (uint256);
}

// Curve pool with uint256 indices (newer pools like tricrypto)
interface ICurvePoolUint {
  function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) external returns (uint256);
}

// Curve pool with underlying tokens (metapools)
interface ICurvePoolUnderlying {
  function exchange_underlying(int128 i, int128 j, uint256 dx, uint256 min_dy) external returns (uint256);
}

contract FlashArbitrage is IFlashLoanRecipient, ReentrancyGuard {
  using SafeERC20 for IERC20Z; // enables safeApprove, safeTransfer, etc.
  // using CurrencyLibrary for Currency;

  address public owner;
  IVault private constant vault = IVault(0xBA12222222228d8Ba445958a75a0704d566BF2C8);

  // Allow receiving ETH for V4 native swaps
  receive() external payable {}

  // price limit for V3 swaps to prevent excessive slippage (set to min/max possible + small buffer)
  uint160 constant MIN_SQRT_RATIO = 4295128739;
  uint160 constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

  event TradeExecuted(address indexed token, uint256 borrowAmount, uint256 profit);

  // DEX Protocol Types
  enum DexProtocol {
    V2, // 0
    V3, // 1
    V4, // 2
    CURVE, // 3
    BALANCER, // 4
    CUSTOM // 5 - for future protocols
  }

  struct SwapStep {
    DexProtocol dexProtocol;
    address poolAddress;
    address tokenIn;
    address tokenOut;
    uint256 amountIn;
    uint256 amountOutMin; // for slippage protection
    uint24 feeBps; // for v2 usually 30 (0.3%), for v3 it represents the fee tier (500, 3000, 10000)
    bool zeroForOne; // indicates swap direction
    bytes32 poolId; // For V4/Balancer pool identification
    int128 curveIndexIn; // For Curve token index
    int128 curveIndexOut; // For Curve token index
    bytes extraData; // For custom/future protocols (For V4: encoded (int24 tickSpacing, address hooks))
  }

  struct Trade {
    SwapStep[] swaps; // Array of swaps for multi-hop trading
  }

  constructor() {
    owner = msg.sender;
  }

  // access control modifier
  modifier onlyOwner() {
    require(msg.sender == owner, 'Not owner');
    _;
  }

  // ========================================================================================
  // UNISWAP V4 INTERFACES
  // ========================================================================================

  // storage slot for allowed callback caller (used to guard against malicious calls to callbacks)
  int256 private constant ALLOWED_CALLER_ADDRESS_SLOT = 0; // first slot in contract storage

  function _setAllowedCallerAddress(address allowedCallerAddress) private {
    assembly {
      tstore(ALLOWED_CALLER_ADDRESS_SLOT, allowedCallerAddress)
    }
  }
  function _getAllowedCallerAddress() private view returns (address allowedCallerAddress) {
    assembly {
      allowedCallerAddress := tload(ALLOWED_CALLER_ADDRESS_SLOT)
    }
  }

  // ========================================================================================
  // ENTRY POINT FOR EXECUTING AN ARBITRAGE TRADE
  // ========================================================================================
  function executeTrade(Trade memory _trade) external onlyOwner nonReentrant {
    // Encode the trade struct to pass it to the flash loan callback
    bytes memory data = abi.encode(_trade);

    // Flash loan setup
    IERC20[] memory tokens = new IERC20[](1);
    tokens[0] = IERC20(_trade.swaps[0].tokenIn); // The token we will borrow

    uint256[] memory amounts = new uint256[](1);
    amounts[0] = _trade.swaps[0].amountIn; // The amount we will borrow

    vault.flashLoan(this, tokens, amounts, data);
  }

  // ========================================================================================
  // DIRECT SWAP EXECUTION (FOR TESTING — REQUIRES CONTRACT TO HOLD tokenIn BEFOREHAND)
  // ========================================================================================
  function executeDirectSwap(SwapStep memory step) external onlyOwner nonReentrant {
    _executeSwap(step);
  }

  // ========================================================================================
  // FLASH LOAN CALLBACK - THIS FUNCTION IS CALLED BY THE BALANCER VAULT AFTER LOANING THE FUNDS
  // ========================================================================================
  function receiveFlashLoan(
    IERC20[] memory tokens,
    uint256[] memory amounts,
    uint256[] memory feeAmounts,
    bytes memory userData
  ) external override {
    require(msg.sender == address(vault), 'Invalid caller'); // ensure caller its balancer vault

    Trade memory trade = abi.decode(userData, (Trade)); // Decode our swap data so we can use it
    uint256 swapsLength = trade.swaps.length;
    uint256 borrowAmount = amounts[0];
    uint256 borrowFee = feeAmounts[0];
    uint256 requiredRepayment = borrowAmount + borrowFee;

    // NOTE: amountOutMin its enforced for each swap outside the contract by caller
    // on last swap the profit should be > requiredRepayment, otherwise the tx will revert
    for (uint256 i = 0; i < swapsLength; i++) {
      SwapStep memory step = trade.swaps[i];

      // For intermediate swaps, use full balance
      if (i > 0) {
        step.amountIn = IERC20Z(step.tokenIn).balanceOf(address(this));
      }

      // Execute the swap
      _executeSwap(step);
    }

    // Repay flash loan
    IERC20Z(address(tokens[0])).safeTransfer(address(vault), requiredRepayment);

    // Transfer profits to owner
    uint256 profit = IERC20Z(address(tokens[0])).balanceOf(address(this));
    if (profit > 0) {
      IERC20Z(address(tokens[0])).safeTransfer(owner, profit);
    }

    // Emit event
    emit TradeExecuted(address(tokens[0]), borrowAmount, profit);
  }

  // ========================================================================================
  // SWAP EXECUTION ROUTING BASED ON DEX PROTOCOL
  // ========================================================================================
  function _executeSwap(SwapStep memory step) internal {
    if (step.dexProtocol == DexProtocol.V2) {
      _swapOnV2(step);
    } else if (step.dexProtocol == DexProtocol.V3) {
      _swapOnV3(step);
    } else if (step.dexProtocol == DexProtocol.V4) {
      _swapOnV4(step);
    } else if (step.dexProtocol == DexProtocol.CURVE) {
      _swapOnCurve(step);
    } else if (step.dexProtocol == DexProtocol.BALANCER) {
      _swapOnBalancer(step);
    } else {
      revert('Unsupported DEX type');
    }
  }

  // ========================================================================================
  // V2 SWAP IMPLEMENTATION
  // ========================================================================================
  function _swapOnV2(SwapStep memory step) internal {
    IUniswapV2Pair pair = IUniswapV2Pair(step.poolAddress);

    // Transfer tokens directly to pool — V2 pull model
    IERC20Z(step.tokenIn).safeTransfer(address(pair), step.amountIn);

    // get reserves to calculate amountOut based on constant product formula: x * y = k
    (uint112 reserve0, uint112 reserve1, ) = pair.getReserves();
    uint256 reserveIn = step.zeroForOne ? uint256(reserve0) : uint256(reserve1);
    uint256 reserveOut = step.zeroForOne ? uint256(reserve1) : uint256(reserve0);

    // calculate amountOut
    uint256 amountInWithFee = step.amountIn * (10000 - step.feeBps);
    uint256 amountOut = (amountInWithFee * reserveOut) / (reserveIn * 10000 + amountInWithFee);
    require(amountOut >= step.amountOutMin, 'V2: insufficient amountOut');

    (uint256 amount0Out, uint256 amount1Out) = step.zeroForOne ? (uint256(0), amountOut) : (amountOut, uint256(0));
    pair.swap(amount0Out, amount1Out, address(this), new bytes(0));
  }

  // ========================================================================================
  // V3 SWAP IMPLEMENTATION
  // ========================================================================================

  function _swapOnV3(SwapStep memory step) internal {
    require(step.amountIn <= uint256(type(int256).max), 'V3: amountIn overflow');
    _setAllowedCallerAddress(step.poolAddress); // set allowed callback caller to the pool we're interacting with

    IUniswapV3Pool pool = IUniswapV3Pool(step.poolAddress);
    uint160 sqrtPriceLimitX96 = step.zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1; // TBD: send this as parameter

    // V3 uses a callback to pull tokens, so we just call swap and handle the token transfer in the callback
    (int256 amount0, int256 amount1) = pool.swap(
      address(this),
      step.zeroForOne,
      int256(step.amountIn),
      sqrtPriceLimitX96, // Price limit for slippage control
      abi.encode(step.tokenIn) // Pass the encoded callback data
    );

    // validate amountOut based on swap direction (amounts are returned as int256, positive for received, negative for sent)
    uint256 amountOut = uint256(-(step.zeroForOne ? amount1 : amount0));
    require(amountOut >= step.amountOutMin, 'V3: insufficient amountOut');
    _setAllowedCallerAddress(address(0)); // ← clear transient slot before returning
  }

  // Generic callback by V3 pool during swap() to pull the owed tokens
  // NOTE: this callback its called inside the swap execution synchronously
  function _handleV3Callback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) internal {
    require(msg.sender == _getAllowedCallerAddress(), 'V3: invalid callback caller');
    address tokenIn = abi.decode(data, (address));

    // Determine the amount owed and transfer it to the pool
    uint256 amountOwed;
    if (amount0Delta > 0) {
      amountOwed = uint256(amount0Delta);
    } else {
      require(amount1Delta > 0, 'V3: both deltas non-positive');
      amountOwed = uint256(amount1Delta);
    }

    IERC20Z(tokenIn).safeTransfer(msg.sender, amountOwed);
  }

  // different DEXes might have different callback function signatures => so we route them to the same _handleV3Callback handler

  // Uniswap V3 and compatible forks (SushiSwap Trident, etc.)
  function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
    _handleV3Callback(amount0Delta, amount1Delta, data);
  }

  // Algebra-based pools (QuickSwap, Camelot, etc.)
  function algebraSwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
    _handleV3Callback(amount0Delta, amount1Delta, data);
  }

  // Other V3-compatible pools can also use the same callback handler as long as they call it with the same parameters
  function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
    _handleV3Callback(amount0Delta, amount1Delta, data);
  }

  // ========================================================================================
  // V4 SWAP IMPLEMENTATION
  // ========================================================================================

  function _swapOnV4(SwapStep memory step) internal {
    require(step.amountIn <= uint256(type(int256).max), 'V4: amountIn overflow');
    _setAllowedCallerAddress(step.poolAddress); // set allowed callback caller to the PoolManager address

    bytes memory result = IPoolManager(step.poolAddress).unlock(abi.encode(step));

    uint256 amountOut = abi.decode(result, (uint256));
    require(amountOut >= step.amountOutMin, 'V4: insufficient amountOut');
    _setAllowedCallerAddress(address(0)); // ← clear transient slot before returning
  }

  // called by V4 PoolManager during unlock() to execute the swap logic and handle token transfers
  function unlockCallback(bytes calldata data) external returns (bytes memory) {
    require(msg.sender == _getAllowedCallerAddress(), 'V4: invalid callback caller');

    SwapStep memory step = abi.decode(data, (SwapStep));

    // Decode tickSpacing and hooks from extraData
    (int24 tickSpacing, address hooks) = abi.decode(step.extraData, (int24, address));

    // Sort currencies for PoolKey (V4 requires currency0 < currency1)
    (address currency0, address currency1) = step.tokenIn < step.tokenOut
      ? (step.tokenIn, step.tokenOut)
      : (step.tokenOut, step.tokenIn);

    IPoolManager.PoolKey memory key = IPoolManager.PoolKey({
      currency0: currency0,
      currency1: currency1,
      fee: step.feeBps,
      tickSpacing: tickSpacing,
      hooks: hooks
    });

    IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
      zeroForOne: step.zeroForOne,
      amountSpecified: -int256(step.amountIn), // negative = exact input
      sqrtPriceLimitX96: step.zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1
    });

    // Execute swap — returns BalanceDelta packed as int256
    // Upper 128 bits = amount0 delta, Lower 128 bits = amount1 delta
    // Negative delta = we owe, Positive delta = we receive
    int256 delta = IPoolManager(msg.sender).swap(key, params, ''); // TBD: provide hook data if needed for custom logic during swap
    int128 delta0 = int128(delta >> 128);
    int128 delta1 = int128(delta);

    // Settle negative deltas (pay what we owe): sync → transfer → settle
    if (delta0 < 0) {
      uint256 payment = uint256(uint128(-delta0));
      if (currency0 == address(0)) {
        IPoolManager(msg.sender).settle{value: payment}();
      } else {
        IPoolManager(msg.sender).sync(currency0);
        IERC20Z(currency0).safeTransfer(msg.sender, payment);
        IPoolManager(msg.sender).settle();
      }
    }
    if (delta1 < 0) {
      uint256 payment = uint256(uint128(-delta1));
      if (currency1 == address(0)) {
        IPoolManager(msg.sender).settle{value: payment}();
      } else {
        IPoolManager(msg.sender).sync(currency1);
        IERC20Z(currency1).safeTransfer(msg.sender, payment);
        IPoolManager(msg.sender).settle();
      }
    }

    // Take positive deltas (receive what we're owed)
    uint256 amountOut;
    if (delta0 > 0) {
      amountOut = uint256(uint128(delta0));
      IPoolManager(msg.sender).take(currency0, address(this), amountOut);
    }
    if (delta1 > 0) {
      amountOut = uint256(uint128(delta1));
      IPoolManager(msg.sender).take(currency1, address(this), amountOut);
    }

    return abi.encode(amountOut);
  }

  // ========================================================================================
  // CURVE SWAP IMPLEMENTATION
  // ========================================================================================
  function _swapOnCurve(SwapStep memory step) internal {
    // IERC20Z(step.tokenIn).forceApprove(step.poolAddress, step.amountIn); // Safe Approve token to swap
  }

  // ========================================================================================
  // BALANCER SWAP IMPLEMENTATION
  // ========================================================================================
  function _swapOnBalancer(SwapStep memory step) internal {
    // IERC20Z(step.tokenIn).forceApprove(step.poolAddress, step.amountIn); // Safe Approve token to swap
  }

  // ========================================================================================
  // EMERGENCY FUNCTIONS
  // ========================================================================================
  function emergencyWithdraw(address _token) external onlyOwner {
    if (_token == address(0)) {
      // Withdraw ETH
      uint256 balance = address(this).balance;
      if (balance > 0) {
        (bool success, ) = owner.call{value: balance}('');
        require(success, 'ETH transfer failed');
      }
    } else {
      // Withdraw ERC20 token
      uint256 balance = IERC20Z(_token).balanceOf(address(this));
      if (balance > 0) {
        IERC20Z(_token).safeTransfer(owner, balance);
      }
    }
  }

  function updateOwner(address _newOwner) external onlyOwner {
    require(_newOwner != address(0), 'Invalid address');
    owner = _newOwner;
  }
}
