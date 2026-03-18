import { ethers } from 'ethers';
import type { ArbitrageOpportunity } from './interfaces';
import { Blockchain } from './blockchain';
import { createLogger, type Logger } from '@/utils';
import { WalletManager } from './wallet-manager';
import type { ChainConfig } from '@/config/models';
import type { PriceOracle } from './price-oracle';
import type { DexProtocol } from '@/shared/data-model/layer1';
import type { TokenManager } from './token-manager';
import type { TokenOnChain } from '@/shared/data-model/token';
import type { BlockEntry } from './block-manager';

type GasManagerInput = {
  chainConfig: ChainConfig;
  blockchain: Blockchain;
  walletManager: WalletManager;
  priceOracle: PriceOracle;
};

export class GasManager {
  private readonly logger: Logger;
  private readonly chainConfig: ChainConfig;
  private readonly blockchain: Blockchain;
  private readonly walletManager: WalletManager;
  private readonly priceOracle: PriceOracle;

  private readonly WRAPPED_NATIVE_TOKEN_ADDRESS: string;
  private readonly MIN_PRIORITY_FEE: bigint;
  private readonly MAX_PRIORITY_FEE: bigint;

  private blockCounter = 0;
  private baseFeePerGas: bigint = ethers.parseUnits('1', 'gwei'); // latest base fee (updated every x blocks)

  // Gas estimation constants (for FlashArbitrageContract main operations)
  private static readonly BASE_COSTS = {
    FLASH_LOAN_OVERHEAD: 50000n, // Balancer flash loan callback + validation
    CONTRACT_OVERHEAD: 30000n, // ReentrancyGuard, decoding, memory operations
    TRANSFER_OVERHEAD: 25000n * 2n, // SafeERC20 transfers (repayment + profit)
    APPROVAL_OVERHEAD: 48000n, // SafeERC20 forceApprove (reset to 0 + approve)
  };

  private static readonly COMBO_PENALTIES = {
    CROSS_DEX: 3000n, // Minimal overhead for switching DEX types
    INTERMEDIATE_BALANCE: 5000n, // Balance check for intermediate swaps
  };

  // Updated gas costs based on actual DEX implementations
  private static readonly SWAP_COSTS: Record<DexProtocol, bigint> = {
    v2: 110000n, // V2 router + path array creation
    v3: 145000n, // V3 exactInputSingle with params struct
    v4: 135000n, // V4 with hooks (estimated, not yet live)
    // curvestable: 95000n, // Curve is most gas efficient for stables
    // balancerweighted: 180000n, // Balancer V2 with IAsset casting + vault interaction
  };

  constructor(input: GasManagerInput) {
    this.logger = createLogger(`[${input.chainConfig.name}.GasManager]`); // nice emoji ⛽
    this.chainConfig = input.chainConfig;
    this.blockchain = input.blockchain;
    this.walletManager = input.walletManager;
    this.priceOracle = input.priceOracle;

    // get wrapped native token
    this.WRAPPED_NATIVE_TOKEN_ADDRESS = this.chainConfig.wrappedNativeTokenAddress.toLowerCase();
    this.MIN_PRIORITY_FEE = this.chainConfig.minPriorityFee;
    this.MAX_PRIORITY_FEE = this.chainConfig.maxPriorityFee;
  }

  // ================================================================================================
  // EVENT HANDLER
  // ================================================================================================
  async handleNewBlockEvent({ number, receivedTimestamp }: BlockEntry) {
    if (this.blockCounter++ % this.chainConfig.gasDataFetchInterval !== 0) return; // Fetch Block data every X blocks
    const data = await this.blockchain.getBlock(number); // only fetch once per x events TBD
    this.baseFeePerGas = data!.baseFeePerGas!;
    const baseFeePerGasFormatted = this.formatGwei(data!.baseFeePerGas!);
    const gasUsagePercent = ((Number(data!.gasUsed) / Number(data!.gasLimit)) * 100).toFixed(2);
    const deltaReceived = receivedTimestamp - data!.timestamp * 1000;
    const deltaProcessed = Date.now() - receivedTimestamp;
    this.logger.info(
      `⛽ Block ${number} (mined ${deltaReceived}ms ago) - gasUsed: ${gasUsagePercent}%  baseFeePerGas: ${baseFeePerGasFormatted} (+${deltaProcessed}ms)`,
    );
  }

  // ================================================================================================
  // GAS RESULT FACADE FUNCTION
  // ================================================================================================

  fillGasAnalysis(opportunity: ArbitrageOpportunity) {
    const gasEstimate = this.estimateGasUsage(opportunity);
    const { gasData, gasTxSettings } = this.getGasAnalysis(opportunity, gasEstimate);

    opportunity.gasAnalysis = {
      gasEstimate: gasData.gasEstimate,
      totalGasCostUSD: gasData.totalGasCostUSD,
      gasData, // temporary, for debugging
      baseFeePerGas: this.baseFeePerGas,
      gasTxSettings,
    };
    opportunity.netProfitUSD = opportunity.grossProfitUSD - gasData.totalGasCostUSD;
  }

  getBaseFeePerGas(): bigint {
    return this.baseFeePerGas;
  }

  // ================================================================================================
  // GAS USAGE ESTIMATION & GAS TX SETTINGS
  // ================================================================================================

  /**
   * Estimate gas usage for an arbitrage opportunity
   * Based on actual FlashArbitrage contract operations:
   * 1. Flash loan callback
   * 2. Two swaps (entry + exit)
   * 3. Two approvals (forceApprove per swap)
   * 4. Repayment + profit transfer
   */
  private estimateGasUsage(opportunity: ArbitrageOpportunity): bigint {
    let baseGasUsageEstimation =
      GasManager.BASE_COSTS.FLASH_LOAN_OVERHEAD +
      GasManager.BASE_COSTS.CONTRACT_OVERHEAD +
      GasManager.BASE_COSTS.TRANSFER_OVERHEAD +
      GasManager.COMBO_PENALTIES.CROSS_DEX + // assume cross dex by default
      GasManager.COMBO_PENALTIES.INTERMEDIATE_BALANCE;

    // go through each swap and add costs
    let swapGasUsageEstimation = 0n;
    for (const step of opportunity.steps) {
      swapGasUsageEstimation += this.getSwapCost(step.pool.protocol) + GasManager.BASE_COSTS.APPROVAL_OVERHEAD;
    }

    return baseGasUsageEstimation + swapGasUsageEstimation;
  }

  getSwapCost(dexType: DexProtocol): bigint {
    return GasManager.SWAP_COSTS[dexType];
  }

  /**
   * Get Gas Analysis based on opportunity
   */
  private getGasAnalysis(opportunity: ArbitrageOpportunity, gasEstimate: bigint) {
    const baseFeePerGas = this.baseFeePerGas;
    const nativeTokenPriceUSD = this.priceOracle.getPriceUSD(this.WRAPPED_NATIVE_TOKEN_ADDRESS)!;

    // THE CEILING OF HOW MUCH WE CAN AFFORD PAY FOR TOTAL GAS BASED ON GROSS PROFIT
    const gasBudgetETH = opportunity.grossProfitUSD / nativeTokenPriceUSD; // we can pay x ETH for total gas (resulting => 0 profit)
    const gasBudgetWEI = BigInt(Math.floor(gasBudgetETH * 1e18)); // we can pay x WEI for total gas (0 profit)

    // calculate base gas cost (in WEI) based on baseFeePerGas and estimated gas usage
    const baseGasCostWEI = gasEstimate * baseFeePerGas;
    const budgetAfterBaseGasCostWEI = gasBudgetWEI - baseGasCostWEI;
    if (budgetAfterBaseGasCostWEI <= 0) throw new Error('Skipping opportunity: budget after base gas cost is zero or negative');

    // cap gas budget to wallet balance
    let cappedGasBudgetWEI = gasBudgetWEI;
    if (cappedGasBudgetWEI > this.walletManager.getNativeTokenBalance()) {
      this.logger.warn(
        `⚠️  Capped gas budget ${this.formatGwei(gasBudgetWEI)} exceeds wallet balance funds ${this.formatGwei(
          this.walletManager.getNativeTokenBalance(),
        )}, capping gas budget to wallet balance`,
      );
      cappedGasBudgetWEI = this.walletManager.getNativeTokenBalance() - ethers.parseEther('0.001'); // keep small buffer
    }

    // calculate maxFeePerGas based on gasBudgetWEI and check if opportunity exceeds baseFee
    const maxFeePerGas = (cappedGasBudgetWEI * 5n) / 10n / gasEstimate; // set to 50% of gas budget
    const priorityFeeCap = maxFeePerGas - baseFeePerGas;

    const maxPriorityFeePerGas = this.calculateOptimalPriorityFeePerGas(
      opportunity.grossProfitUSD,
      priorityFeeCap,
      nativeTokenPriceUSD,
      gasEstimate,
    );
    const finalGasPricePerUnit = baseFeePerGas + maxPriorityFeePerGas; // in WEI
    const totalGasCostWEI = gasEstimate * finalGasPricePerUnit; // in WEI
    const totalGasCostUSD = (Number(totalGasCostWEI) / 1e18) * nativeTokenPriceUSD; // in USD

    return {
      gasData: {
        gasEstimate,
        baseFeePerGas,
        totalGasCostUSD,
        totalGasCostWEI,
        gasBudgetETH,
        gasBudgetWEI,
        baseGasCostWEI,
        budgetAfterBaseGasCostWEI,
        priorityFeeCap,
        nativeTokenPriceUSD,
        finalGasPricePerUnit, // baseFee + priority fee
      },
      gasTxSettings: {
        gasLimit: (gasEstimate * 120n) / 100n, // add 20% buffer
        maxFeePerGas, // threshold
        maxPriorityFeePerGas,
      },
    };
  }

  // when deciding how much priority fee we want to pay we need to take into consideration:
  // - profit (high profit => high urgency, we afford to pay more)
  // - network conditions (if baseFee its high => network congestion)
  private calculateOptimalPriorityFeePerGas(
    profitUSD: number,
    priorityFeeCap: bigint,
    nativeTokenPriceUSD: number,
    gasEstimate: bigint,
  ): bigint {
    if (priorityFeeCap < this.MIN_PRIORITY_FEE)
      throw new Error(
        `PriorityFeeCap (${this.formatGwei(priorityFeeCap)}) < ${this.formatGwei(this.MIN_PRIORITY_FEE)} MIN_PRIORITY`,
      );

    // STEP 1: Calculate base priority fee as % of gross profit: how much of gross profit are we willing to spend on priority?
    const profitBidPercentage = this.calculateProfitBidPercentage(profitUSD);

    // Convert to priority fee in WEI
    const profitBasedPriorityBudgetUSD = profitUSD * profitBidPercentage;
    const profitBasedPriorityBudgetWEI = BigInt(Math.floor((profitBasedPriorityBudgetUSD / nativeTokenPriceUSD) * 1e18));

    // Priority fee per gas unit
    let priorityFeePerGas = profitBasedPriorityBudgetWEI / gasEstimate;

    // STEP 2: Adjust for network congestion (competitive pressure)
    const baseFeeGwei = Number(this.baseFeePerGas) / 1e9;
    const congestionMultiplier = this.calculateCongestionMultiplier(baseFeeGwei);

    priorityFeePerGas = (priorityFeePerGas * BigInt(Math.round(congestionMultiplier * 100))) / 100n;

    // STEP 3: Apply constraints
    if (priorityFeePerGas < this.MIN_PRIORITY_FEE) priorityFeePerGas = this.MIN_PRIORITY_FEE;

    if (priorityFeePerGas > this.MAX_PRIORITY_FEE) {
      this.logger.warn(
        `⚠️  Capping PriorityFee at ${this.formatGwei(this.MAX_PRIORITY_FEE)} (was: ${this.formatGwei(priorityFeePerGas)})`,
      );
      priorityFeePerGas = this.MAX_PRIORITY_FEE;
    }
    if (priorityFeePerGas > priorityFeeCap) {
      this.logger.warn(
        `⚠️  PriorityFee ${this.formatGwei(priorityFeePerGas)} > ${this.formatGwei(priorityFeeCap)} priorityFeeCap`,
      );
      priorityFeePerGas = priorityFeeCap; // TODO: we should allow a risky trade like this?
    }
    return priorityFeePerGas;
  }

  /**
   * Calculate what % of gross profit we're willing to bid as priority fee
   *
   * Philosophy:
   * - Small profits ($5-20): Conservative bidding (5-10% of profit)
   * - Medium profits ($20-100): Moderate bidding (10-20% of profit)
   * - Large profits ($100+): Aggressive bidding (20-35% of profit)
   *
   * Rationale: Large opportunities are rarer and more competitive, so worth
   * paying more to secure them. Small opportunities are frequent, so be patient.
   */
  private calculateProfitBidPercentage(profitUSD: number): number {
    // Logarithmic curve for smooth scaling
    if (profitUSD >= 500) return 0.51; // 35% - Whale trades, very rare
    if (profitUSD >= 200) return 0.51; // 30% - Major opportunities
    if (profitUSD >= 100) return 0.51; // 25% - Large opportunities
    if (profitUSD >= 50) return 0.36; // 20% - Good opportunities
    if (profitUSD >= 30) return 0.33; // 15% - Decent opportunities
    if (profitUSD >= 20) return 0.33; // 12% - Small-medium
    if (profitUSD >= 10) return 0.33; // 10% - Small opportunities
    if (profitUSD >= 5) return 0.33; // 8% - Tiny opportunities
    return 0.33; // 5% - Micro opportunities (be patient)
  }

  /**
   * Adjust bidding aggressiveness based on network congestion
   *
   * Logic: When baseFee is high, more arbitrageurs are active (competitive).
   * Need to bid higher % to win transactions.
   */
  private calculateCongestionMultiplier(baseFeeGwei: number): number {
    // More conservative multipliers - network conditions are just a hint
    if (baseFeeGwei >= 100) return 1.5; // Very competitive
    if (baseFeeGwei >= 80) return 1.4; // High competition
    if (baseFeeGwei >= 50) return 1.3; // Moderate-high competition
    if (baseFeeGwei >= 30) return 1.2; // Moderate competition
    if (baseFeeGwei >= 15) return 1.15; // Light competition
    if (baseFeeGwei >= 5) return 1.112; // Normal competition
    return 1.061; // Very quiet (slightly above minimum)
  }

  // ================================================================================================
  // UTILS
  // ================================================================================================

  private formatGwei(wei: bigint): string {
    return (Number(wei) / 1e9).toFixed(8) + ' gwei';
  }

  // ================================================================================================
  // CLEANUP
  // ================================================================================================
  cleanup(): void {
    // cleanup intervals
    // this.logger.info('🧹 GasManager cleanup completed');
  }
}
