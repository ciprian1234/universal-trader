# Data model

## Venue = a place where you can trade (DEX, CEX)

> examples: 1:uniswap-v2, 1:uniswap-v3, 42161:uniswap-v2, 42161:uniswap-v3, binance, bybit, okx

## VenueState = a pool/pair, from a venue

- on chains => VenueState its a DexPoolState
- on cex => VenueState its a CexPoolState

## Core data model idea

- venues - static data from config => no runtime updates!
- tokens - some pre-configured: native tokens, stable coins, and few known ERC20 like WTBC, AAVE, etc...
- tokens can grow or shrink dynamically based on PoolEvents or manual adition using the API-SERVER
- VenueStates (pools) => can grow or shrink dinamically based on poolEvents or manual adition from the API-SERVER

- start with a small list of tokens from config => ETH, WETH, USDC, USDT, DAI, WBTC
  => discover Pools for configured tokens across venues
- the tokens and pools would grow over time by pool events or => sync tokens and pools in DB

## State initialization (at application startup) and main event flows

- load all previously stored Tokens from DB (trusted from coingecko and untrusted - introspected from on-chain if not found in coingecko token list): all tokens are enabled by default (a token can be explicitly disabled api-server => if token disable its called => send request to worker)
- load all previously discovered pools from DB (with static data, poolAddress, venue, tokenPair, fee, tick-spacing)
- start listening for All V2/V3/V4 pool-events
- fetch dynamic data (call updatePool) for few PoolStates (fetch dynamic data for some popular preconfigured token pairs like WETH-USDC, WBTC-USDC, etc.)
- if event occurs on a previously discovered pool OR we call updatePool => we consider that pool as: active/enabled/inSync
- if event occurs on some undiscovered/unidentified pool we call introspectPool to initialize the pool and save pool to DB
  => if event its V2_SYNC OR V3_SWAP we can consider that pool as: active/enabled/inSync since can update the pool with dynamic data.

### NOTES

- main thread only listen for events and keep its cache updated
- if mainthread wants to add/remove enable/disable a DexVenueState/Token it will send a command and worker will behave acordingly (write toDB and update its internal memory)

## PoolEvent => VenueState discovery

- When a poolEvent its emited => we have poolId and event data
- V2/V3 => we have event dynamic data (reserve0/reserve0, etc..) but token0/token1 info
- V4-EVENTS => we know token addresses and venue as well since its coming from PoolManager

Q: Can we perform swap if we know only the poolId? Yes

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

- In both cases we need to ensure token its authentic
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
