import { ethers } from 'ethers';
import { createLogger, type Logger } from '@/utils';
import type { ArbitrageOpportunity } from '../interfaces';
import { DexProtocolEnum, type Trade, type SwapStepOnContract } from './flash-arbitrage-config';
import { EventBus } from '../event-bus';
import type { ChainConfig } from '@/config/models';
import type { Blockchain } from '../blockchain';
import type { BlockEntry, BlockManager } from '../block-manager';
import type { WalletManager } from '../wallet-manager';
import { FlashbotsService } from './flashbots-service';
import type { FlashbotsTransactionResponse } from '@flashbots/ethers-provider-bundle';
import type { WorkerDb } from '../../db';
import type { DexProtocol, DexVenueName } from '@/shared/data-model/layer1';
import type { DexManager } from '../dex-manager';
import { FLASH_ARBITRAGE_ABI } from './flash-arbitrage-contract-abi';

export type FlashArbitrageHandlerInput = {
  chainConfig: ChainConfig;
  eventBus: EventBus;
  db: WorkerDb;
  blockchain: Blockchain;
  blockManager: BlockManager;
  dexManager: DexManager;
  walletManager: WalletManager;
};

interface ExecuteTransactionResponse {
  tx: ethers.TransactionResponse;
  bundle: string[] | null;
  bundleResponse: FlashbotsTransactionResponse | null;
}

interface QueuedOpportunity {
  opportunity: ArbitrageOpportunity;
  queuedAt: number;
}

interface PendingExecution {
  opportunity: ArbitrageOpportunity;
  response?: ExecuteTransactionResponse;
  trade?: Trade;
  bundle?: string[] | null; // signed bundle (only if using Flashbots)
  submittedAt?: number;
  submittedAtBlock?: number;
}

export class FlashArbitrageHandler {
  private readonly logger: Logger;
  private readonly chainConfig: ChainConfig;
  private readonly eventBus: EventBus;
  private readonly db: WorkerDb;
  private readonly dexManager: DexManager;
  private readonly blockchain: Blockchain;
  private readonly blockManager: BlockManager;
  private readonly contract: ethers.Contract | null = null;
  private readonly walletManager: WalletManager;
  private readonly flashbotsService?: FlashbotsService; // OPTIONAL Flashbots service

  // config
  private readonly ENABLE_FLASH_ARBITRAGE: boolean;
  private readonly USE_FLASHBOTS: boolean;
  private readonly MIN_PRIORITY_FEE: bigint;

  // SAFE STRATEGY: Queue for pending opportunities
  private opportunityQueue: QueuedOpportunity[] = [];

  // Track pending executions
  private pendingExecutions = new Map<string, PendingExecution>(); // opportunityId -> execution
  private blockEventUnsubscribe?: () => void;

  constructor(input: FlashArbitrageHandlerInput) {
    this.logger = createLogger(`[${input.chainConfig.name}.FlashArbitrageHandler]`);
    this.chainConfig = input.chainConfig;
    this.eventBus = input.eventBus;
    this.db = input.db;
    this.blockchain = input.blockchain;
    this.blockManager = input.blockManager;
    this.walletManager = input.walletManager;
    this.dexManager = input.dexManager;

    // config
    this.ENABLE_FLASH_ARBITRAGE = true;
    this.USE_FLASHBOTS = this.chainConfig.flashbotsEnabled;
    this.MIN_PRIORITY_FEE = this.chainConfig.minPriorityFee;

    // Create contract instance only if flash arbitrage is enabled
    if (!this.ENABLE_FLASH_ARBITRAGE) return;
    this.contract = new ethers.Contract(
      this.chainConfig.arbitrageContractAddress,
      FLASH_ARBITRAGE_ABI,
      this.walletManager.getSigner(),
    );

    this.flashbotsService = this.flashbotsService = new FlashbotsService({
      logger: createLogger(`[${input.chainConfig.name}.FlashbotsService]`),
      blockchain: this.blockchain,
      blockManager: this.blockManager,
      config: {
        relayUrl: this.chainConfig.flashbots?.relayUrl || 'https://relay.flashbots.net',
        authSignerKey: this.chainConfig.flashbots?.authSignerKey, // Required for building reputation (otherwise random wallet its created)
      },
    });

    // Log Flashbots status
    if (this.USE_FLASHBOTS && this.flashbotsService) {
      this.logger.info('Flashbots integration enabled');
      this.logger.info('✅ Using PARALLEL EXECUTION STRATEGY: executing opportunities immediately');
    } else {
      this.logger.warn('Flashbots integration disabled (using standard transactions)');
      this.logger.info('✅ Using SAFE STRATEGY: queued opportunity execution (one by one) to avoid nonce conflicts');
    }
  }

  // ================================================================================================
  // EVENT HANDLER
  // ================================================================================================

  // Subscribe to new blocks to monitor pending executions
  subscribeToNewBlocksEvents() {
    if (this.blockEventUnsubscribe) return this.logger.warn('⚠️ Already subscribed to new block events, skipping...');

    this.logger.info(`✅ Subscribed to new blocks events for monitoring pending execution(s)`);
    this.blockEventUnsubscribe = this.eventBus.onNewBlock((block) => {
      if (this.pendingExecutions.size === 0) return;
      this.logger.info(`🔍 NewBlock ${block.number} - Monitoring ${this.pendingExecutions.size} pending execution(s)`);
      this.checkPendingExecutions(block).catch((error) => {
        this.logger.error(`❌ Check pending execution failed:`, error.message);
      });
      // TODO: check also opportunity queue?
    });
  }

  handleNewArbitrageOpportunityEvent(opportunity: ArbitrageOpportunity) {
    if (this.USE_FLASHBOTS) this.handleParallelExecution(opportunity);
    else this.handleSequentialExecution(opportunity);
  }

  /**
   * Execute opportunity immediately (PARALLEL STRATEGY)
   * May cause nonce conflicts on L2s if multiple opportunities detected in quick succession
   */
  private async handleParallelExecution(opportunity: ArbitrageOpportunity) {
    this.logger.info(`${'='.repeat(120)}`);
    this.logger.info(`📥 New opportunity (PARALLEL): ${opportunity.id} (GrossProfit: $${opportunity.grossProfitUSD.toFixed(2)})`);

    // ✅ Execute immediately (don't wait)
    this.logger.info(`🚀 Execution ${opportunity.id} started (non-blocking)`);
    this.executeArbitrage(opportunity).catch((error) => {
      this.logger.error(`❌ Parallel execution ${opportunity.id} failed:`, error.message);
    });
  }

  /**
   * Queue opportunity for execution (SAFE STRATEGY)
   * Multiple opportunities are queued and executed one by one
   */
  private async handleSequentialExecution(opportunity: ArbitrageOpportunity) {
    this.opportunityQueue.push({ opportunity, queuedAt: Date.now() });

    // ensure oportunities are sorted by grossProfitUSD descending (grossProfitUSD)
    this.opportunityQueue.sort((a, b) => b.opportunity.grossProfitUSD - a.opportunity.grossProfitUSD);

    this.logger.info(`${'='.repeat(120)}`);
    this.logger.info(`📥 Queued opportunity: ${opportunity.id} (GrossProfit: $${opportunity.grossProfitUSD.toFixed(2)})`);
    this.logger.info(`   Queue size: ${this.opportunityQueue.length} | Pending executions: ${this.pendingExecutions.size}`);

    // process the queue => Pick next opportunity by profit (highest grossProfitUSD)
    await this.processOpportunityQueue();
    this.logger.info(`✅ Queue processing complete (${this.opportunityQueue.length} remaining)`);
  }

  /**
   * Process opportunity queue (if any)
   * Called when a new opportunity is added or after pending executions are cleared
   */
  private async processOpportunityQueue() {
    this.logger.info(`🔄 Processing opportunity queue, size: ${this.opportunityQueue.length}`);
    if (this.opportunityQueue.length === 0) return this.logger.info('✅ Opportunity queue is empty, nothing to process');
    if (this.pendingExecutions.size > 0) return this.logger.info('⏸️ Skipping queue processing due to pending executions...');

    // process the queue => Pick next opportunity by profit (highest grossProfitUSD)
    const pick = this.opportunityQueue.shift()!;
    try {
      this.pendingExecutions.set(pick.opportunity.id, { opportunity: pick.opportunity }); // needs to be set now for sequential processing
      const waitedInQueue = Date.now() - pick.queuedAt;
      this.logger.info(`📤 Processing queued opportunity ${pick.opportunity.id} (waited in queue: ${waitedInQueue}ms)`);
      await this.executeArbitrage(pick.opportunity);
    } catch (error) {
      this.logger.error(`❌ Error executing opportunity ${pick.opportunity.id}:`, { error });
    }
  }

  /**
   * Check pending executions on new block
   */
  private async checkPendingExecutions(newBlock: BlockEntry) {
    const confirmedAtBlock = newBlock.number;

    for (const [opportunityId, execution] of this.pendingExecutions) {
      try {
        this.logger.info(`🔍 Checking pending execution for opportunity ${opportunityId} (tx: ${execution.response?.tx.hash})`);
        const txHash = execution.response?.tx.hash;
        if (!txHash) throw new Error('Missing txHash in pending execution');

        // STEP 1: Check if transaction was mined
        const receipt = await this.blockchain.getTransactionReceipt(txHash);
        if (receipt) {
          const receiptStatus = receipt.status === 1 ? '✅ success' : '❌ revert';
          this.logger.info(`Execution of ${opportunityId} mined in block ${receipt.blockNumber} - status: ${receiptStatus}`);
          // perform post-execution analysis and update execution record and cleanup
          await this.analyzeConfirmedExecution(execution.opportunity, receipt, newBlock);
          this.pendingExecutions.delete(opportunityId);
          // this.processOpportunityQueue(); // process next opportunity in queue (if any)
          continue;
        }

        // STEP 1b: If using Flashbots, check bundle stats from previous block
        if (process.env.USE_FLASHBOTS) {
          const bundleStats = await this.flashbotsService!.getBundleStats(
            execution.response!.bundleResponse!.bundleHash,
            newBlock.number - 1,
          );
          this.logger.info(`Flashbots bundle stats at submission`, { bundleStats });
        }

        // STEP 2: Check if execution is still valid
        // NOTE: take new baseGasFee into account (TBD)
        const validateResponse = await this.validatePreExecution(execution.opportunity, execution.trade!); // TBD: recalculate gas
        if (!validateResponse.success) {
          this.logger.warn(`⚠️ Execution of ${opportunityId} is no longer valid`);
          if (process.env.USE_FLASHBOTS) {
            // Flashbots bundles can't be cancelled, just mark as invalidated
            this.logger.info(`⏳ Flashbots bundle will expire automatically if not included`);
            await this.db.pushArbitrageLog(opportunityId, {
              status: 'invalidated',
              confirmedAtBlock,
              logEntry: { msg: 'Execution invalidated while pending in Flashbots (will expire automatically)' },
            });
          } else {
            await this.cancelTransaction(txHash);
            await this.db.pushArbitrageLog(opportunityId, {
              status: 'cancelled',
              confirmedAtBlock,
              logEntry: { msg: 'Execution cancelled while pending in mempool' },
            });
          }

          // Try next opportunity
          this.pendingExecutions.delete(opportunityId);
          // this.processOpportunityQueue(); // Try next opportunity
          continue;
        }

        // if we reach here => execution is still valid
        if (process.env.USE_FLASHBOTS) {
          this.logger.info(`⏳ Execution of ${opportunityId} is still valid... Resubmit bundle`);
          // Simulate bundle and send if successful
          await this.flashbotsService!.simulateBundle(execution.bundle!, newBlock.number + 1);
          const bundleResponse = await this.flashbotsService!.submitBundle(execution.bundle!, {
            targetBlock: newBlock.number + 1,
          }); // non-blocking
          execution.response!.bundleResponse = bundleResponse; // update bundle response
        } else {
          this.logger.info(`⏳ Execution of ${opportunityId} is still valid and probably pending in mempool...`);
          // Check if transaction is still in mempool
          const currentTx = await this.blockchain.getTransaction(txHash);
          if (!currentTx) {
            // TBD: might never happen => investigate further in future if this occurs
            const msg = `Transaction ${txHash} not found in mempool`;
            this.logger.warn(msg);
            await this.db.pushArbitrageLog(opportunityId, { status: 'dropped', confirmedAtBlock, logEntry: { msg } });
            this.pendingExecutions.delete(opportunityId);
            // this.processOpportunityQueue(); // process next opportunity in queue (if any)
            continue;
          }
          // Transaction still in mempool, nothing to do
          this.logger.info(`✅ Transaction ${txHash} still pending in mempool`);
          // TBD: optionally implement speed-up logic here
        }
      } catch (error) {
        const msg = `Error checking pending execution for opportunity ${opportunityId}: ${(error as Error).message}`;
        this.logger.error(msg);
        await this.db.pushArbitrageLog(opportunityId, { status: 'error', confirmedAtBlock, logEntry: { msg, error } });

        this.pendingExecutions.delete(opportunityId);
        // this.processOpportunityQueue();
      }
    }

    // unsubscribe from block events if no more pending executions to monitor
    if (this.pendingExecutions.size === 0 && this.blockEventUnsubscribe) {
      this.logger.info('✅ No more pending executions, unsubscribing from new block events');
      this.blockEventUnsubscribe();
      this.blockEventUnsubscribe = undefined;
    }
  }

  /**
   * Execute arbitrage opportunity
   */
  async executeArbitrage(opportunity: ArbitrageOpportunity) {
    let response: ExecuteTransactionResponse | null = null;
    const trade = this.opportunityToTrade(opportunity); // Convert opportunity to Trade struct
    try {
      this.logger.info(`🎯 Starting FlashArbitrageExecution for opportunity: ${opportunity.id}`);

      // Validate pre-execution conditions
      const validateResponse = await this.validatePreExecution(opportunity, trade);
      if (!validateResponse.success) {
        this.db.pushArbitrageLog(opportunity.id, {
          status: 'invalid',
          logEntry: { msg: 'Pre-execution validation failed', error: validateResponse.error, trade },
        });
        return;
      }

      // Execute transaction: choose execution method (flashbots or standard)
      const useFlashbots = this.flashbotsService && process.env.USE_FLASHBOTS === 'true';
      if (useFlashbots)
        response = await this.executeViaFlashbots(trade, opportunity); // Execute via Flashbots (private mempool)
      else response = await this.executeViaStandardTx(trade, opportunity); // Standard execution (public mempool)
      if (!response.tx) throw new Error('Failed to send transaction');
      const nextBlockNumber = this.blockManager.getCurrentBlockNumber() + 1;
      this.logger.info(`🚀 Transaction sent, tx hash: ${response.tx.hash} (expected inclusion block: ${nextBlockNumber})`);

      // subscribe to new blocks to monitor pending execution (if not already subscribed)
      this.subscribeToNewBlocksEvents();

      // store entry in pending executions
      this.pendingExecutions.set(opportunity.id, {
        opportunity,
        response,
        trade,
        bundle: response.bundle,
        submittedAt: Date.now(),
        submittedAtBlock: nextBlockNumber,
      });

      // push pending log with transaction details
      await this.db.pushArbitrageLog(opportunity.id, {
        status: 'pending',
        logEntry: {
          submittedAtBlock: nextBlockNumber,
          trade,
          tx: { tx: response.tx, bundleHash: response.bundleResponse?.bundleHash },
        },
      });
    } catch (error: any) {
      this.logger.error(`❌ Failed execution of opportunity: ${opportunity.id}`, { error });
      await this.db.pushArbitrageLog(opportunity.id, { status: 'error', logEntry: { error } });

      // delete from pending executions
      this.pendingExecutions.delete(opportunity.id);
      // this.processOpportunityQueue(); // process next opportunity in queue (if any)
      // balance check its not required here because transaction didnt went through
    }
  }

  /**
   * Execute via standard transaction (public mempool)
   */
  private async executeViaStandardTx(trade: Trade, opportunity: ArbitrageOpportunity): Promise<ExecuteTransactionResponse> {
    this.logger.info('🌐 Executing via standard transaction (public mempool)...');
    const tx = await this.contract!.executeTrade(trade, opportunity.gasAnalysis!.gasTxSettings);
    return { tx, bundle: null, bundleResponse: null };
  }

  /**
   * Execute via Flashbots (private mempool)
   */
  private async executeViaFlashbots(trade: Trade, opportunity: ArbitrageOpportunity): Promise<ExecuteTransactionResponse> {
    if (!this.flashbotsService) throw new Error('Flashbots service not initialized');
    this.logger.info('🔐 Executing via Flashbots (private mempool)...');

    const gasAnalysis = opportunity.gasAnalysis!;

    // =================== BRIBE CALCULATION ======================
    // Step 1: Define gas parameters
    const baseFeePerGas = gasAnalysis.baseFeePerGas;
    const BASE_FEE_BUFFER_PERCENT = 125; // 125% = 25% buffer (protects against 3-4 block spikes)
    const bufferedBaseFee = (baseFeePerGas * BigInt(BASE_FEE_BUFFER_PERCENT)) / 100n;
    const arbitrageGasEstimate = gasAnalysis.gasEstimate; // TBD: consider using limit for safety
    const bribeGasLimit = 21000n; // Standard ETH transfer
    const gasPricePerUnit = bufferedBaseFee + this.MIN_PRIORITY_FEE;

    // Step 2: Calculate total gas costs (base fee + minimal priority)
    const arbitrageGasCostWEI = arbitrageGasEstimate * gasPricePerUnit;
    const bribeGasCostWEI = bribeGasLimit * gasPricePerUnit;
    const totalGasCostWEI = arbitrageGasCostWEI + bribeGasCostWEI;

    // ignore original calculation of maxFeePerGas and PriorityFee
    const gasBudgetWEI = gasAnalysis.gasData.gasBudgetWEI as bigint; // budget based on gross profit
    const budgetAfterGasCostWEI = gasBudgetWEI - totalGasCostWEI;

    // ✅ Step 4: Validate budget is positive
    if (budgetAfterGasCostWEI <= 0n) {
      throw new Error(
        `Insufficient budget for bribe: ` +
          `budget=${ethers.formatEther(gasBudgetWEI)} ETH, ` +
          `gas=${ethers.formatEther(totalGasCostWEI)} ETH`,
      );
    }

    // allocate 80% of remaining budget to bribe
    let bribeWEI = (budgetAfterGasCostWEI * 8n) / 10n;
    if (bribeWEI > ethers.parseEther('0.025')) bribeWEI = ethers.parseEther('0.025'); // cap bribe to 0.025 ETH for now

    this.logger.info('💰 Bribe Calculation Breakdown:');
    this.logger.info(`   Gas Budget: ${ethers.formatEther(gasBudgetWEI)} ETH`);
    this.logger.info(`   Arbitrage Gas Cost: ${ethers.formatEther(arbitrageGasCostWEI)} ETH`);
    this.logger.info(`   Bribe Tx Gas Cost: ${ethers.formatEther(bribeGasCostWEI)} ETH`);
    this.logger.info(`   Total Gas Cost: ${ethers.formatEther(totalGasCostWEI)} ETH`);
    this.logger.info(`   Budget After Gas: ${ethers.formatEther(budgetAfterGasCostWEI)} ETH`);

    // Step 8: Calculate net profit
    const profitETH = opportunity.grossProfitUSD / gasAnalysis.gasData.nativeTokenPriceUSD;

    const totalCostWEI = totalGasCostWEI + bribeWEI;
    const totalCostETH = Number(totalCostWEI) / 1e18;
    const netProfitETH = profitETH - totalCostETH;
    const netProfitUSD = netProfitETH * gasAnalysis.gasData.nativeTokenPriceUSD;

    // Log final pricing
    this.logger.info('📊 Final Bundle Pricing:');
    this.logger.info(`   Gross Profit: ${profitETH.toFixed(6)} ETH ($${opportunity.grossProfitUSD.toFixed(2)})`);
    this.logger.info(`   Base Fee: ${ethers.formatUnits(baseFeePerGas, 'gwei')} gwei`);
    this.logger.info(`   Buffered Base Fee: ${ethers.formatUnits(bufferedBaseFee, 'gwei')} gwei`);
    this.logger.info(`   Gas Price Per Unit (maxFeePerGas): ${ethers.formatUnits(gasPricePerUnit, 'gwei')} gwei`);
    this.logger.info(`   Priority Fee: ${ethers.formatUnits(this.MIN_PRIORITY_FEE, 'gwei')} gwei (minimal)`);
    this.logger.info(`   Arbitrage Gas Cost: ${ethers.formatEther(arbitrageGasCostWEI)} ETH`);
    this.logger.info(`   Bribe Tx Gas Cost: ${ethers.formatEther(bribeGasCostWEI)} ETH`);
    this.logger.info(
      `   Coinbase Bribe: ${ethers.formatEther(bribeWEI)} ETH ($${(
        (Number(bribeWEI) / 1e18) *
        gasAnalysis.gasData.nativeTokenPriceUSD
      ).toFixed(2)})`,
    );
    this.logger.info(`   Total Cost: ${totalCostETH.toFixed(6)} ETH`);
    this.logger.info(`   Net Profit: ${netProfitETH.toFixed(6)} ETH ($${netProfitUSD.toFixed(2)})`);
    this.logger.info(`   ROI: ${((netProfitETH / totalCostETH) * 100).toFixed(1)}%`);

    // ✅ Step 9: Validate still profitable
    if (netProfitETH <= 0) {
      throw new Error(
        `Not profitable after bribe: ` +
          `profit=${profitETH.toFixed(6)} ETH, ` +
          `cost=${totalCostETH.toFixed(6)} ETH, ` +
          `net=${netProfitETH.toFixed(6)} ETH`,
      );
    }

    // ============================================================

    // Build transaction
    const signer = this.walletManager.getSigner();
    const nonce = await signer.getNonce();
    const tx = await this.contract!.executeTrade.populateTransaction(trade);

    const unsignedArbitrageTx = {
      ...tx,
      nonce,
      chainId: this.blockchain.chainId,
      gasLimit: gasAnalysis!.gasTxSettings.gasLimit,
      maxFeePerGas: gasPricePerUnit,
      maxPriorityFeePerGas: this.MIN_PRIORITY_FEE,
      type: 2, // EIP-1559
    };

    // Create coinbase bribe transaction
    const unsignedBribeTx = {
      to: '0x0000000000000000000000000000000000000000', // Placeholder (builder sets block.coinbase)
      value: bribeWEI,
      data: '0x',
      nonce: nonce + 1,
      chainId: this.blockchain.chainId,
      gasLimit: 21000n,
      maxFeePerGas: gasPricePerUnit,
      maxPriorityFeePerGas: this.MIN_PRIORITY_FEE, // Same as arbitrage tx
      type: 2, // EIP-1559
    };

    // Create bundle with signed transactions
    const bundle = await Promise.all([signer.signTransaction(unsignedArbitrageTx), signer.signTransaction(unsignedBribeTx)]);
    const targetBlock = this.blockManager.getCurrentBlockNumber() + 1;

    // Simulate bundle and send if successful
    await this.flashbotsService.simulateBundle(bundle, targetBlock);
    const bundleResponse = await this.flashbotsService.submitBundle(bundle, { targetBlock }); // non-blocking

    // !!! Parse transaction to get hash
    const parsedArbitrageTx = ethers.Transaction.from(bundle[0]);
    const txHash = parsedArbitrageTx.hash!;

    return {
      tx: {
        hash: txHash,
        nonce,
        from: parsedArbitrageTx.from!,
        to: parsedArbitrageTx.to!,
        data: parsedArbitrageTx.data,
        value: parsedArbitrageTx.value,
        gasLimit: parsedArbitrageTx.gasLimit,
        gasPrice: parsedArbitrageTx.gasPrice,
        maxFeePerGas: parsedArbitrageTx.maxFeePerGas,
        maxPriorityFeePerGas: parsedArbitrageTx.maxPriorityFeePerGas,
        chainId: parsedArbitrageTx.chainId,
        type: parsedArbitrageTx.type,
      } as ethers.TransactionResponse,
      bundle,
      bundleResponse,
    };
  }

  /**
   * Convert ArbitrageOpportunity to Trade struct
   */
  private opportunityToTrade(opportunity: ArbitrageOpportunity): Trade {
    // go trough each swap step and build Trade struct
    const swaps: SwapStepOnContract[] = [];
    for (const step of opportunity.steps) {
      swaps.push({
        dexProtocol: FlashArbitrageHandler.getDexTypeEnumValueFromPool(step.pool.protocol),
        poolAddress: step.pool.address,
        tokenIn: step.tokenIn.address,
        tokenOut: step.tokenOut.address,
        amountIn: step.amountIn,
        amountOutMin: 0n, // don't care about min output on entry swap
        feeBps: step.pool.feeBps,
        zeroForOne: step.pool.tokenPair.token0.address === step.tokenIn.address, // determine swap direction based on tokenIn

        // extra params for other DEX protocols (not used for now => set to 0 or empty)
        poolId: '0x0000000000000000000000000000000000000000000000000000000000000000',
        curveIndexIn: 0,
        curveIndexOut: 0,
        extraData: '0x',
      });
    }

    // on last swap, set amountOutMin based on opportunity grossProfitUSD (slippage already accounted for)
    // NOTE: needed to protect against front-running or slippage during execution
    const amountOutMin = opportunity.borrowAmount + (opportunity.grossProfitToken * 5n) / 10n; // set min output based on min 50% of gross profit
    swaps[swaps.length - 1].amountOutMin = amountOutMin;

    return { swaps };
  }

  /**
   * Map interface DexType to contract enum
   */
  static getDexTypeEnumValueFromPool(dexProtocol: DexProtocol): DexProtocolEnum {
    switch (dexProtocol) {
      case 'v2':
        return DexProtocolEnum.UNISWAP_V2;
      case 'v3':
        return DexProtocolEnum.UNISWAP_V3;
      case 'v4':
        return DexProtocolEnum.UNISWAP_V4;
      // case 'curvestable':
      //   return DexProtocolEnum.CURVE;
      // case 'balancerweighted':
      //   return DexProtocolEnum.BALANCER;
      default:
        throw new Error(`Unsupported DEX protocol: ${dexProtocol}`);
    }
  }

  /**
   * Check if contract is properly configured
   */
  async validateContract() {
    if (!process.env.ENABLE_FLASH_ARBITRAGE) return;
    this.logger.info(`🔍 Validating FlashArbitrageContract`);
    const owner = await this.contract!.owner();
    const signerAddress = await this.walletManager.getSigner().getAddress();

    this.logger.info(`📋 Contract owner: ${owner}`);
    this.logger.info(`📋 Signer address: ${signerAddress}`);

    if (owner.toLowerCase() !== signerAddress.toLowerCase()) throw new Error('Signer is not the contract owner');
    this.logger.info(`✅ Validated FlashArbitrageContract: ${this.chainConfig.arbitrageContractAddress}`);
  }

  /**
   * Validate pre-execution conditions
   */
  private async validatePreExecution(
    opportunity: ArbitrageOpportunity,
    trade: Trade,
  ): Promise<{ success: boolean; error: null | any }> {
    try {
      // Basic sanity checks on trade structure
      if (trade.swaps.length < 2) throw new Error('Need at least 2 swaps for arbitrage');
      if (trade.swaps[0].tokenIn !== trade.swaps[trade.swaps.length - 1].tokenOut)
        throw new Error(`EntryTokenIn != ExitTokenOut`);
      for (let i = 0; i < trade.swaps.length - 1; i++) {
        if (trade.swaps[i].tokenOut !== trade.swaps[i + 1].tokenIn) {
          throw new Error(`Swap chain broken between swaps ${i} and ${i + 1}`);
        }
      }

      // Simulate transaction before sending (via static call)
      this.logger.info(`🔍 Simulating trade on-chain via static call...`);
      const simulationResult = await this.contract!.executeTrade.staticCall(trade);
      this.logger.info(`✅ Pre-execution validation passed`, simulationResult);
      return { success: true, error: null };
    } catch (error: any) {
      // remove opportunity from pending executions
      this.pendingExecutions.delete(opportunity.id);

      // log error and update execution record
      this.logger.error(`❌ Pre-execution validation failed for ${opportunity.id}`, { error });
      return { success: false, error };
    }
  }

  /*
   * Analyze confirmed execution and update execution record
   */
  private async analyzeConfirmedExecution(
    opportunity: ArbitrageOpportunity,
    receipt: ethers.TransactionReceipt,
    block: BlockEntry,
  ) {
    // update wallet
    const involvedTokens = [opportunity.steps[0].tokenIn, opportunity.steps[0].tokenOut];
    const actualWalletChanges = await this.walletManager.updateBalancesAfterTransaction(involvedTokens);

    const analysis = {
      // profit
      profit: {
        expectedProfitUSD: opportunity.netProfitUSD,
        actualWalletChanges,
      },

      // gas usage
      gasUsage: {
        expectedGasUsed: opportunity.gasAnalysis?.gasData.gasEstimate,
        actualGasUsed: receipt.gasUsed,
      },

      // gas price
      gasPrice: {
        networkBaseFeePerGas: opportunity.gasAnalysis?.gasData.baseFeePerGas,
        maxPriorityFeePerGas: opportunity.gasAnalysis?.gasTxSettings.maxPriorityFeePerGas,
        finalGasPricePerUnit: opportunity.gasAnalysis?.gasData.finalGasPricePerUnit,
        actualGasPrice: receipt.gasPrice,
      },
    };

    // update execution status in db
    this.logger.info(`Transaction: https://etherscan.io/tx/${receipt.hash}`);
    const status = receipt.status === 1 ? 'success' : 'revert';
    await this.db.pushArbitrageLog(opportunity.id, { status, confirmedAtBlock: block.number, logEntry: { receipt, analysis } });
  }

  /**
   * Speed up a pending transaction
   */
  async speedUpTransaction(txHash: string): Promise<string | null> {
    try {
      const originalTx = await this.blockchain.getTransaction(txHash);
      if (!originalTx) return null;

      const receipt = await this.blockchain.getTransactionReceipt(txHash);
      if (receipt) {
        this.logger.info(`⚠️ Transaction ${txHash} already mined`);
        return null;
      }

      const signer = this.walletManager.getSigner();

      // Create speed-up transaction (same transaction with higher gas)
      const speedUpTx = {
        to: originalTx.to,
        value: originalTx.value,
        data: originalTx.data,
        nonce: originalTx.nonce,
        gasLimit: originalTx.gasLimit,
        maxFeePerGas: (originalTx.maxFeePerGas! * 150n) / 100n, // 50% higher
        maxPriorityFeePerGas: (originalTx.maxPriorityFeePerGas! * 150n) / 100n,
      };

      this.logger.info(`🚀 Speeding up transaction ${txHash}...`);
      const response = await signer.sendTransaction(speedUpTx);
      this.logger.info(`📤 Speed-up transaction sent: ${response.hash}`);

      return response.hash;
    } catch (error: any) {
      this.logger.error(`❌ Error speeding up transaction:`, error.message);
      return null;
    }
  }

  /**
   * Cancel a pending transaction
   */
  async cancelTransaction(txHash: string): Promise<string | null> {
    try {
      const originalTx = await this.blockchain.getTransaction(txHash);
      if (!originalTx) {
        this.logger.warn(`❌ Transaction ${txHash} not found`);
        return null;
      }

      // Check if already mined
      const receipt = await this.blockchain.getTransactionReceipt(txHash);
      if (receipt) {
        this.logger.info(`⚠️ Transaction ${txHash} already mined, cannot cancel`);
        return null;
      }

      const signer = this.walletManager.getSigner();
      const signerAddress = await signer.getAddress();

      // Create cancellation transaction
      const cancelTx = {
        to: signerAddress,
        value: 0n,
        nonce: originalTx.nonce,
        gasLimit: 21000n,
        maxFeePerGas: (originalTx.maxFeePerGas! * 150n) / 100n, // 50% higher
        maxPriorityFeePerGas: (originalTx.maxPriorityFeePerGas! * 150n) / 100n,
      };

      this.logger.info(`🚫 Attempting to cancel transaction ${txHash}...`);
      const cancelResponse = await signer.sendTransaction(cancelTx);
      this.logger.info(`📤 Cancel transaction sent: ${cancelResponse.hash}`);

      return cancelResponse.hash;
    } catch (error: any) {
      this.logger.error(`❌ Error cancelling transaction ${txHash}:`, error.message);
      return null;
    }
  }

  /**
   * 🛑 SHUTDOWN
   */
  async shutdown(): Promise<void> {
    this.logger.info('Shutting down - verifying for pending executions...');

    // log any pending opportunities
    if (this.opportunityQueue.length > 0) {
      this.logger.warn(`⚠️ ${this.opportunityQueue.length} opportunity(s) still in queue at shutdown`);
      for (const queued of this.opportunityQueue) this.logger.info(`   - ${queued.opportunity.id}`);
    }

    // Log any remaining pending executions
    if (this.pendingExecutions.size > 0) {
      this.logger.warn(`⚠️ ${this.pendingExecutions.size} execution(s) still pending at shutdown`);
      for (const [txHash, pending] of this.pendingExecutions) this.logger.info(`   - ${pending.opportunity.id}: ${txHash}`);
    }

    // Unsubscribe from block events
    if (this.blockEventUnsubscribe) this.blockEventUnsubscribe();
  }
}
