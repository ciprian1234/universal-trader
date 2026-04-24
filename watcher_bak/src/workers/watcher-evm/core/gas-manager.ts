import { ethers } from 'ethers';
import { Blockchain } from './blockchain';
import { createLogger, type Logger } from '@/utils';
import { WalletManager } from './wallet-manager';
import type { ChainConfig } from '@/config/models';
import type { DexProtocol } from '@/shared/data-model/layer1';
import type { BlockEntry } from './block-manager';
import { formatGwei } from './helpers';
import type { ArbitragePath } from './arbitrage/interfaces';
import type { GasAnalysis } from './interfaces';

type GasManagerInput = {
  chainConfig: ChainConfig;
  blockchain: Blockchain;
  walletManager: WalletManager;
};

export class GasManager {
  private readonly logger: Logger;
  private readonly chainConfig: ChainConfig;
  private readonly blockchain: Blockchain;

  private readonly MIN_PRIORITY_FEE: bigint;
  private readonly MAX_PRIORITY_FEE: bigint;

  private blockCounter = 0;
  private baseFeePerGas: bigint = ethers.parseUnits('1', 'gwei'); // latest base fee (updated every x blocks)
  private nativeTokenPriceUSD: number = 0; // latest native token price in USD (updated every x blocks)

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

    // get wrapped native token
    this.MIN_PRIORITY_FEE = this.chainConfig.minPriorityFee;
    this.MAX_PRIORITY_FEE = this.chainConfig.maxPriorityFee;

    // placeholder until we fetch real price from oracle (quickly updated at init)
    this.nativeTokenPriceUSD = 1000;
  }

  setNativeTokenPriceUSD(price: number) {
    this.nativeTokenPriceUSD = price;
  }

  getBaseFeePerGas(): bigint {
    return this.baseFeePerGas;
  }

  // ================================================================================================
  // EVENT HANDLER
  // ================================================================================================
  async handleNewBlockEvent({ number, receivedTimestamp }: BlockEntry) {
    if (this.blockCounter++ % this.chainConfig.gasDataFetchInterval !== 0) return; // Fetch Block data every X blocks
    const data = await this.blockchain.getBlock(number); // only fetch once per x events TBD
    if (!data?.baseFeePerGas) return; // block data unavailable, skip silently
    this.baseFeePerGas = data!.baseFeePerGas!;
    const baseFeePerGasFormatted = formatGwei(data!.baseFeePerGas!);
    const gasUsagePercent = ((Number(data!.gasUsed) / Number(data!.gasLimit)) * 100).toFixed(2);
    const deltaReceived = receivedTimestamp - data!.timestamp * 1000;
    const deltaProcessed = Date.now() - receivedTimestamp;
    this.logger.debug(
      `⛽ Block ${number} (mined ${deltaReceived}ms ago) - gasUsed: ${gasUsagePercent}%  baseFeePerGas: ${baseFeePerGasFormatted} (+${deltaProcessed}ms)`,
    );
  }

  // ================================================================================================
  // GAS RESULT FACADE FUNCTION
  // ================================================================================================
  getGasAnalysis(path: ArbitragePath, grossProfitUSD: number): GasAnalysis | null {
    const gasEstimate = this.estimateGasUsage(path);

    const baseFeePerGas = (this.baseFeePerGas * 110n) / 100n; // add a 10% buffe to be safe
    const gasPricePerUnit = baseFeePerGas + this.MIN_PRIORITY_FEE;
    const gasCostWEI = gasEstimate * gasPricePerUnit;
    const gasCostUSD = (Number(gasCostWEI) / 1e18) * this.nativeTokenPriceUSD;
    if (gasCostUSD > grossProfitUSD) return null; // not profitable after gas

    return {
      gasEstimate,
      gasCostWEI,
      gasCostUSD,
      baseFeePerGas,
      nativeTokenPriceUSD: this.nativeTokenPriceUSD,
      gasTxSettings: {
        gasLimit: (gasEstimate * 130n) / 100n, // add 30% buffer
        maxFeePerGas: gasPricePerUnit, // safe ceiling: base fee can never double in one block
        maxPriorityFeePerGas: this.MIN_PRIORITY_FEE,
      },
    };
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
  private estimateGasUsage(path: ArbitragePath): bigint {
    let baseGasUsageEstimation =
      GasManager.BASE_COSTS.FLASH_LOAN_OVERHEAD +
      GasManager.BASE_COSTS.CONTRACT_OVERHEAD +
      GasManager.BASE_COSTS.TRANSFER_OVERHEAD +
      GasManager.COMBO_PENALTIES.CROSS_DEX + // assume cross dex by default
      GasManager.COMBO_PENALTIES.INTERMEDIATE_BALANCE;

    // go through each swap and add costs
    let swapGasUsageEstimation = 0n;
    for (const step of path.steps) {
      swapGasUsageEstimation += this.getSwapCost(step.pool.protocol) + GasManager.BASE_COSTS.APPROVAL_OVERHEAD;
    }

    return baseGasUsageEstimation + swapGasUsageEstimation;
  }

  getSwapCost(dexType: DexProtocol): bigint {
    return GasManager.SWAP_COSTS[dexType];
  }

  // ================================================================================================
  // CLEANUP
  // ================================================================================================
  cleanup(): void {
    // cleanup intervals
    // this.logger.info('🧹 GasManager cleanup completed');
  }
}
