# TODOS

- debug failed arbitrages
- select arbitrage paths based on some different logic
- review gas calculation/analysis and bribe calculation
- integrate burn/mint events for V3
- fetch and keep in sync ticks liquidity for V3 conditionally

## MVP

- revisit gas calculation
- handle blocks reorg gracefully

## Integrate with COW Protocol for resolving swaps using best routes

## Contract

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
