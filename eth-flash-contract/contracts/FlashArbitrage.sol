// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {IERC20 as IERC20Z} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {IERC20} from '@balancer-labs/v2-interfaces/contracts/solidity-utils/openzeppelin/IERC20.sol';
import {IVault} from '@balancer-labs/v2-interfaces/contracts/vault/IVault.sol';
import {IAsset} from '@balancer-labs/v2-interfaces/contracts/vault/IAsset.sol';
import {IFlashLoanRecipient} from '@balancer-labs/v2-interfaces/contracts/vault/IFlashLoanRecipient.sol';
import {ISwapRouter} from '@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol';
import {IUniswapV2Router02} from '@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol';

// ============================================
// UNISWAP V4 INTERFACES
// ============================================

// Currency type for V4 (address(0) = native ETH)
type Currency is address;

library CurrencyLibrary {
  function balanceOf(Currency currency, address account) internal view returns (uint256) {
    if (Currency.unwrap(currency) == address(0)) {
      return account.balance;
    }
    return IERC20Z(Currency.unwrap(currency)).balanceOf(account);
  }
}

// Hook interface placeholder
interface IHooks {}

// PoolKey identifies a pool in V4
struct PoolKey {
  Currency currency0;
  Currency currency1;
  uint24 fee;
  int24 tickSpacing;
  IHooks hooks;
}

// Universal Router interface
interface IUniversalRouter {
  function execute(
    bytes calldata commands,
    bytes[] calldata inputs,
    uint256 deadline
  ) external payable;
}

// V4Router params
interface IV4Router {
  struct ExactInputSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    bytes hookData;
  }
}

// Commands library constants
library Commands {
  uint8 internal constant V4_SWAP = 0x10;
}

// Actions library constants
library Actions {
  uint8 internal constant SWAP_EXACT_IN_SINGLE = 0x06;
  uint8 internal constant SETTLE_ALL = 0x0c;
  uint8 internal constant TAKE_ALL = 0x0d;
}


// ============================================
// CURVE INTERFACES
// ============================================

// Standard Curve pool interface (works for most pools)
interface ICurvePool {
  function exchange(
    int128 i,
    int128 j,
    uint256 dx,
    uint256 min_dy
  ) external returns (uint256);
}

// Curve pool with uint256 indices (newer pools like tricrypto)
interface ICurvePoolUint {
  function exchange(
    uint256 i,
    uint256 j,
    uint256 dx,
    uint256 min_dy
  ) external returns (uint256);
}

// Curve pool with underlying tokens (metapools)
interface ICurvePoolUnderlying {
  function exchange_underlying(
    int128 i,
    int128 j,
    uint256 dx,
    uint256 min_dy
  ) external returns (uint256);
}

contract FlashArbitrage is IFlashLoanRecipient, ReentrancyGuard {
  using SafeERC20 for IERC20Z; // enables safeApprove, safeTransfer, etc.
  using CurrencyLibrary for Currency;
  
  address public owner;
  IVault private constant vault = IVault(0xBA12222222228d8Ba445958a75a0704d566BF2C8);

  // Allow receiving ETH for V4 native swaps
  receive() external payable {}

  event TradeExecuted(
    address indexed token,
    uint256 borrowAmount,
    uint256 profit
  );

  // DEX Protocol Types
  enum DexType {
    UNISWAP_V2, // 0
    UNISWAP_V3, // 1
    UNISWAP_V4, // 2
    CURVE, // 3
    BALANCER, // 4
    CUSTOM // 5 - for future protocols
  }

  struct SwapStep {
    DexType dexType;
    address router;
    address tokenIn;
    address tokenOut;
    uint256 amountIn;
    uint256 amountOutMin; // for slippage protection
    uint24 fee; // needed only for V3
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

  // main entry trade function
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

  /**
   * This function is called by the Balancer Vault after the flash loan is issued
   */
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
    emit TradeExecuted(
      address(tokens[0]),
      borrowAmount,
      profit
    );
  }

  // -- INTERNAL FUNCTIONS -- //

  // Universal swap execution
  function _executeSwap(SwapStep memory step) internal {
    IERC20Z(step.tokenIn).forceApprove(step.router, step.amountIn); // Safe Approve token to swap

    if (step.dexType == DexType.UNISWAP_V2) {
      _swapOnV2(step);
    } else if (step.dexType == DexType.UNISWAP_V3) {
      _swapOnV3(step);
    } else if (step.dexType == DexType.UNISWAP_V4) {
      _swapOnV4(step);
    } else if (step.dexType == DexType.CURVE) {
      _swapOnCurve(step);
    } else if (step.dexType == DexType.BALANCER) {
      _swapOnBalancer(step);
    } else {
      revert('Unsupported DEX type');
    }
  }

  // Uniswap V2 swap
  function _swapOnV2(SwapStep memory step) internal {
    address[] memory path = new address[](2);
    path[0] = step.tokenIn;
    path[1] = step.tokenOut;

    IUniswapV2Router02(step.router).swapExactTokensForTokens(
      step.amountIn,
      step.amountOutMin,
      path,
      address(this),
      block.timestamp + 300
    );
  }

  // Uniswap V3 swap
  function _swapOnV3(SwapStep memory step) internal {
    // Setup swap parameters
    ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
      tokenIn: step.tokenIn,
      tokenOut: step.tokenOut,
      fee: step.fee,
      recipient: address(this),
      deadline: block.timestamp + 300, // 5 minutes from now
      amountIn: step.amountIn,
      amountOutMinimum: step.amountOutMin,
      sqrtPriceLimitX96: 0
    });

    // Perform swap
    ISwapRouter(step.router).exactInputSingle(params);
  }

/**
   * @notice Execute a swap on Uniswap V4 using Universal Router
   * @dev V4 uses Universal Router pattern with commands and actions
   * 
   * Requirements:
   *      - step.router: Universal Router address
   *      - step.fee: Fee tier (500, 3000, 10000, etc.)
   *      - step.extraData: Encoded (int24 tickSpacing, address hooks, bytes hookData)
   */
  function _swapOnV4(SwapStep memory step) internal {
    // Decode V4 parameters from extraData
    (int24 tickSpacing, address hooks, bytes memory hookData) = _decodeV4Params(step.extraData);
    
    // Determine swap direction (currency0 < currency1 by address)
    bool zeroForOne = step.tokenIn < step.tokenOut;
    
    // Build PoolKey - currencies must be sorted
    PoolKey memory poolKey = PoolKey({
      currency0: Currency.wrap(zeroForOne ? step.tokenIn : step.tokenOut),
      currency1: Currency.wrap(zeroForOne ? step.tokenOut : step.tokenIn),
      fee: step.fee,
      tickSpacing: tickSpacing,
      hooks: IHooks(hooks)
    });

    // Encode the Universal Router command for V4 swap
    bytes memory commands = abi.encodePacked(uint8(Commands.V4_SWAP));

    // Encode V4Router actions sequence
    bytes memory actions = abi.encodePacked(
      uint8(Actions.SWAP_EXACT_IN_SINGLE),
      uint8(Actions.SETTLE_ALL),
      uint8(Actions.TAKE_ALL)
    );

    // Prepare parameters for each action
    bytes[] memory params = new bytes[](3);
    
    // Param 0: Swap configuration
    params[0] = abi.encode(
      IV4Router.ExactInputSingleParams({
        poolKey: poolKey,
        zeroForOne: zeroForOne,
        amountIn: uint128(step.amountIn),
        amountOutMinimum: uint128(step.amountOutMin),
        hookData: hookData
      })
    );
    
    // Param 1: SETTLE_ALL - specify input currency and amount
    params[1] = abi.encode(
      zeroForOne ? poolKey.currency0 : poolKey.currency1,
      step.amountIn
    );
    
    // Param 2: TAKE_ALL - specify output currency and minimum amount
    params[2] = abi.encode(
      zeroForOne ? poolKey.currency1 : poolKey.currency0,
      step.amountOutMin
    );

    // Combine actions and params into inputs array
    bytes[] memory inputs = new bytes[](1);
    inputs[0] = abi.encode(actions, params);

    // Execute via Universal Router
    uint256 deadline = block.timestamp + 300;
    IUniversalRouter(step.router).execute(commands, inputs, deadline);
  }

  /**
 * @notice Decode V4-specific parameters from extraData
 * @param extraData Encoded (int24 tickSpacing, address hooks, bytes hookData)
 * @return tickSpacing The tick spacing for the pool
 * @return hooks The hooks contract address (address(0) for no hooks)
 * @return hookData Additional data to pass to hooks
 */
function _decodeV4Params(bytes memory extraData) internal pure returns (
  int24 tickSpacing,
  address hooks,
  bytes memory hookData
) {

  // Default values for standard pools without hooks
  if (extraData.length == 0) {
    return (60, address(0), bytes(''));
  }
  
  // ABI encoded int24 takes 32 bytes, address takes 32 bytes = 64 bytes minimum
  if (extraData.length >= 64) {
    // Full decode: tickSpacing (int24) + hooks (address)
    (tickSpacing, hooks) = abi.decode(extraData, (int24, address));
    hookData = bytes('');
  } else if (extraData.length >= 32) {
    // Only tickSpacing provided (32 bytes for int24 in ABI encoding)
    (tickSpacing) = abi.decode(extraData, (int24));
    hooks = address(0);
    hookData = bytes('');
  } else {
    // Invalid extraData, use defaults
    return (60, address(0), bytes(''));
  }
}

  // ============================================
  // CURVE SWAP IMPLEMENTATION
  // ============================================
  
  /**
   * @notice Execute a swap on Curve
   * @dev Curve pools have different interfaces depending on the pool type:
   *      - Standard pools: int128 indices
   *      - Tricrypto/newer pools: uint256 indices
   *      - Metapools: exchange_underlying for underlying tokens
   * 
   * Use extraData to specify pool type:
   *      - 0x00 or empty: Standard pool (int128)
   *      - 0x01: Uint256 indices pool
   *      - 0x02: Underlying exchange (metapool)
   */
  function _swapOnCurve(SwapStep memory step) internal {
    // Determine pool type from extraData
    uint8 poolType = 0;
    if (step.extraData.length > 0) {
      poolType = uint8(step.extraData[0]);
    }

    if (poolType == 0) {
      // Standard Curve pool with int128 indices
      ICurvePool(step.router).exchange(
        step.curveIndexIn,
        step.curveIndexOut,
        step.amountIn,
        step.amountOutMin
      );
    } else if (poolType == 1) {
      // Newer pools with uint256 indices (tricrypto, etc.)
      ICurvePoolUint(step.router).exchange(
        uint256(int256(step.curveIndexIn)),
        uint256(int256(step.curveIndexOut)),
        step.amountIn,
        step.amountOutMin
      );
    } else if (poolType == 2) {
      // Metapool - exchange underlying tokens
      ICurvePoolUnderlying(step.router).exchange_underlying(
        step.curveIndexIn,
        step.curveIndexOut,
        step.amountIn,
        step.amountOutMin
      );
    } else {
      revert('Invalid Curve pool type');
    }
  }

  // ✅ NEW: Balancer V2 swap
  function _swapOnBalancer(SwapStep memory step) internal {
    IVault.SingleSwap memory singleSwap = IVault.SingleSwap({
      poolId: step.poolId,
      kind: IVault.SwapKind.GIVEN_IN,
      assetIn: IAsset(step.tokenIn),
      assetOut: IAsset(step.tokenOut),
      amount: step.amountIn,
      userData: step.extraData
    });

    IVault.FundManagement memory funds = IVault.FundManagement({
      sender: address(this),
      fromInternalBalance: false,
      recipient: payable(address(this)),
      toInternalBalance: false
    });

    IVault(step.router).swap(
      singleSwap,
      funds,
      step.amountOutMin,
      block.timestamp + 300
    );
  }

  /*
   * Emergency functions
   *
   */

  function emergencyWithdraw(address _token) external onlyOwner {
    uint256 balance = IERC20Z(_token).balanceOf(address(this));
    if (balance > 0) {
      IERC20Z(_token).safeTransfer(owner, balance); // Use SafeERC20
    }
  }

  function emergencyWithdrawETH() external onlyOwner {
  uint256 balance = address(this).balance;
  if (balance > 0) {
    (bool success, ) = owner.call{value: balance}('');
    require(success, 'ETH transfer failed');
  }
}

  function updateOwner(address _newOwner) external onlyOwner {
    require(_newOwner != address(0), 'Invalid address');
    owner = _newOwner;
  }
}
