// Contract ABI - only the functions we need
export const FLASH_ARBITRAGE_ABI = [
  {
    inputs: [
      {
        components: [
          {
            components: [
              {
                internalType: 'enum FlashArbitrage.DexType',
                name: 'dexType',
                type: 'uint8',
              },
              {
                internalType: 'address',
                name: 'router',
                type: 'address',
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
                internalType: 'uint256',
                name: 'amountIn',
                type: 'uint256',
              },
              {
                internalType: 'uint256',
                name: 'amountOutMin',
                type: 'uint256',
              },
              {
                internalType: 'uint24',
                name: 'fee',
                type: 'uint24',
              },
              {
                internalType: 'bytes32',
                name: 'poolId',
                type: 'bytes32',
              },
              {
                internalType: 'int128',
                name: 'curveIndexIn',
                type: 'int128',
              },
              {
                internalType: 'int128',
                name: 'curveIndexOut',
                type: 'int128',
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
        ],
        internalType: 'struct FlashArbitrage.Trade',
        name: '_trade',
        type: 'tuple',
      },
    ],
    name: 'executeTrade',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'owner',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
];

// DexType enum mapping
export enum DexTypeEnum {
  UNISWAP_V2 = 0,
  UNISWAP_V3 = 1,
  UNISWAP_V4 = 2,
  CURVE = 3,
  BALANCER = 4,
  CUSTOM = 5,
}

export interface SwapStep {
  dexType: number;
  router: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOutMin: bigint;
  fee: number; // 0 for V2, actual fee for V3 (e.g., 3000 = 0.3%)

  // EXTRA PROPERTIES FOR NEW DEX TYPES
  poolId: string; // For V4/Balancer pool identification
  curveIndexIn: number; // For Curve token index (review data type)
  curveIndexOut: number; // For Curve token index (review data type)
  extraData: string; // For custom/future protocols
}

export interface Trade {
  swaps: SwapStep[];
}
