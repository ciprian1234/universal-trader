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

## Tokens

- native => ETH === WETH
- stable coins (ERC20) => USDT, USDC, DAI (can be swaped 1to1 with USD if token its burned/minted)
- others (ERC20)

Questions - its native token? - ETH (native) == WETH (wrapped ERC20) => need to provide resolver => ETH = WETH
NOTE: native tokens and stable coins will be preconfigured in config. (others will be added dynamically)

### New Token data flow

Tokens gets added either from newPool events or manually
IMPORTANT NOTE: (there may be multiple fake copies of any ERC20) => don't do cross chain trading with untrusted tokens!!!

## EVM-Worker (internal events)

### EventBus: "token-registred"

EMITTED: only by tokenManager.ensureTokenRegistered if token not registred yet.
case 1: at init for rootTokens
case 2: when a new
TRIGGERS => route event on MainThread (nothing else for now)

### EventBus: "token-pair-registred"

EMITTED: at init for few preconfigured ROOT TOKENS or when a new token gets registered
TRIGGERS => DexManager.discoverPoolsForTokenPairs(newTokenPair) (pools discovery for a gven tokenPair on all venues)

### Blockchain pool event => BlockManager.handlePoolEvent => dexManager.handlePoolEvent(e) (BlockManager calls directly with no EventBus)

- if pool its registred => calls dexRegistry.updatePoolFromEvent(p, e) => set pool state and emit "pool-update"
- else => calls dexRegistry.handleEventForUnknownPool(e) => calls ensureTokenRegistered for both token0/token1 => set pool state and emit "pool-update"?

### temp-use-case

new Blockchain pool event: Pool(id1, t0, t1) => EMIT(t0), EMIT(t1)
(lets asume new pool its unknown both t0 and t1 are new tokens)

=>

Case1: create only 1 TokenPair: (t0, t1)
Case2: create (t0, rootToken0)...(t0m, rootTokenN), (t1, rootToken0)...(t1, rootTokenN)

new TokenPair(t0, t1) => discover pools on all venues
=> new Pool(id1, t0, t1)

Q: Should I check

## PriceOracle

We need token prices in USD just for liquidity calculation and for referance - arbitrage its not based on priceOracle data!

- at init => fetch few RootPrices from external sources (WETH, WBTC, USD-stablecoins, and few other popular tokens)
- every 5 minutes => fetch rootTokenPrices - if failed => just log a warning - don't stop the app (we can fallback to internal calculation)

## REORG MECHANISM

- To handle reorg we need to store in block manager the list of events for last ~10 blocks
  We don't want to update all pools because thats an expensive operation
  Instead we want to mark as invalidated the pools events which evolved wrong during reorg
  => From list of events => we have the poolIds of the pools we need to invalidate and fetch fresh data
  => on block reorg detected => Gather all PoolIDs and

## Q&A:

Q: Can we perform swap if we know only the poolId? Yes (idea: refactor contract to swap directly without router???)
