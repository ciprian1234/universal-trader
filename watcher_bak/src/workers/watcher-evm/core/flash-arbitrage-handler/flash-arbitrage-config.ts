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
  poolAddress: string; // for v2/v3 pool, adddres, for V4 pool manager address
  poolTokens: string[]; // for v2/v3/v4: [token0, token1], for balancer: [token0, token1, token2, ...]
  tokenIn: string;
  tokenOut: string;
  amountSpecified: bigint; // not used since contract its calculating exact amountIn for each swap
  amountOutMin: bigint;
  poolFee: number; // for v3/v4, ignored for v2/curve/balancer
  extraData: string; // EXTRA PROPERTIES FOR NEW DEX TYPES custom/future protocols
}

export interface Trade {
  swaps: SwapStepOnContract[];
  borrowToken: string;
  borrowAmount: bigint;
  internalBribeBps: bigint; // bribe paid from profit in basis points (bps 0-10000), set 0 if handled via ETH transfer
  minProfitTokenOut: bigint; // minimum profit threshold (after repayment+[bribe]) to execute the trade (in raw amount of tokenOut from last swap)
}
