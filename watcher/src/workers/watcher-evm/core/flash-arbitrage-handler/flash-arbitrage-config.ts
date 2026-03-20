// DexType enum mapping
export enum DexProtocolEnum {
  UNISWAP_V2 = 0,
  UNISWAP_V3 = 1,
  UNISWAP_V4 = 2,
  CURVE = 3,
  BALANCER = 4,
  CUSTOM = 5,
}

export interface SwapStepOnContract {
  dexProtocol: DexProtocolEnum;
  poolAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOutMin: bigint;
  feeBps: number;
  zeroForOne: boolean;

  // EXTRA PROPERTIES FOR NEW DEX TYPES
  poolId: string; // For V4/Balancer pool identification
  curveIndexIn: number; // For Curve token index (review data type)
  curveIndexOut: number; // For Curve token index (review data type)
  extraData: string; // For custom/future protocols
}

export interface Trade {
  swaps: SwapStepOnContract[];
}
