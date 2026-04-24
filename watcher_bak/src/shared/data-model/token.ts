// ════════════════════════════════════════════════════════════
// TOKEN IDENTITY
// ════════════════════════════════════════════════════════════

export interface TokenBase {
  symbol: string; // canonical: "ETH", "USDC"
  name: string; // full token name, e.g. "USD Coin"
}

/** On-chain token with a known address */
export interface TokenOnChain extends TokenBase {
  chainId: number;
  address: string;
  decimals: number;
  trusted: boolean; // whether this token is in the trusted token list (e.g. coingecko or uniswap token lists)
}

/** Token reference that may or may not be on-chain (used in VenueState.tokens) */
export type Token = TokenOnChain | TokenBase;

// on chain token pair => token0 and token1 are ordered by address, not symbol. This is important for DEX interactions where token order matters (e.g. Uniswap pairs).
export type TokenPairOnChain = {
  token0: TokenOnChain; // lower address
  token1: TokenOnChain; // higher address
  key: string; // "token0.<symbol>-token1.<symbol>"
};

/**
 * Canonical sorted symbol pair key. Always alphabetically sorted.
 * Examples: "ETH:USDC", "BTC:USDT", "ARB:ETH"
 */
export type CanonicalPairId = string;

export function getCanonicalPairId(tokenA: Token, tokenB: Token): CanonicalPairId {
  const symbols = [tokenA.symbol, tokenB.symbol].sort();
  return symbols.join(':');
}
