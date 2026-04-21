# TODOS

- investigate unknown(397) pool why not expected amountOut => custom fee
- review blacklisted pools
- revisit gasUsage estimation
- revisit pathFinding condition (rates product, to many found candidate paths)
- introspect invalidated opportunities => check on next block pools events and tx how pools were used

- batch pools introspection into a single call
- if opportunity its still valid => use standardTx in pendingOpportunities check
- if flashbots 50X => fallback to standardTx

## MVP

- investigate why tokenPairs are not set at init
- if running with localhost provider do not sync pools!!!
- move arbitrage stats in flashArbitrageHandler
- revisit non-overlapping opportunities selection

## POST_MVP

### BATCH_1

- check how much we can borrow from vault for each anchor token in a single call
- batch wallet balances into a single call
- batch pool discovery into a single call

### BATCH_2

- search arbitrage paths for all tokens we can borrow (also check which tokens can we borrow and max amount borrow )
- introspect graph to discover new pools for key edges/bridges
- handle fw ERC20 tokens (see how to bridge from WETH to fwWETH for example and others like fwUSDC, fwWBTC, etc..)
- log general errors to DB identified by logId: 'timestamp_from', (things like event parsing failuire, async callbacks issues, etc.)
- it may happen that relay its on network spikes => fallback to old TX if relay its down
- if updatingPools and in meantime new block arrived => updatePools overwrites with stale date => check if new block arrived by using block manager if currentBlock > startBlock => fetch logs and apply again

### Integrate with COW Protocol for resolving swaps using best routes

### Implement arbitrage back-running

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

### Arbitrage Components

- add GasUsage/GasCostUSD per Edge in LiquidityGraph? => if gasCostUSD > grossProfitUSD && TokenOut in preferredBorrowTokens => exit
- expand Liquidity graph: add gas cost USD/ gasUsage per edge?

## NICE TO HAVE (OPTIONAL):

- optional feature: job/tasks monitoring feature based on blockNumber or some unique id?
