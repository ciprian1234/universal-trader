export const FLASH_ARBITRAGE_ABI = [
  {
    inputs: [],
    stateMutability: 'nonpayable',
    type: 'constructor',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'minimum',
        type: 'uint256',
      },
      {
        internalType: 'uint256',
        name: 'actual',
        type: 'uint256',
      },
    ],
    name: 'InsufficientAmountOut',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'reserve',
        type: 'uint256',
      },
      {
        internalType: 'uint256',
        name: 'amount',
        type: 'uint256',
      },
    ],
    name: 'InsufficientLiquidity',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'addr',
        type: 'address',
      },
    ],
    name: 'InvalidAddress',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
    ],
    name: 'InvalidCaller',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'int256',
        name: 'delta0',
        type: 'int256',
      },
      {
        internalType: 'int256',
        name: 'delta1',
        type: 'int256',
      },
    ],
    name: 'InvalidDeltasV3',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'protocol',
        type: 'uint256',
      },
    ],
    name: 'InvalidDexProtocol',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'token',
        type: 'address',
      },
      {
        internalType: 'uint256',
        name: 'amount',
        type: 'uint256',
      },
      {
        internalType: 'uint256',
        name: 'actualBalance',
        type: 'uint256',
      },
    ],
    name: 'LoanRepaymentNotMet',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'token',
        type: 'address',
      },
      {
        internalType: 'uint256',
        name: 'minProfit',
        type: 'uint256',
      },
      {
        internalType: 'uint256',
        name: 'actualBalance',
        type: 'uint256',
      },
    ],
    name: 'MinProfitNotMet',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
    ],
    name: 'NotAuthorized',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'uint16',
        name: 'location',
        type: 'uint16',
      },
      {
        internalType: 'uint256',
        name: 'amount',
        type: 'uint256',
      },
    ],
    name: 'OverflowError',
    type: 'error',
  },
  {
    inputs: [],
    name: 'ReentrancyGuardReentrantCall',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'token',
        type: 'address',
      },
    ],
    name: 'SafeERC20FailedOperation',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'bytes',
        name: 'reason',
        type: 'bytes',
      },
    ],
    name: 'SimulationError',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'profitOut',
        type: 'uint256',
      },
    ],
    name: 'SimulationSuccess',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'to',
        type: 'address',
      },
      {
        internalType: 'address',
        name: 'token',
        type: 'address',
      },
      {
        internalType: 'uint256',
        name: 'amount',
        type: 'uint256',
      },
    ],
    name: 'TransferFailed',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'int256',
        name: 'amount0Delta',
        type: 'int256',
      },
      {
        internalType: 'int256',
        name: 'amount1Delta',
        type: 'int256',
      },
      {
        internalType: 'bytes',
        name: 'data',
        type: 'bytes',
      },
    ],
    name: 'algebraSwapCallback',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: '_token',
        type: 'address',
      },
    ],
    name: 'emergencyWithdraw',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        components: [
          {
            internalType: 'enum FlashArbitrage.DexProtocol',
            name: 'dexProtocol',
            type: 'uint8',
          },
          {
            internalType: 'address',
            name: 'poolAddress',
            type: 'address',
          },
          {
            internalType: 'address[]',
            name: 'poolTokens',
            type: 'address[]',
          },
          {
            internalType: 'address',
            name: 'tokenIn',
            type: 'address',
          },
          {
            internalType: 'address',
            name: 'tokenOut',
            type: 'address',
          },
          {
            internalType: 'int256',
            name: 'amountSpecified',
            type: 'int256',
          },
          {
            internalType: 'uint256',
            name: 'amountOutMin',
            type: 'uint256',
          },
          {
            internalType: 'uint24',
            name: 'poolFee',
            type: 'uint24',
          },
          {
            internalType: 'bytes',
            name: 'extraData',
            type: 'bytes',
          },
        ],
        internalType: 'struct FlashArbitrage.SwapStep',
        name: 'step',
        type: 'tuple',
      },
    ],
    name: 'executeDirectSwap',
    outputs: [
      {
        internalType: 'uint256',
        name: '',
        type: 'uint256',
      },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        components: [
          {
            components: [
              {
                internalType: 'enum FlashArbitrage.DexProtocol',
                name: 'dexProtocol',
                type: 'uint8',
              },
              {
                internalType: 'address',
                name: 'poolAddress',
                type: 'address',
              },
              {
                internalType: 'address[]',
                name: 'poolTokens',
                type: 'address[]',
              },
              {
                internalType: 'address',
                name: 'tokenIn',
                type: 'address',
              },
              {
                internalType: 'address',
                name: 'tokenOut',
                type: 'address',
              },
              {
                internalType: 'int256',
                name: 'amountSpecified',
                type: 'int256',
              },
              {
                internalType: 'uint256',
                name: 'amountOutMin',
                type: 'uint256',
              },
              {
                internalType: 'uint24',
                name: 'poolFee',
                type: 'uint24',
              },
              {
                internalType: 'bytes',
                name: 'extraData',
                type: 'bytes',
              },
            ],
            internalType: 'struct FlashArbitrage.SwapStep[]',
            name: 'swaps',
            type: 'tuple[]',
          },
          {
            internalType: 'address',
            name: 'borrowToken',
            type: 'address',
          },
          {
            internalType: 'uint256',
            name: 'borrowAmount',
            type: 'uint256',
          },
          {
            internalType: 'uint16',
            name: 'internalBribeBps',
            type: 'uint16',
          },
          {
            internalType: 'uint256',
            name: 'minProfitTokenOut',
            type: 'uint256',
          },
        ],
        internalType: 'struct FlashArbitrage.Trade',
        name: 'trade',
        type: 'tuple',
      },
    ],
    name: 'executeTrade',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'owner',
    outputs: [
      {
        internalType: 'address',
        name: '',
        type: 'address',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'int256',
        name: 'amount0Delta',
        type: 'int256',
      },
      {
        internalType: 'int256',
        name: 'amount1Delta',
        type: 'int256',
      },
      {
        internalType: 'bytes',
        name: 'data',
        type: 'bytes',
      },
    ],
    name: 'pancakeV3SwapCallback',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'contract IERC20[]',
        name: 'tokens',
        type: 'address[]',
      },
      {
        internalType: 'uint256[]',
        name: 'amounts',
        type: 'uint256[]',
      },
      {
        internalType: 'uint256[]',
        name: 'feeAmounts',
        type: 'uint256[]',
      },
      {
        internalType: 'bytes',
        name: 'callbackData',
        type: 'bytes',
      },
    ],
    name: 'receiveFlashLoan',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        components: [
          {
            components: [
              {
                internalType: 'enum FlashArbitrage.DexProtocol',
                name: 'dexProtocol',
                type: 'uint8',
              },
              {
                internalType: 'address',
                name: 'poolAddress',
                type: 'address',
              },
              {
                internalType: 'address[]',
                name: 'poolTokens',
                type: 'address[]',
              },
              {
                internalType: 'address',
                name: 'tokenIn',
                type: 'address',
              },
              {
                internalType: 'address',
                name: 'tokenOut',
                type: 'address',
              },
              {
                internalType: 'int256',
                name: 'amountSpecified',
                type: 'int256',
              },
              {
                internalType: 'uint256',
                name: 'amountOutMin',
                type: 'uint256',
              },
              {
                internalType: 'uint24',
                name: 'poolFee',
                type: 'uint24',
              },
              {
                internalType: 'bytes',
                name: 'extraData',
                type: 'bytes',
              },
            ],
            internalType: 'struct FlashArbitrage.SwapStep[]',
            name: 'swaps',
            type: 'tuple[]',
          },
          {
            internalType: 'address',
            name: 'borrowToken',
            type: 'address',
          },
          {
            internalType: 'uint256',
            name: 'borrowAmount',
            type: 'uint256',
          },
          {
            internalType: 'uint16',
            name: 'internalBribeBps',
            type: 'uint16',
          },
          {
            internalType: 'uint256',
            name: 'minProfitTokenOut',
            type: 'uint256',
          },
        ],
        internalType: 'struct FlashArbitrage.Trade',
        name: 'trade',
        type: 'tuple',
      },
    ],
    name: 'simulateTrade',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'int256',
        name: 'amount0Delta',
        type: 'int256',
      },
      {
        internalType: 'int256',
        name: 'amount1Delta',
        type: 'int256',
      },
      {
        internalType: 'bytes',
        name: 'data',
        type: 'bytes',
      },
    ],
    name: 'uniswapV3SwapCallback',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'bytes',
        name: 'data',
        type: 'bytes',
      },
    ],
    name: 'unlockCallback',
    outputs: [
      {
        internalType: 'bytes',
        name: '',
        type: 'bytes',
      },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: '_newOwner',
        type: 'address',
      },
    ],
    name: 'updateOwner',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    stateMutability: 'payable',
    type: 'receive',
  },
];
