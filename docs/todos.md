# TODOS

- debug failed arbitrages
- implement optimized ticks fetching using multicall3
- implement blacklist of tokens
- batch pool introspection into a single call
- batch wallet balances into a single call
- batch pool discovery into a single call
- check how much we can borrow from vault for each anchor token in a single call

- add forceUpdate flag to explicitly overwrite dynamic data if pool its already initialized, othweize skip pool
  (needed because at initialization while fetching pools a new event may arrive and batch call may fetch data from previous block and ovewrite data written by events)
- investigate why tokenPairs are not set at init

## MVP

- if running with localhost provider do not sync pools!!!
- review gas calculation/analysis and bribe calculation
- simulate all found opportunities in a single call

### handle pre-failed execution transaction submission over and over again

1. delete opp from DB since it has invalid calculation
2. fetch tick data => re-calculate again but this time with ticks

## POST_MVP

- search arbitrage paths for all tokens we can borrow (also check which tokens can we borrow and max amount borrow )
- introspect graph to discover new pools for key edges/bridges
- handle fw ERC20 tokens (see how to bridge from WETH to fwWETH for example and others like fwUSDC, fwWBTC, etc..)
- log general errors to DB identified by logId: 'timestamp_from', (things like event parsing failuire, async callbacks issues, etc.)
- consider trigger full scan for opportunity paths
- it may happen that relay its on network spikes => fallback to old TX if relay its down
- integrate burn/mint events for V3
- fetch and keep in sync ticks liquidity for V3 conditionally

### Integrate with COW Protocol for resolving swaps using best routes

### Simulate swap v3/v4

If there its not liquidity while crossing ticks:
The swap its partially filled => the amountOut its underestimated and amountRemaining > 0
=> handle amountRemaining > 0 case outside of simulate swap call

```javascript
// Change return type to include unconsumed input
return { amountOut: totalAmountOut, amountUnconsumed: amountRemaining };
```

### Contract

allow to specify option: if last swap has WETH, convert only the amount we want to borrow and keep eth
this allows to pay the bribe in contract

- add option to keep token0 or keep token1 for last swap
- if revert amountOutMin > log in message actual amountOut vs amountOutMin

## Arbitrage Features

- add flag for tick crossing swaps on opportunity.steps
- allow only trade within price tick for V3 pools for pools which do not have ticks => find optimum within current tick range
- for the other use full liquidity ranges
- add GasUsage/GasCostUSD per Edge in LiquidityGraph? => if gasCostUSD > grossProfitUSD && TokenOut in preferredBorrowTokens => exit

## Liquidity graph

Expand: add gas cost USD/ gasUsage per edge?

## Upgrade arbitrage contract

- upgrade contract to support V4 swap (update gas manager estimations)

## NOTES

- optional feature: job/tasks monitoring feature based on blockNumber or some unique id?
