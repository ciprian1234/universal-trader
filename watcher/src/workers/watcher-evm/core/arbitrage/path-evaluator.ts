import { ethers } from 'ethers';
import type { Logger } from '@/utils';
import type { ArbitrageOpportunity, SwapStep } from '../interfaces';
import type { DexManager } from '../dex-manager';
import type { GasManager } from '../gas-manager';
import type { PriceOracle } from '../price-oracle';
import type { ArbitragePath } from './interfaces';
import { isZeroForOne } from '../helpers';

export interface EvaluatorConfig {
  minGrossProfitUSD: number;
  maxTotalSlippage: number;
}

export interface PathEvaluatorInput {
  logger: Logger;
  dexManager: DexManager;
  priceOracle: PriceOracle;
  gasManager: GasManager;
  config: EvaluatorConfig;
}

/**
 * 📊 Path Evaluator: Simulates and validates arbitrage paths
 *
 * 1. Find optimal borrow amount
 * 2. Simulate all swaps in path
 * 3. Calculate profitability
 * 4. Add gas analysis
 */
export class PathEvaluator {
  private readonly logger: Logger;
  private readonly dexManager: DexManager;
  private readonly priceOracle: PriceOracle;
  private readonly gasManager: GasManager;
  private readonly config: EvaluatorConfig;

  constructor(input: PathEvaluatorInput) {
    this.logger = input.logger;
    this.dexManager = input.dexManager;
    this.priceOracle = input.priceOracle;
    this.gasManager = input.gasManager;
    this.config = input.config;
  }

  // ============================================
  // EVALUATION
  // ============================================

  /**
   * 📊 Evaluate path profitability
   */
  async evaluate(path: ArbitragePath) {
    try {
      // 0. display path being evaluated
      // this.displayPath(path);

      // 1. Find optimal borrow amount
      const optimalAmount = this.findOptimalAmountGoldenSectionSearch(path);
      if (optimalAmount <= 0n) {
        this.logger.debug(`No optimal amount found for path ${path.id}`);
        return null;
      }

      // 2. Simulate path with optimal amount
      const simulatedSteps = this.simulatePath(path.steps, optimalAmount);
      if (!simulatedSteps) {
        this.logger.debug(`Simulation failed for path ${path.id}`);
        return null;
      }

      // 3. Calculate metrics
      const firstStep = simulatedSteps[0];
      const lastStep = simulatedSteps[simulatedSteps.length - 1];

      const grossProfitToken = lastStep.amountOut - firstStep.amountIn;
      if (grossProfitToken <= 0n) {
        // this.logger.debug(`Path ${path.id} gross profit token amount ${grossProfitToken} is not positive`);
        return null;
      }

      const grossProfitUSD = this.priceOracle.calculateUSDValue(path.borrowToken.address, grossProfitToken) || 0;

      if (grossProfitUSD < this.config.minGrossProfitUSD) {
        // this.logger.debug(`Path ${path.id} gross profit $${grossProfitUSD.toFixed(2)} below threshold`);
        return null;
      }

      const totalSlippage = simulatedSteps.reduce((sum, s) => sum + s.slippage, 0);
      if (totalSlippage > this.config.maxTotalSlippage) {
        this.logger.debug(`Path ${path.id} slippage ${totalSlippage.toFixed(4)}% exceeds max ${this.config.maxTotalSlippage}%`);
        return null;
      }

      // 4. Create evaluated path (TODO: revisit)
      const evaluatedPath: ArbitrageOpportunity = {
        id: path.id,
        chainId: 1, // TO-BE-ADDED
        status: 'new',

        borrowToken: path.borrowToken,
        borrowAmount: optimalAmount,
        grossProfitToken,
        grossProfitUSD,
        netProfitUSD: 0, // Set after gas analysis

        steps: simulatedSteps,
        totalSlippage,
        totalPriceImpact: simulatedSteps.reduce((sum, s) => sum + s.priceImpact, 0),
        logs: [],
        timestamp: Date.now(),
      };

      this.logger.debug(`Evaluated path ${path.id}: Profit $${grossProfitUSD.toFixed(2)}, Slippage ${totalSlippage.toFixed(4)}%`);
      this.displayPath(evaluatedPath);

      // 5. Gas analysis
      try {
        this.gasManager.fillGasAnalysis(evaluatedPath);
      } catch (err) {
        this.logger.debug(`Gas analysis failed for path ${path.id}: ${(err as Error).message}`);
        return null; // Not profitable after gas
      }

      return evaluatedPath;
    } catch (error) {
      this.logger.debug(`Error evaluating path ${path.id}: ${(error as Error).message}`);
      return null;
    }
  }

  // ============================================
  // DISPLAY PATH
  // ============================================
  displayPath(path: ArbitrageOpportunity): void {
    this.logger.info(`🛤️ Arbitrage Path: ${path.id}`);
    for (const [index, step] of path.steps.entries()) {
      this.logger.info(
        `  Step ${index + 1}: ${step.tokenIn.symbol} -> ${step.tokenOut.symbol} via ${step.pool.venue.name} (${
          step.pool.feeBps
        }) | In: ${step.amountIn.toString()} | Out: ${step.amountOut.toString()} | Spot Price: ${step.spotPrice.toFixed(
          6,
        )} | Exec Price: ${step.executionPrice.toFixed(6)} | Price Impact: ${step.priceImpact.toFixed(
          4,
        )}% | Slippage: ${step.slippage.toFixed(4)}%`,
      );
    }
  }

  // ============================================
  // OPTIMIZATION
  // ============================================

  /**
   * 🎯 Find optimal borrow amount using Ternary Search
   */
  private findOptimalAmountTernarySearch(path: ArbitragePath): bigint {
    const firstStep = path.steps[0];
    const borrowToken = path.borrowToken;
    const zeroForOne = isZeroForOne(borrowToken.address, firstStep.pool);
    const reserve = zeroForOne ? firstStep.pool.reserve0! : firstStep.pool.reserve1!;

    // Find bottleneck pool (smallest liquidity)
    let smallestLiquidityUSD = path.steps[0].pool.totalLiquidityUSD;
    for (let i = 1; i < path.steps.length; i++) {
      if (path.steps[i].pool.totalLiquidityUSD < smallestLiquidityUSD) {
        smallestLiquidityUSD = path.steps[i].pool.totalLiquidityUSD;
      }
    }

    const firstPoolLiquidityUSD = firstStep.pool.totalLiquidityUSD;
    const liquidityRatio = firstPoolLiquidityUSD / smallestLiquidityUSD;

    let left = 1n;
    let right = reserve / BigInt(Math.ceil(liquidityRatio)) / 2n; // Max 50% of adjusted reserve

    const MAX_ITERATIONS = 30;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (right - left <= 2n) break;

      const third = (right - left) / 3n;
      if (third <= 0n) break;

      const mid1 = left + third;
      const mid2 = right - third;

      if (mid1 >= mid2) break;

      const profit1 = this.simulateProfit(path.steps, mid1);
      const profit2 = this.simulateProfit(path.steps, mid2);

      // Move towards higher profit (finding MAXIMUM)
      if (profit1 > profit2) {
        right = mid2;
      } else {
        left = mid1;
      }

      // console.log(`Iteration ${i}: left=${left}, mid1=${mid1}, profit1=${profit1}, mid2=${mid2}, profit2=${profit2}, right=${right}`);
    }

    return (left + right) / 2n;
  }

  /**
   * 🎯 Find optimal borrow amount using Golden Section Search
   * This is the BEST algorithm for unimodal profit functions
   */
  private findOptimalAmountGoldenSectionSearch(path: ArbitragePath): bigint {
    const firstStep = path.steps[0];
    const borrowToken = path.borrowToken;
    const zeroForOne = isZeroForOne(borrowToken.address, firstStep.pool);
    const reserve = zeroForOne ? firstStep.pool.reserve0! : firstStep.pool.reserve1!;

    // Find bottleneck pool (smallest liquidity)
    let smallestLiquidityUSD = Number.MAX_VALUE;
    for (const step of path.steps) {
      // console.log(`Pool ${step.pool.dexName} liquidity USD: $${step.pool.totalLiquidityUSD.toFixed(2)}`);
      if (step.pool.totalLiquidityUSD < smallestLiquidityUSD) {
        smallestLiquidityUSD = step.pool.totalLiquidityUSD;
      }

      const liquidity = step.pool.totalLiquidityUSD;
      // Skip pools with invalid liquidity data
      if (!liquidity || liquidity <= 0 || !Number.isFinite(liquidity)) {
        this.logger.debug(`Pool ${step.pool.venue.name} has invalid liquidity: ${liquidity}`);
        continue;
      }
    }
    // console.log(`Smallest liquidity USD in path: $${smallestLiquidityUSD.toFixed(2)}`);

    // Scale max amount based on bottleneck
    const firstPoolLiquidityUSD = firstStep.pool.totalLiquidityUSD;
    const liquidityRatio = firstPoolLiquidityUSD / smallestLiquidityUSD;

    // console.log(`Liquidity ratio: ${liquidityRatio.toFixed(4)}`);

    const minAmount = 1n;
    const maxAmount = reserve / BigInt(Math.ceil(liquidityRatio)) / 2n; // Max 50% of adjusted reserve

    // Golden ratio constant
    const PHI = 1.618033988749895;
    const INV_PHI = 1.0 / PHI;
    const MAX_ITERATIONS = 30;

    let left = minAmount;
    let right = maxAmount;

    // Initial points using golden ratio
    let range = right - left;
    let c = left + BigInt(Math.floor(Number(range) * (1 - INV_PHI)));
    let d = left + BigInt(Math.floor(Number(range) * INV_PHI));

    // console.log(`Finding optimal amount between ${left} and ${right}`);
    let profitC = this.simulateProfit(path.steps, c);
    let profitD = this.simulateProfit(path.steps, d);

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      // Convergence check
      if (right - left <= 1n) break;

      if (profitC > profitD) {
        // Maximum is in [left, d]
        right = d;
        d = c;
        profitD = profitC;

        range = right - left;
        c = left + BigInt(Math.floor(Number(range) * (1 - INV_PHI)));
        profitC = this.simulateProfit(path.steps, c);
        // console.log(`Iteration ${i}: New right=${right}, c=${c}, profitC=${profitC}, d=${d}, profitD=${profitD}`);
      } else {
        // Maximum is in [c, right]
        left = c;
        c = d;
        profitC = profitD;

        range = right - left;
        d = left + BigInt(Math.floor(Number(range) * INV_PHI));
        profitD = this.simulateProfit(path.steps, d);
        // console.log(`Iteration ${i}: New left=${left}, c=${c}, profitC=${profitC}, d=${d}, profitD=${profitD}`);
      }
    }

    // Return point with highest profit
    return profitC > profitD ? c : d;
  }

  /**
   * 🔄 Simulate output amount for a given input (for optimization)
   * Returns final output amount (not profit)
   */
  private simulateOutput(steps: SwapStep[], inputAmount: bigint): bigint {
    if (inputAmount <= 0n) return -1_000_000_000_000_000n;
    let currentAmount = inputAmount;
    for (const step of steps) {
      const zeroForOne = isZeroForOne(step.tokenIn.address, step.pool);
      const amountOut = this.dexManager.simulateSwap(step.pool, currentAmount, zeroForOne);
      currentAmount = amountOut;
    }
    return currentAmount;
  }

  /**
   * 🔄 Simulate profit for a given amount
   * Returns: output - input (can be negative)
   */
  private simulateProfit(steps: SwapStep[], inputAmount: bigint): bigint {
    const output = this.simulateOutput(steps, inputAmount);
    return output - inputAmount;
  }

  /**
   * 🔄 Simulate entire path with amounts
   */
  private simulatePath(steps: SwapStep[], initialAmount: bigint): SwapStep[] | null {
    const simulatedSteps: SwapStep[] = [];
    let currentAmount = initialAmount;

    for (const step of steps) {
      const zeroForOne = isZeroForOne(step.tokenIn.address, step.pool);

      try {
        const amountOut = this.dexManager.simulateSwap(step.pool, currentAmount, zeroForOne);
        if (amountOut <= 0n) return null;

        // Calculate metrics
        const normalizedIn = Number(ethers.formatUnits(currentAmount, step.tokenIn.decimals));
        const normalizedOut = Number(ethers.formatUnits(amountOut, step.tokenOut.decimals));
        const executionPrice = normalizedOut / normalizedIn;
        const priceImpact = (Math.abs(executionPrice - step.spotPrice) / step.spotPrice) * 100;

        simulatedSteps.push({
          ...step,
          amountIn: currentAmount,
          amountOut,
          executionPrice,
          priceImpact,
          slippage: priceImpact, // Simplified
        });

        currentAmount = amountOut;
      } catch {
        return null;
      }
    }

    return simulatedSteps;
  }
}
