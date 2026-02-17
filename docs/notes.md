## Arhitecture (generated)

GlobalDataStore - all pools/exchanges data in main thread
MessageBus - communication layer between main thread and workers

## Data Flow

```
Workers (per chain)                    Main Thread
┌─────────────┐                       ┌────────────────────────┐
│ LocalStore   │──pool:batch-update──▶│ GlobalDataStore (sync) │
│ ArbDetector  │──arb:opportunity───▶│ CrossChainDetector     │
│ Discovery    │──discovery:*───────▶│ Admin API (Hono + WS)  │
└──────▲──────┘                       └──────────┬─────────────┘
       │                                         │
       └──── control:*, arb:configure, ──────────┘
              pool:enable/disable,
              query:quote, query:arb-check
```

## Workers (worker-ethereum, worker-solana, worker-binance)

Each worker:

- Maintains its own PoolStateStore (full data: reserves, ticks, orderbooks)
- Connects to RPC/WS for real-time block & event data
- Runs on-chain arbitrage detection locally (lowest latency)
- Emits pool state deltas to main thread for GlobalDataStore sync
- Emits discovered opportunities to main thread for execution
- Handles on-demand queries (quotes, arb checks) from admin API
- Supports discovery mode (listen for new pools/tokens)

## Main Thread

- Keeps GlobalDataStore in sync via worker messages
- Runs cross-chain arbitrage detection (needs data from ALL chains)
- Runs DEX↔CEX arbitrage detection (needs on-chain + CEX data)
- Serves admin API (Hono HTTP + WebSocket)
- Forwards execution requests to arbitrage-executor worker
- Does NOT run on-chain arb detection (workers handle that)

## Worker: arbitrage-executor

- Receives ArbitrageOpportunity from main thread
- Determines execution strategy:
  - EVM on-chain → flashloan + smart contract (Flashbots if available)
  - Solana → Jito bundle
  - Cross-chain → bridge through cheapest path
- Reports execution results back to main thread

## Key Design Decisions

1. **Workers detect on-chain arb** — they have freshest data, zero latency
2. **Main thread detects cross-chain arb** — it's the only place with all chain data
3. **GlobalDataStore is a synced copy** — not the source of truth for any single chain
4. **Workers own their chain's truth** — main thread can query them for fresh data
5. **postMessage for communication** — simple, Bun-native, good enough for our needs
6. **Everything is configurable at runtime** — enable/disable arb, discovery, pools, etc.

## Concepts

### ArbitragePath (TradePath)

A list of TradeSteps that form an arbitrage opportunity.

#### On-chain example (flashloan execution):

- step[0] → swap USDC→ETH on Uniswap V3 (ETH mainnet)
- step[1] → swap ETH→WBTC on Uniswap V2 (ETH mainnet)
- step[2] → swap WBTC→USDC on Curve (ETH mainnet)

#### Cross-chain example:

- step[0] → swap USDC→ETH on Uniswap V3 (ETH mainnet)
- step[1] → bridge ETH via Stargate (ETH → Arbitrum)
- step[2] → swap ETH→USDC on Camelot (Arbitrum)

#### DEX↔CEX example:

- step[0] → buy ETH on Uniswap V3 (on-chain)
- step[1] → transfer ETH to Binance
- step[2] → sell ETH/USDT on Binance spot

## Use Cases (Admin API)

- GET/POST pools, tokens, dexes — enable/disable/configure
- GET/POST arbitrage config — per chain and cross-chain
- GET/POST discovery mode — enable/disable per chain
- POST /quote — simulate a trade (routed to worker)
- POST /arb-check — analyze a specific arb path
- GET /opportunities — recent detected opportunities
- GET /executions — execution history and results
- WS /ws — real-time stream of opportunities, pool updates, blocks

## Price Oracle

GlobalPriceOracle checks all GlobalDataStore periodically to calculate USD prices for all available tokens

## priceResolver calculated weighted usd price based on liquidity from all available sources

=> broadcast to all workers

- we can use coingecko to at init or to compare

. All Workers
(initial prices) (now have USD prices
before any pool data)

## General notes

identify tokens by symbols not addresses (addresses are not universal equal)

## TODOS

- main entry point
- define good interfaces
- proper logging with worker prefix

## Problems

- how to dispatch get price quote (which requires RPC call)?
  => Implement WorkerRPC => make async call to worker to resolve

- store in GlobalDataStore rawData as well => In CrossArbitrageDetector use rawData share/math functions instead of WorkerRPC
  (the only exception its quote call for exact amount out which requres worker RPC connection, for everything else we can resolve in main thread without WorkerRPC call)

## Implement MessageBus

Use cases:

- event => would be send by workers to main thread (poolEvents)
- commands => are send by mainThread to workers and uses WorkerRPC (async call with id for resolving)
- broadcast events (PriceOracle) =>
