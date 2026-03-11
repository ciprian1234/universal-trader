# TODOS

- integrate burn/mint events for V3
- fetch and keep in sync ticks liquidity for V3 conditionally

## Arbitrage Features

- integrate arbitrage finding
- MVP: check for arbitrage only for V2 protocols
- allow only trade within price tick for V3 pools for pools which do not have ticks => find optimum within current tick range
- for the other use full liquidity ranges

## Upgrade arbitrage contract

- upgrade arbitrage contract to execute swaps without knowing router address (only dex protocol)
- upgrade contract to wrap/unwrap ETH to pay gas fee

## NOTES

- optional feature: job/tasks monitoring feature based on blockNumber or some unique id?
