# Data model

## Venue = a place where you can trade (DEX, CEX)

> examples: 1:uniswap-v2, 1:uniswap-v3, 42161:uniswap-v2, 42161:uniswap-v3, binance, bybit, okx

## VenueState = a pool/pair, from a venue

- on chains => VenueState its a DexPoolState
- on cex => VenueState its a CexPoolState

## Tokens

enum state: disabled=0, new=1, validated=

Tokens are managed by TokenManager (main-thread) and TokenStore (worker)
Types of tokens:

- native => ETH === WETH
- stable coins (ERC20) => USDT, USDC, DAI (can be swaped 1to1 with USD if token its burned/minted)
- others (ERC20)

Questions - its native token? - ETH (native) == WETH (wrapped ERC20) => need to provide resolver => ETH = WETH
NOTE: native tokens and stable coins will be preconfigured in config.
The others could be added dynamically or manually at runtime

### New Token data flow

IMPORTANT NOTE: (there may be multiple fake copies of any ERC20)

- In both following cases we need to ensure token its authentic
- we will ensure token its authentic if it can be found across multiple venues AND the liquidityUSD of those venuesStates > threshold
  => we can't trade until price oracle its updated so we can calculate liquidityUSD to validate the token

### Case1 - added manually using the API-SERVER (only ERC20)

Input: symbol, address, and chainId
Event: token-added
Triggers:

- trigger

### Case2 - discovered from poolEvents (only ERC20)

- new poolEvent => contains new unknown tokens (either 1 or both) => emits new event

## PriceOracle

- it
