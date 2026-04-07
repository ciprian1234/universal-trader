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
// WETH INTERFACES
// ========================================================================================
interface IWETH {
  function deposit() external payable;
  function withdraw(uint256) external;
}

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

// ========================================================================================
// CURVE INTERFACES
// ========================================================================================

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
  address private constant WETH_ADDRESS = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
  IVault private constant vault = IVault(0xBA12222222228d8Ba445958a75a0704d566BF2C8);

  // Allow receiving ETH for V4 native swaps
  receive() external payable {}

  // price limit for V3 swaps to prevent excessive slippage (set to min/max possible + small buffer)
  uint160 constant MIN_SQRT_RATIO = 4295128739;
  uint160 constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

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
    address[] poolTokens; // for v2/v3/v4: [token0, token1], for balancer: [token0, token1, token2, ...]
    address tokenIn;
    address tokenOut;
    int256 amountSpecified; // computed for each swap type based on amountIn
    uint256 amountOutMin; // optional param we can specify on each swap for price impact protection
    uint24 poolFee; // for v2 its: 30 (0.3%), for v3 it represents the fee tier (100, 500, 3000, 10000) or custom for v4
    bytes extraData; // used by V4 and other protocols to pass additional parameters like pool keys, hook data, etc.
  }

  struct Trade {
    SwapStep[] swaps; // Array of swaps for multi-hop trading
    address borrowToken; // token to borrow in flash loan
    uint256 borrowAmount; // amount to borrow in flash loan
    uint16 internalBribeBps; // bribe paid from profit in basis points (bps 0-10000), set 0 if handled via ETH transfer
    uint256 minProfitTokenOut; // minimum profit threshold to execute the trade (in raw amount of tokenOut from last swap)
  }

  // error types
  error NotAuthorized(address caller);
  error InvalidAddress(address addr);
  error InvalidCaller(address caller);
  error TransferFailed(address to, address token, uint256 amount);
  error OverflowError(uint16 location, uint256 amount);
  error InvalidDexProtocol(uint256 protocol);
  error InvalidDeltasV3(int256 delta0, int256 delta1);
  error InsufficientLiquidity(uint256 reserve, uint256 amount);
  error InsufficientAmountOut(address token, uint256 minimum, uint256 actual);
  error LoanRepaymentNotMet(address token, uint256 amount, uint256 actualBalance);
  error MinProfitNotMet(address token, uint256 minProfit, uint256 actualBalance);
  error SwapStepFailed(uint256 stepIndex, bytes reason); // used only for simulation to identify which swap step failed

  constructor() {
    owner = msg.sender;
  }

  // access control modifier
  modifier onlyOwner() {
    if (msg.sender != owner) revert NotAuthorized(msg.sender);
    _;
  }

  // ========================================================================================
  // TRANSIENT STORAGE MANAGEMENT
  // ========================================================================================

  // SLOT 0: allowed callback caller (used to guard against malicious calls to callbacks)
  int256 private constant ALLOWED_CALLER_ADDRESS_SLOT = 0; // first slot in transient storage

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

  // SLOT 1: simulation mode flag
  int256 private constant SIMULATION_MODE_SLOT = 1; // slot 0 is already taken by ALLOWED_CALLER_ADDRESS_SLOT

  function _setSimulationMode(bool enabled) private {
    assembly {
      tstore(SIMULATION_MODE_SLOT, enabled)
    }
  }
  function _isSimulationMode() private view returns (bool enabled) {
    assembly {
      enabled := tload(SIMULATION_MODE_SLOT)
    }
  }

  // ========================================================================================
  // DIRECT SWAP EXECUTION (FOR TESTING — REQUIRES CONTRACT TO HOLD tokenIn BEFOREHAND)
  // ========================================================================================
  function executeDirectSwap(SwapStep memory step) external onlyOwner nonReentrant returns (uint256) {
    return _executeSwap(step);
  }

  /// @notice Public wrapper around _executeSwap, callable only via self-call (this._executeSwapInSimulation)
  /// @dev Enables try/catch on swap steps during simulation
  function _executeSwapInSimulation(SwapStep memory step) public returns (uint256) {
    if (msg.sender != address(this)) revert InvalidCaller(msg.sender);
    return _executeSwap(step);
  }

  // ========================================================================================
  // ENTRY POINT FOR EXECUTING AN ARBITRAGE TRADE
  // ========================================================================================
  function executeTrade(Trade memory trade) external payable onlyOwner nonReentrant {
    // if ETH sent => pay external bribe from msg.value BEFORE flash loan
    // (if arb reverts, entire tx reverts — bribe is always atomic)
    if (msg.value > 0) {
      (bool okBribe, ) = block.coinbase.call{value: msg.value}('');
      if (!okBribe) revert TransferFailed(block.coinbase, address(0), msg.value);
    }

    // Encode the trade struct to pass it to the flash loan callback
    bytes memory data = abi.encode(trade);

    // Flash loan setup
    IERC20[] memory tokens = new IERC20[](1);
    uint256[] memory amounts = new uint256[](1);
    tokens[0] = IERC20(trade.borrowToken); // The token we will borrow
    amounts[0] = trade.borrowAmount; // The amount we will borrow

    // Initiate flash loan from Balancer Vault
    // => this will trigger a callback to receiveFlashLoan() where we execute our arbitrage logic
    vault.flashLoan(this, tokens, amounts, data);
    _handleProfit(trade); //  profit handled here after flash loan repayment
  }

  // ========================================================================================
  // FLASH LOAN CALLBACK - THIS FUNCTION IS CALLED BY THE BALANCER VAULT AFTER LOANING THE FUNDS
  // ========================================================================================
  function receiveFlashLoan(
    IERC20[] memory tokens,
    uint256[] memory amounts,
    uint256[] memory feeAmounts,
    bytes memory callbackData
  ) external override {
    if (msg.sender != address(vault)) revert InvalidCaller(msg.sender); // ensure caller its balancer vault

    Trade memory trade = abi.decode(callbackData, (Trade)); // Decode our swap data so we can use it
    address borrowToken = address(tokens[0]);
    uint256 requiredRepayment = amounts[0] + feeAmounts[0];
    uint256 lastIndex = trade.swaps.length - 1;

    // execute each swap in sequence, using the output of the previous swap as the input for the next
    bool isSimulation = _isSimulationMode();
    for (uint256 i = 0; i <= lastIndex; i++) {
      if (isSimulation) {
        try this._executeSwapInSimulation(trade.swaps[i]) {} catch (bytes memory reason) {
          revert SwapStepFailed(i, reason);
        }
      } else {
        _executeSwap(trade.swaps[i]); // Execute the swap
      }
    }

    // NOTE: at this point we can have profit in either ETH, WETH or some ERC20 token
    // depending on the last swap output — we will handle repayment and profit transfer accordingly
    // entire output its in tokenOut of last swap
    address lastSwapTokenOut = trade.swaps[lastIndex].tokenOut;
    uint256 lastSwapTokenOutBalance = lastSwapTokenOut == address(0)
      ? address(this).balance
      : IERC20Z(lastSwapTokenOut).balanceOf(address(this));

    // ######################### REPAY FLASH LOAN #########################
    if (lastSwapTokenOutBalance < requiredRepayment)
      revert LoanRepaymentNotMet(lastSwapTokenOut, requiredRepayment, lastSwapTokenOutBalance);
    if (lastSwapTokenOut == address(0)) IWETH(WETH_ADDRESS).deposit{value: requiredRepayment}(); // (WRAP ETH)

    // Repay flash loan (borrowToken is always ERC20)
    IERC20Z(borrowToken).safeTransfer(address(vault), requiredRepayment);
  }

  // ========================================================================================
  // HANDLE PROFIT FUNCTION (EXECUTED AFTER FLASH LOAN REPAYMENT)
  // ========================================================================================
  function _handleProfit(Trade memory trade) internal {
    address lastSwapTokenOut = trade.swaps[trade.swaps.length - 1].tokenOut;
    uint256 profitBalance = lastSwapTokenOut == address(0)
      ? address(this).balance
      : IERC20Z(lastSwapTokenOut).balanceOf(address(this));

    // validate that profit meets minimum threshold before proceeding with profit transfer and bribe payment (if applicable)
    if (profitBalance < trade.minProfitTokenOut) revert MinProfitNotMet(lastSwapTokenOut, trade.minProfitTokenOut, profitBalance);

    if (lastSwapTokenOut == WETH_ADDRESS || lastSwapTokenOut == address(0)) {
      if (lastSwapTokenOut == WETH_ADDRESS) IWETH(WETH_ADDRESS).withdraw(profitBalance); // (UNWRAP WETH => ETH)

      // if internalBribeBps its set => pay direct bribe in ETH
      if (trade.internalBribeBps > 0) {
        uint256 bribeAmount = (profitBalance * trade.internalBribeBps) / 10000;
        (bool okBribe, ) = block.coinbase.call{value: bribeAmount}('');
        if (!okBribe) revert TransferFailed(block.coinbase, address(0), bribeAmount);
      }

      // transfer remaining ETH to owner
      uint256 ethRemaining = address(this).balance;
      (bool okProfit, ) = owner.call{value: ethRemaining}('');
      if (!okProfit) revert TransferFailed(owner, address(0), ethRemaining);
    } else {
      // CASE 2: profit in ERC20 token => transfer profit to owner
      IERC20Z(lastSwapTokenOut).safeTransfer(owner, profitBalance);
    }
  }

  // ========================================================================================
  // RESOLVE TOKEN_IN AND RETURN AVAILABLE AMOUNT_IN FOR THE SWAP
  // ========================================================================================
  function _resolveTokenIn(SwapStep memory step) internal returns (uint256) {
    address tokenIn = step.tokenIn;

    // in case "tokenIn" its ETH/WETH (handle wrapping or unwrapping)
    if (tokenIn == address(0)) {
      uint256 wethBalance = IERC20Z(WETH_ADDRESS).balanceOf(address(this));
      if (wethBalance > 0) IWETH(WETH_ADDRESS).withdraw(wethBalance); // UNWRAP WETH => ETH
      return address(this).balance; // return "amountIn" of raw ETH available for swap input
    } else if (tokenIn == WETH_ADDRESS) {
      uint256 nativeEthBalance = address(this).balance;
      if (nativeEthBalance > 0) IWETH(WETH_ADDRESS).deposit{value: nativeEthBalance}(); // WRAP ETH => WETH
    }

    return IERC20Z(tokenIn).balanceOf(address(this)); // return "amountIn" of ERC20 balance for swap input
  }

  // ========================================================================================
  // SWAP EXECUTION ROUTING BASED ON DEX PROTOCOL
  // ========================================================================================
  function _executeSwap(SwapStep memory step) internal returns (uint256 amountOut) {
    uint256 amountIn = _resolveTokenIn(step); // NOTE: this its positive balance available for swap
    if (amountIn > uint256(type(int256).max)) revert OverflowError(1, amountIn);

    if (step.dexProtocol == DexProtocol.V2) {
      step.amountSpecified = int256(amountIn); // specify exact X amount of tokenIn for V2 swap (must be POSITIVE on V2 formula)
      amountOut = _swapOnV2(step);
    } else if (step.dexProtocol == DexProtocol.V3) {
      step.amountSpecified = int256(amountIn); // specify exact X amount of tokenIn for V3 swap (must be POSITIVE to indicate exact input in V3)
      amountOut = _swapOnV3(step);
    } else if (step.dexProtocol == DexProtocol.V4) {
      step.amountSpecified = -int256(amountIn); // specify exact X amount of tokenIn for V4 swap (must be NEGATIVE to indicate exact input in V4)
      amountOut = _swapOnV4(step);
    } else revert InvalidDexProtocol(uint256(step.dexProtocol));

    if (amountOut < step.amountOutMin) revert InsufficientAmountOut(step.tokenOut, step.amountOutMin, amountOut);
    return amountOut;
  }

  // ========================================================================================
  // V2 SWAP IMPLEMENTATION
  // ========================================================================================
  function _swapOnV2(SwapStep memory step) internal returns (uint256) {
    IUniswapV2Pair pair = IUniswapV2Pair(step.poolAddress);

    // get reserves to calculate amountOut based on constant product formula: x * y = k
    (uint112 reserve0, uint112 reserve1, ) = pair.getReserves();
    bool zeroForOne = step.poolTokens[0] == step.tokenIn; // determine swap direction based on tokenIn
    uint256 reserveIn = zeroForOne ? uint256(reserve0) : uint256(reserve1);
    uint256 reserveOut = zeroForOne ? uint256(reserve1) : uint256(reserve0);

    // V2 formula with fee: amountOut = (amountIn * (10000 - fee) * reserveOut) / (reserveIn * 10000 + amountIn * (10000 - fee))
    uint256 amountIn = uint256(step.amountSpecified); // this must be positive to indicate exact input for V2 formula
    uint256 amountInWithFee = amountIn * (10000 - step.poolFee);
    uint256 amountOut = (amountInWithFee * reserveOut) / (reserveIn * 10000 + amountInWithFee);

    // sanity check to prevent swaps that would fail due to insufficient liquidity (e.g. if amountOut >= reserveOut, the swap will fail)
    if (amountOut >= reserveOut) revert InsufficientLiquidity(reserveOut, amountOut);

    // Transfer tokens directly to pool — V2 pull model
    IERC20Z(step.tokenIn).safeTransfer(address(pair), amountIn);
    (uint256 amount0Out, uint256 amount1Out) = zeroForOne ? (uint256(0), amountOut) : (amountOut, uint256(0));
    pair.swap(amount0Out, amount1Out, address(this), '');
    return amountOut;
  }

  // ========================================================================================
  // V3 SWAP IMPLEMENTATION
  // ========================================================================================

  function _swapOnV3(SwapStep memory step) internal returns (uint256) {
    IUniswapV3Pool pool = IUniswapV3Pool(step.poolAddress);
    bool zeroForOne = step.poolTokens[0] == step.tokenIn; // determine swap direction based on tokenIn
    uint160 sqrtPriceLimitX96 = zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1; // TBD: send this as parameter

    // trigger v3 swap via pool's swap() function, passing the tokenIn in the callback data so we know which token to transfer in the callback
    _setAllowedCallerAddress(step.poolAddress); // ← set allowed caller transient slot
    (int256 amount0, int256 amount1) = pool.swap(
      address(this),
      zeroForOne,
      step.amountSpecified, // NOTE: spending exact X tokenIn (specifiedAmount must be positive to indicate exact input in V3)
      sqrtPriceLimitX96, // Price limit for slippage control
      abi.encode(step.tokenIn) // Pass the encoded callback data
    );
    _setAllowedCallerAddress(address(0)); // ← clear transient slot after swap

    // validate amountOut based on swap direction (amounts are returned as int256, positive for received, negative for sent)
    uint256 amountOut = uint256(-(zeroForOne ? amount1 : amount0));
    return amountOut;
  }

  // Generic callback by V3 pool during swap() to pull the owed tokens
  // NOTE: this callback its called inside the swap execution synchronously
  function _handleV3Callback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) internal {
    if (msg.sender != _getAllowedCallerAddress()) revert InvalidCaller(msg.sender);
    address tokenIn = abi.decode(data, (address));

    // Determine the amount owed and transfer it to the pool
    uint256 amountOwed;
    if (amount0Delta > 0) {
      amountOwed = uint256(amount0Delta);
    } else {
      if (amount1Delta <= 0) revert InvalidDeltasV3(amount0Delta, amount1Delta);
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

  function _swapOnV4(SwapStep memory step) internal returns (uint256) {
    // trigger v4 swap via PoolManager's unlock() function, passing the SwapStep as callback data
    _setAllowedCallerAddress(step.poolAddress); // set allowed callback caller to the PoolManager address
    bytes memory result = IPoolManager(step.poolAddress).unlock(abi.encode(step));
    _setAllowedCallerAddress(address(0)); // ← clear transient slot before returning

    uint256 amountOut = abi.decode(result, (uint256));
    return amountOut;
  }

  // called by V4 PoolManager during unlock() to execute the swap logic and handle token transfers
  function unlockCallback(bytes calldata data) external returns (bytes memory) {
    if (msg.sender != _getAllowedCallerAddress()) revert InvalidCaller(msg.sender);

    SwapStep memory step = abi.decode(data, (SwapStep));
    bool zeroForOne = step.poolTokens[0] == step.tokenIn; // determine swap direction based on tokenIn

    // Decode and use original pool currencies for PoolKey (not step.tokenIn/tokenOut which are normalized WETH)
    address currency0 = step.poolTokens[0];
    address currency1 = step.poolTokens[1];
    (address hooks, int24 tickSpacing) = abi.decode(step.extraData, (address, int24));

    IPoolManager.PoolKey memory key = IPoolManager.PoolKey({
      currency0: currency0,
      currency1: currency1,
      fee: step.poolFee,
      tickSpacing: tickSpacing,
      hooks: hooks
    });

    IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
      zeroForOne: zeroForOne,
      amountSpecified: step.amountSpecified, // NOTE: if negative => spending exact X tokenIn, if positive => receiving exact X tokenOut
      sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1
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
  // function _swapOnCurve(SwapStep memory step) internal returns (uint256 amountOut) {
  //   amountOut = 0;
  //   return amountOut;
  //   // IERC20Z(step.tokenIn).forceApprove(step.poolAddress, step.amountIn); // Safe Approve token to swap
  // }

  // ========================================================================================
  // BALANCER SWAP IMPLEMENTATION
  // ========================================================================================
  // function _swapOnBalancer(SwapStep memory step) internal returns (uint256 amountOut) {
  //   amountOut = 0;
  //   return amountOut;
  //   // IERC20Z(step.tokenIn).forceApprove(step.poolAddress, step.amountIn); // Safe Approve token to swap
  // }

  // ========================================================================================
  // EMERGENCY FUNCTIONS
  // ========================================================================================
  function emergencyWithdraw(address _token) external onlyOwner {
    if (_token == address(0)) {
      // Withdraw ETH
      uint256 balance = address(this).balance;
      if (balance > 0) {
        (bool ok, ) = owner.call{value: balance}('');
        if (!ok) revert TransferFailed(owner, address(0), balance);
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
    if (_newOwner == address(0)) revert InvalidAddress(_newOwner);
    owner = _newOwner;
  }

  // ========================================================================================
  // SIMULATULATION HELPERS (NOT USED IN PRODUCTION, ONLY FOR TESTING AND SIMULATION PURPOSES)
  // ========================================================================================
  error SimulationSuccess(uint256 profitOut);
  error SimulationError(bytes reason);

  function simulateTrade(Trade memory trade) external {
    _setSimulationMode(true); // enable step-level try/catch in receiveFlashLoan

    // Encode the trade struct to pass it to the flash loan callback
    bytes memory data = abi.encode(trade);

    // Flash loan setup
    IERC20[] memory tokens = new IERC20[](1);
    uint256[] memory amounts = new uint256[](1);
    tokens[0] = IERC20(trade.borrowToken);
    amounts[0] = trade.borrowAmount;

    try vault.flashLoan(this, tokens, amounts, data) {
      // get balance of tokenOut from last swap to return as result of simulation
      address lastSwapTokenOut = trade.swaps[trade.swaps.length - 1].tokenOut;
      uint256 profitBalance = lastSwapTokenOut == address(0)
        ? address(this).balance
        : IERC20Z(lastSwapTokenOut).balanceOf(address(this));

      if (profitBalance < trade.minProfitTokenOut) {
        revert MinProfitNotMet(lastSwapTokenOut, trade.minProfitTokenOut, profitBalance);
      }
      revert SimulationSuccess(profitBalance); // => profit after loan repayment
    } catch (bytes memory err) {
      revert SimulationError(err);
    }
  }
}
