import { ethers } from 'ethers';
import { createLogger, displayOpportunity, type Logger } from '@/utils';
import type { ArbitrageOpportunity } from '../interfaces';
import { DexProtocolEnum, type SwapStepOnContract } from './flash-arbitrage-config';
import { EventBus } from '../event-bus';
import type { ChainConfig } from '@/config/models';
import type { Blockchain, Multical3Input } from '../blockchain';
import type { BlockEntry, BlockManager } from '../block-manager';
import type { WalletManager } from '../wallet-manager';
import { FlashbotsService } from './flashbots-service';
import type { FlashbotsTransactionResponse } from '@flashbots/ethers-provider-bundle';
import type { DexProtocol } from '@/shared/data-model/layer1';
import type { DexManager } from '../dex-manager';
import { FLASH_ARBITRAGE_ABI } from './flash-arbitrage-contract-abi';
import { denormalizeTokenAddr } from '../helpers';
import type { PriceOracle } from '../price-oracle';
import type { ArbitrageOrchestrator } from '../arbitrage/arbitrage-orchestrator';

export type FlashArbitrageHandlerInput = {
  chainConfig: ChainConfig;
  eventBus: EventBus;
  blockchain: Blockchain;
  blockManager: BlockManager;
  dexManager: DexManager;
  walletManager: WalletManager;
  priceOracle: PriceOracle;
  arbitrageOrchestrator: ArbitrageOrchestrator; // to call notifyOpportunityUpdate for updating opportunity status and logs in orchestrator after execution and on pending execution updates
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
  bundle?: string[] | null; // signed bundle (only if using Flashbots)
  submittedAt?: number;
  submittedAtBlock?: number;
}

export class FlashArbitrageHandler {
  private readonly logger: Logger;
  private readonly chainConfig: ChainConfig;
  private readonly eventBus: EventBus;
  private readonly dexManager: DexManager;
  private readonly blockchain: Blockchain;
  private readonly blockManager: BlockManager;
  private readonly contract: ethers.Contract | null = null;
  private readonly walletManager: WalletManager;
  private readonly flashbotsService?: FlashbotsService; // OPTIONAL Flashbots service
  private readonly priceOracle: PriceOracle;
  private readonly arbitrageOrchestrator: ArbitrageOrchestrator;

  private readonly abiCoder = new ethers.AbiCoder();
  private readonly CONTRACT_INTERFACE = new ethers.Interface(FLASH_ARBITRAGE_ABI);

  // config
  private readonly ENABLE_FLASH_ARBITRAGE: boolean;
  private readonly USE_FLASHBOTS: boolean;
  private readonly WETH_ADDR: string;
  private readonly MAX_BRIBE_USD: number; // max bribe for direct payment opportunities

  // SAFE STRATEGY: Queue for pending opportunities
  private opportunityQueue: QueuedOpportunity[] = [];

  // Track pending executions
  private pendingExecutions = new Map<string, PendingExecution>(); // opportunityId -> execution
  private blockEventUnsubscribe?: () => void;

  constructor(input: FlashArbitrageHandlerInput) {
    this.logger = createLogger(`[${input.chainConfig.name}.FlashArbitrageHandler]`);
    this.chainConfig = input.chainConfig;
    this.eventBus = input.eventBus;
    this.blockchain = input.blockchain;
    this.blockManager = input.blockManager;
    this.walletManager = input.walletManager;
    this.dexManager = input.dexManager;
    this.priceOracle = input.priceOracle;
    this.arbitrageOrchestrator = input.arbitrageOrchestrator;

    // config
    this.ENABLE_FLASH_ARBITRAGE = true;
    this.USE_FLASHBOTS = this.chainConfig.flashbotsEnabled;
    this.WETH_ADDR = this.chainConfig.wrappedNativeTokenAddress;
    this.MAX_BRIBE_USD = 20;

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

  async init(): Promise<void> {
    if (this.USE_FLASHBOTS && this.flashbotsService) {
      await this.flashbotsService.connect();
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

  async handleNewArbitrageOpportunitiesBatch(opportunities: ArbitrageOpportunity[]) {
    const currentBlock = this.blockManager.getCurrentBlockNumber();

    // sort by gross profit descending
    opportunities.sort((a, b) => b.grossProfitUSD - a.grossProfitUSD);
    opportunities.forEach((o) => this.logger.info(`PATH "${o.id}" => GrossProfitUSD $${o.grossProfitUSD.toFixed(2)}`));

    // TODO: prefer ETH opportunitties
    // fill trade struct for all opportunities (required for simulation and execution)
    opportunities.forEach((o) => {
      o.foundAtBlock = currentBlock;
      this.fillOpportunityTradeStruct(o);
    });

    // basic sanity validation
    opportunities = opportunities.filter((o) => this.validatePreExecution(o));

    // simulate all opportunities in batch with multicall3
    const { validOpportunities, invalidOpportunities, errorOpportunities, blacklistPoolIds } =
      await this.simulateOpportunities(opportunities);

    const statusMessage = `valid: ${validOpportunities.length}, invalid: ${invalidOpportunities.length}, error: ${errorOpportunities.length}`;
    this.logger.info(`Opportunities simulation status: ${statusMessage}`);

    // handle non-overlapping valid opportunities
    const validNonOverlappingOpportunities = this.selectNonOverlappingOpportunities(validOpportunities);
    validNonOverlappingOpportunities.forEach((o) => this.handleNewArbitrageOpportunityEvent(o));

    // handle blacklisted pools (if any)
    if (blacklistPoolIds.size > 0) this.dexManager.blacklistPools(blacklistPoolIds);

    // handle invalid opportunities (if any)
    if (invalidOpportunities.length > 0) this.handleInvalidArbitrageOpportunities(invalidOpportunities);

    // handle error opportunities (if any)
    if (errorOpportunities.length > 0) {
      this.logger.warn(`Simulation errors for ${errorOpportunities.length} opportunities, discarding...`);
    }
  }

  private handleNewArbitrageOpportunityEvent(opportunity: ArbitrageOpportunity) {
    displayOpportunity(this.logger, opportunity);
    if (this.USE_FLASHBOTS) this.handleParallelExecution(opportunity);
    else this.handleSequentialExecution(opportunity);
  }

  private async handleInvalidArbitrageOpportunities(opportunities: ArbitrageOpportunity[]) {
    const currentBlock = this.blockManager.getCurrentBlockNumber();
    // go through all found opportunities and extract pool ids
    const poolIds = new Set<string>();
    opportunities.forEach((o) => o.steps.forEach((s) => poolIds.add(s.pool.id)));

    // sync all involved pools from found opportunities with fresh data including ticks
    const updatedPools = await this.dexManager.updatePoolsByIds(poolIds, 32); // update pools with ticks data
    this.eventBus.emitPoolsUpsertBatch({ pools: updatedPools, block: this.blockManager.getCurrentBlock(), silent: true }); // SILENT => no trigger of opportunities search

    // evaluate again invalid opportunities
    let reEvaluatedOpportunities = await this.arbitrageOrchestrator.evaluatePathsConcurrently(opportunities, 30);
    if (reEvaluatedOpportunities.length === 0) return this.logger.info('No opportunities left after re-evaluation');
    reEvaluatedOpportunities.forEach((o) => {
      o.foundAtBlock = currentBlock;
      this.fillOpportunityTradeStruct(o);
    });

    // basic sanity validation
    reEvaluatedOpportunities = reEvaluatedOpportunities.filter((o) => this.validatePreExecution(o));

    // simulate all opportunities in batch with multicall3
    const { validOpportunities, invalidOpportunities, errorOpportunities, blacklistPoolIds } =
      await this.simulateOpportunities(reEvaluatedOpportunities);
    const statusMessage = `valid: ${validOpportunities.length}, invalid: ${invalidOpportunities.length}, error: ${errorOpportunities.length}`;
    this.logger.info(`Opportunities simulation status: ${statusMessage}`);

    // handle any valid opportunities
    const validNonOverlappingOpportunities = this.selectNonOverlappingOpportunities(validOpportunities);
    validNonOverlappingOpportunities.forEach((o) => this.handleNewArbitrageOpportunityEvent(o));

    // NOTE: DISCARD THE REST
    invalidOpportunities.forEach((o) =>
      this.logger.error(`❌ Opportunity ${o.id} still invalid after pools update, discarding...`),
    );
    errorOpportunities.forEach((o) => this.logger.error(`❌ Opportunity ${o.id} has errors after pools update, discarding...`));
    if (blacklistPoolIds.size > 0) this.dexManager.blacklistPools(blacklistPoolIds);
  }

  /**
   * Execute opportunity immediately (PARALLEL STRATEGY)
   * May cause nonce conflicts on L2s if multiple opportunities detected in quick succession
   */
  private async handleParallelExecution(opportunity: ArbitrageOpportunity) {
    this.logger.info(`${'='.repeat(120)}`);
    this.logger.info(`📥 Executing (PARALLEL): ${opportunity.id} (GrossProfit: $${opportunity.grossProfitUSD.toFixed(2)})`);

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
    const blockNumber = newBlock.number;

    for (const [opportunityId, execution] of this.pendingExecutions) {
      const opportunity = execution.opportunity;
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
          await this.analyzeConfirmedExecution(opportunity, receipt, newBlock);
          this.pendingExecutions.delete(opportunityId);
          // this.processOpportunityQueue(); // process next opportunity in queue (if any)
          continue;
        }

        // STEP 1b: If using Flashbots, check bundle stats from previous block
        // NOTE: disabled due to not whitelisted yet in flashbots
        // if (this.USE_FLASHBOTS) {
        //   const bundleStats = await this.flashbotsService!.getBundleStats(
        //     execution.response!.bundleResponse!.bundleHash,
        //     newBlock.number - 1,
        //   );
        //   this.logger.info(`Flashbots bundle stats at submission`, { bundleStats });
        // }

        // STEP 2: Check if execution is still valid
        // NOTE: take new baseGasFee into account (TBD)
        try {
          await this.contract!.executeTrade.staticCall(opportunity.trade!);
        } catch (error) {
          this.logger.warn(`⚠️ Execution of ${opportunityId} is no longer valid`);
          if (this.USE_FLASHBOTS) {
            // Flashbots bundles can't be cancelled, just mark as invalidated
            // this.logger.info(`⏳ Flashbots bundle will expire automatically if not included`);
            this.notifyOpportunityUpdate(execution.opportunity, {
              status: 'invalidated',
              logEntry: { blockNumber, msg: 'Execution invalidated while pending in Flashbots (will expire automatically)' },
            });
          } else {
            await this.cancelTransaction(txHash);
            this.notifyOpportunityUpdate(execution.opportunity, {
              status: 'cancelled',
              logEntry: { blockNumber, msg: 'Execution cancelled while pending in mempool' },
            });
          }
          this.pendingExecutions.delete(opportunityId);
          continue; // go to next opportunity
        }

        // if we reach here => execution is still valid
        if (this.USE_FLASHBOTS) {
          this.logger.info(`⏳ Execution of ${opportunityId} is still valid... Resubmit bundle`);
          // Simulate bundle and send if successful
          // await this.flashbotsService!.simulateBundle(execution.bundle!, newBlock.number + 1);
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
            await this.notifyOpportunityUpdate(execution.opportunity, { status: 'dropped', logEntry: { blockNumber, msg } });
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
        await this.notifyOpportunityUpdate(execution.opportunity, {
          status: 'error',
          logEntry: { blockNumber, msg, error },
        });

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

    try {
      // Execute transaction: choose execution method (flashbots or standard)
      if (this.USE_FLASHBOTS) response = await this.executeViaFlashbots(opportunity);
      else response = await this.executeViaStandardTx(opportunity);
      if (!response.tx) throw new Error('Failed to send transaction');
      const nextBlockNumber = this.blockManager.getCurrentBlockNumber() + 1;
      this.logger.info(`🚀 Transaction sent, tx hash: ${response.tx.hash} (expected inclusion block: ${nextBlockNumber})`);

      // subscribe to new blocks to monitor pending execution (if not already subscribed)
      this.subscribeToNewBlocksEvents();

      // store entry in pending executions
      this.pendingExecutions.set(opportunity.id, {
        opportunity,
        response,
        bundle: response.bundle,
        submittedAt: Date.now(),
        submittedAtBlock: nextBlockNumber,
      });

      // push pending log with transaction details
      this.notifyOpportunityUpdate(opportunity, { status: 'pending', logEntry: { nextBlockNumber, response } });
    } catch (error: any) {
      this.logger.error(`❌ Failed execution of opportunity: ${opportunity.id}`, { error });
      this.notifyOpportunityUpdate(opportunity, { status: 'error', logEntry: { error } });

      // delete from pending executions
      this.pendingExecutions.delete(opportunity.id);
      // this.processOpportunityQueue(); // process next opportunity in queue (if any)
      // balance check its not required here because transaction didnt went through
    }
  }

  /**
   * Execute via standard transaction (public mempool)
   */
  private async executeViaStandardTx(opportunity: ArbitrageOpportunity): Promise<ExecuteTransactionResponse> {
    this.logger.info('🌐 Executing via standard transaction (public mempool)...');
    const tx = await this.contract!.executeTrade(opportunity.trade!, opportunity.gasAnalysis.gasTxSettings);
    return { tx, bundle: null, bundleResponse: null };
  }

  /**
   * Execute via Flashbots (private mempool)
   */
  private async executeViaFlashbots(opportunity: ArbitrageOpportunity): Promise<ExecuteTransactionResponse> {
    if (!this.flashbotsService) throw new Error('Flashbots service not initialized');
    this.logger.info('🔐 Executing via Flashbots (private mempool)...');

    // Build transaction
    const signer = this.walletManager.getSigner();
    const nonce = this.walletManager.getWalletState().nonce;
    const tx = await this.contract!.executeTrade.populateTransaction(opportunity.trade!);

    // Step 1: Define gas parameters
    const gasTxSettings = opportunity.gasAnalysis.gasTxSettings;
    const gasCostUSD = opportunity.gasAnalysis.gasCostUSD.toFixed(2);

    let bribeWEI = 0n;
    if (opportunity.trade?.internalBribeBps) {
      const bribePercent = Number(opportunity.trade.internalBribeBps) / 10000;
      this.logger.info(`💰 Opportunity bribe handled internally from profit, paying ${bribePercent.toFixed(2)}% bribe`);
    } else {
      bribeWEI = opportunity.bribe?.bribeWEI ?? 0n;
      this.logger.info(`💰 Paying bribe via direct ETH transfer: ${ethers.formatEther(bribeWEI)} ETH`);
    }

    this.logger.info(`💰 Opportunity ${opportunity.id}, gasCost: $${gasCostUSD} USD, bribe: ${ethers.formatEther(bribeWEI)} ETH`);

    // create bundle array with unsignedArbitrageTx
    const unsignedArbitrageTx: ethers.TransactionRequest = {
      ...tx,
      nonce,
      value: bribeWEI,
      chainId: this.blockchain.chainId,
      gasLimit: gasTxSettings.gasLimit,
      maxFeePerGas: gasTxSettings.maxFeePerGas,
      maxPriorityFeePerGas: gasTxSettings.maxPriorityFeePerGas,
      type: 2, // EIP-1559
    };

    // Create bundle with signed transactions
    const bundle = [await signer.signTransaction(unsignedArbitrageTx)];
    const targetBlock = this.blockManager.getCurrentBlockNumber() + 1;

    // Simulate bundle and send if successful
    const simulation = await this.flashbotsService.simulateBundle(bundle, targetBlock);
    this.notifyOpportunityUpdate(opportunity, { status: 'simulated', logEntry: { simulation } });
    if (!simulation.success) throw new Error(`Bundle simulation failed for "${opportunity.id}": ${simulation.error}`);
    this.logger.info(`✅ Bundle simulation successful for "${opportunity.id}", submitting bundle to Flashbots...`);
    const bundleResponse = await this.flashbotsService.submitBundle(bundle, { targetBlock }); // non-blocking
    this.logger.info(`✅ Bundle submitted to Flashbots for "${opportunity.id}"`);

    // !!! Parse transaction to get hash
    const parsedArbitrageTx = ethers.Transaction.from(bundle[0]);
    const txHash = parsedArbitrageTx.hash!;
    this.notifyOpportunityUpdate(opportunity, { status: 'submitted', logEntry: { txHash, bundleResponse } });

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
   * Calculate bribe in wei if using Flashbots, otherwise return 0
   * NOTE: bribe can exceed wallet balance only if borrowToken is WETH!!!
   * otherwise cap bribe to wallet balance (or set to 0 if balance is too low) to avoid failed transactions due to insufficient funds
   */
  private calculateSpendingsAndProfit(opportunity: ArbitrageOpportunity) {
    // const tokenOut = opportunity.borrowToken; // tokenOut is the same as borrowToken because its a cyclic swap (first token in = last token out)
    // const nativeTokenPriceUSD = this.priceOracle.getPriceUSD(this.WETH_ADDR)!;
    // const usdPriceInNativeToken = 1 / nativeTokenPriceUSD;

    // const grossProfitUSD = opportunity.grossProfitUSD;
    const { gasCostWEI } = opportunity.gasAnalysis;

    // NOTE: for now internal bribe only with WETH
    // figure how how much bribe we can pay based on gross profit - gas cost
    // REASONING:
    // GrossProfit -> 10_000BPS
    // GrossProfit - GasCost -> ? BPS => calculate bribeBPS based on leftover profit
    const grossProfitTokenOut = opportunity.grossProfitToken; // for NOW only ETH
    const profitAfterGasCost = grossProfitTokenOut - gasCostWEI;
    let profitBpsAfterGasCost = (profitAfterGasCost * 10000n) / grossProfitTokenOut;
    let gasCostBps = (gasCostWEI * 10000n) / grossProfitTokenOut;
    if (profitBpsAfterGasCost > 10000n) {
      this.logger.warn(`Calculated profitBpsAfterGasCost > 10000 for opportunity ${opportunity.id}, capping to 9000`, {
        profitBpsAfterGasCost,
      });
      profitBpsAfterGasCost = 9000n;
    }
    const minProfitTokenOut = (grossProfitTokenOut * 8n) / 10n; // expect set min profit to 80% of caluclated gross profit
    return { minProfitTokenOut, grossProfitTokenOut, profitAfterGasCost, gasCostWEI, profitBpsAfterGasCost, gasCostBps };

    // // calculate bribe from leftover profit after gas costs
    // const gasCostUSD = this.priceOracle.calculateUSDValue(this.WETH_ADDR, gasCostWEI);
    // const leftoverProfitUSD = grossProfitUSD - gasCostUSD;
    // if (leftoverProfitUSD <= 0) {
    //   this.logger.warn(`Leftover profit for ${opportunity.id} is negative after gas costs`, { grossProfitUSD, gasCostUSD });
    //   throw new Error(`Leftover profit negative for: ${opportunity.id}`);
    // }

    // let bribeCostUSD = (leftoverProfitUSD * Number(bribeBps)) / 10000;
    // if (tokenOut.symbol !== 'WETH' && bribeCostUSD > this.MAX_BRIBE_USD) {
    //   const msg = `calculated bribe $${bribeCostUSD.toFixed(2)} > $${this.MAX_BRIBE_USD}, capping to max`;
    //   this.logger.warn(`Opportunity ${opportunity.id} has tokenOut: ${tokenOut.symbol}, ${msg}`);
    //   bribeCostUSD = this.MAX_BRIBE_USD;
    // }
    // const bribeCostETH = bribeCostUSD * usdPriceInNativeToken;
    // const bribeCostWEI = BigInt(Math.floor(bribeCostETH * 1e18));

    // const totalCostsWEI = gasCostWEI + bribeCostWEI;
    // const totalCostsUSD = this.priceOracle.calculateUSDValue(this.WETH_ADDR, totalCostsWEI);

    // const tokenOutPriceUSD = this.priceOracle.getPriceUSD(tokenOut.address);
    // if (!tokenOutPriceUSD) throw new Error(`Price not available for tokenOut ${tokenOut.symbol} (${tokenOut.address})`);
    // const totalCostInTokenOut = totalCostsUSD / tokenOutPriceUSD; // (human readable amount = > we need to convert to raw amount)
    // const totalCostInTokenOutRaw = BigInt(Math.floor(totalCostInTokenOut * 10 ** tokenOut.decimals));

    // const result = {
    //   gasCostUSD,
    //   bribeCostUSD,
    //   gasCostWEI,
    //   bribeCostWEI,
    //   bribeCostETH,

    //   totalCostWEI: totalCostsWEI,
    //   totalCostUSD: totalCostsUSD,
    //   totalCostInTokenOut: totalCostInTokenOutRaw,
    //   netProfitUSD: grossProfitUSD - totalCostsUSD,
    // };

    // return result;
  }

  /**
   * Convert ArbitrageOpportunity to Trade struct
   */
  private fillOpportunityTradeStruct(opportunity: ArbitrageOpportunity): void {
    // go trough each swap step and build Trade struct
    const swaps: SwapStepOnContract[] = [];
    for (const step of opportunity.steps) {
      const poolTokenPair = step.pool.tokenPair;

      swaps.push({
        dexProtocol: FlashArbitrageHandler.getDexTypeEnumValueFromPool(step.pool.protocol),
        poolAddress: step.pool.address,
        poolTokens: [step.pool.tokenPair.token0.address, step.pool.tokenPair.token1.address],
        tokenIn: denormalizeTokenAddr(poolTokenPair, step.tokenIn.address, this.WETH_ADDR),
        tokenOut: denormalizeTokenAddr(poolTokenPair, step.tokenOut.address, this.WETH_ADDR),
        amountSpecified: 0n, // calculated by contract based on borrow amount and swap path
        amountOutMin: 0n, // don't care about min output on entry swap
        poolFee: step.pool.feeBps,

        // extra params for other DEX protocols (not used for now => set to 0 or empty)
        extraData:
          step.pool.protocol === 'v4'
            ? this.abiCoder.encode(['address', 'int24'], [step.pool.hooks, step.pool.tickSpacing])
            : '0x',
      });
    }

    const result = this.calculateSpendingsAndProfit(opportunity); // if direct payment allocate only 80% of leftover profit for bribe
    // NOTE: if borrowToken its in ETH we can afford to pay higher bribe set 100% bribe

    opportunity.bribe = { internalBribeBps: 0n, bribeWEI: 0n, result };
    if (opportunity.borrowToken.symbol === 'WETH') {
      opportunity.bribe.internalBribeBps = result.profitBpsAfterGasCost;
    }
    // else opportunity.bribe.bribeWEI = result.bribeCostWEI; // CASE 2: Direct ETH transfer

    // fill opportunity trade execution struct
    opportunity.trade = {
      swaps,
      borrowToken: opportunity.borrowToken.address,
      borrowAmount: opportunity.borrowAmount,
      internalBribeBps: opportunity.bribe.internalBribeBps,
      minProfitTokenOut: result.minProfitTokenOut,
    };
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
    if (!this.ENABLE_FLASH_ARBITRAGE) return;
    this.logger.info(`🔍 Validating FlashArbitrageContract`);
    const owner = await this.contract!.owner();
    const signerAddress = await this.walletManager.getSigner().getAddress();

    this.logger.info(`📋 Contract address: ${this.chainConfig.arbitrageContractAddress}`);
    this.logger.info(`📋 Contract owner: ${owner}`);

    if (owner.toLowerCase() !== signerAddress.toLowerCase()) throw new Error('Signer is not the contract owner');
  }

  /**
   * Simulate opportunities
   */
  private async simulateOpportunities(opportunities: ArbitrageOpportunity[]) {
    this.logger.info(`🔍 Simulating ${opportunities.length} opportunities via static multicall3...`);
    const validOpportunities: ArbitrageOpportunity[] = [];
    const invalidOpportunities: ArbitrageOpportunity[] = [];
    const errorOpportunities: ArbitrageOpportunity[] = [];
    const blacklistPoolIds = new Set<string>();

    try {
      // 1. build multicall3 input from valid opportunities
      const calls: Multical3Input[] = [];
      for (const opportunity of opportunities) {
        const callData = this.CONTRACT_INTERFACE.encodeFunctionData('simulateTrade', [opportunity.trade!]);
        calls.push({
          target: this.chainConfig.arbitrageContractAddress,
          allowFailure: true,
          callData,
        });
      }

      // 2. execute multicall3
      const callResults = await this.blockchain.executeMulticall3(calls, 50);

      // 3. Collect decoded results per opportunity
      // NOTE: simulateTrade always reverts with SimulationSuccess/SimulationError custom error
      for (let index = 0; index < callResults.length; index++) {
        const callResult = callResults[index];
        const opportunity = opportunities[index];
        const borrowToken = opportunity.borrowToken;
        let parsed;
        try {
          parsed = this.CONTRACT_INTERFACE.parseError(callResult.returnData);
        } catch {
          errorOpportunities.push(opportunity);
          this.logger.error(`❌ Unparseable revert for: ${opportunity.id}`, { returnData: callResult.returnData });
          continue;
        }

        if (parsed?.name === 'SimulationSuccess') {
          const expectedProfit = ethers.formatUnits(opportunity.grossProfitToken, borrowToken.decimals);
          const profitOut = ethers.formatUnits(parsed.args[0] as bigint, borrowToken.decimals); // NOTE: this its profit after loan repayment
          this.logger.info(`✅ Simulation succesful for ${opportunity.id}, expected: ${expectedProfit}, profitOut: ${profitOut}`);
          validOpportunities.push(opportunity); // THE ONLY VALID CASE
        } else if (parsed?.name === 'SimulationError') {
          try {
            const innerErrBytes = parsed.args[0] as string;
            const innerError = this.CONTRACT_INTERFACE.parseError(innerErrBytes);

            if (innerError?.name === 'SwapStepFailed') {
              const stepIndex = Number(innerError.args[0] as bigint);
              const stepReasonBytes = innerError.args[1] as string;

              // Optionally decode the inner-inner reason (pool's actual error)
              // if (stepReasonBytes && stepReasonBytes !== '0x') {
              //   try {
              //     const poolParsed = this.CONTRACT_INTERFACE.parseError(stepReasonBytes);
              //     poolError = poolParsed?.name ?? `selector: ${stepReasonBytes.slice(0, 10)}`;
              //   } catch {
              //     poolError = `raw: ${stepReasonBytes.slice(0, 100)}`;
              //   }
              // }

              const failedStep = opportunity.steps[stepIndex];
              errorOpportunities.push(opportunity);

              if (stepReasonBytes === '0x') {
                this.logger.warn(`Simulation for ${opportunity.id} failed at step ${stepIndex}`, {
                  pool: failedStep.pool,
                  stepReasonBytes,
                });
                // NOTE: add to blacklist only in this case => otherwise it might be a custom error like invalid amount, or slippage to high, etc...
                // error code examples: 0xbe8b8507 0x90bfb865
                blacklistPoolIds.add(failedStep.pool.id);
              } else {
                this.logger.warn(`Simulation for ${opportunity.id} failed at step ${stepIndex} with reason: ${stepReasonBytes}`, {
                  poolId: failedStep.pool.id,
                  stepReasonBytes,
                });
                invalidOpportunities.push(opportunity); // mark as invalid to sync pools data and re-evaluate
              }
            } else if (innerError?.name === 'LoanRepaymentNotMet' || innerError?.name === 'MinProfitNotMet') {
              const formattedExpected = ethers.formatUnits(innerError.args[1] as bigint, borrowToken.decimals);
              const formattedActual = ethers.formatUnits(innerError.args[2] as bigint, borrowToken.decimals);
              const errorMsg = `${innerError?.name}: expected: ${formattedExpected}, actual: ${formattedActual}`;
              this.logger.warn(`Simulation for ${opportunity.id} failed with ${errorMsg}`);
              invalidOpportunities.push(opportunity); // can't repay loan or min profit not met
            } else {
              // NOTE: other types of errors aren't expected in simulation
              errorOpportunities.push(opportunity);
              this.logger.error(`❌ Simulation for ${opportunity.id} failed with error`, { innerError });
            }
          } catch {
            errorOpportunities.push(opportunity);
            const message = 'Unable to decode inner error, empty revert (require(false) or OOG) from pool/contract';
            this.logger.error(`❌ Simulation failed for: ${opportunity.id}, ${message}`, { opportunity });
          }
        } else {
          errorOpportunities.push(opportunity);
          this.logger.error(`❌ Simulation for ${opportunity.id} failed, unexpected: ${parsed?.name}`, {
            parsedName: parsed?.name,
            parsedArgs: parsed?.args,
            returnData: callResult.returnData,
          });
        }
      }
    } catch (error) {
      this.logger.error(`❌ Unexpected error during simulation`, { error });
    }

    return { validOpportunities, invalidOpportunities, errorOpportunities, blacklistPoolIds };
  }

  /**
   * Validate pre-execution conditions
   */
  private validatePreExecution(opportunity: ArbitrageOpportunity) {
    const trade = opportunity.trade!;
    // Basic sanity checks on trade structure
    if (trade.swaps.length < 2) {
      this.logger.error('Need at least 2 swaps for arbitrage', { opportunity });
      return false;
    }
    if (!this.areTokenAddressesEqual(trade.swaps[0].tokenIn, trade.swaps[trade.swaps.length - 1].tokenOut)) {
      this.logger.error(`EntryTokenIn != ExitTokenOut`, { opportunity });
      return false;
    }
    for (let i = 0; i < trade.swaps.length - 1; i++) {
      if (!this.areTokenAddressesEqual(trade.swaps[i].tokenOut, trade.swaps[i + 1].tokenIn)) {
        this.logger.error(`Swap chain broken between swaps ${i} and ${i + 1}`, { opportunity });
        return false;
      }
    }

    return true;
  }

  // NOTE: take into consideration (ETH = WETH) when comparing token addresses for swap path validation
  private areTokenAddressesEqual(addrA: string, addrB: string): boolean {
    if (addrA === ethers.ZeroAddress && addrB === this.WETH_ADDR) return true;
    if (addrB === ethers.ZeroAddress && addrA === this.WETH_ADDR) return true;
    return addrA.toLowerCase() === addrB.toLowerCase();
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
    const involvedTokens = [opportunity.steps[0].tokenIn.address, opportunity.steps[0].tokenOut.address];
    const actualWalletChanges = await this.walletManager.updateBalancesAfterTransaction(involvedTokens);

    const analysis = {
      // profit
      profit: {
        expectedProfitUSD: opportunity.netProfitUSD,
        actualWalletChanges,
      },

      // gas usage
      gas: {
        expectedGasUsed: opportunity.gasAnalysis.gasEstimate,
        actualGasUsed: receipt.gasUsed,
        actualGasPrice: receipt.gasPrice,
      },
    };

    // update execution status in db
    this.logger.info(`Transaction: https://etherscan.io/tx/${receipt.hash}`);
    const status = receipt.status === 1 ? 'success' : 'revert';
    await this.notifyOpportunityUpdate(opportunity, { status, logEntry: { blockNumber: block.number, receipt, analysis } });
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

  // ================================================================================================
  // HELPERS
  // ================================================================================================
  notifyOpportunityUpdate(opportunity: ArbitrageOpportunity, data: { status: string; logEntry?: any }) {
    opportunity.status = data.status as ArbitrageOpportunity['status'];
    if (data.logEntry) opportunity.logs.push(data.logEntry);
    this.eventBus.emitArbitrageOpportunityEvent(opportunity);
  }

  selectNonOverlappingOpportunities(opportunities: ArbitrageOpportunity[]): ArbitrageOpportunity[] {
    const usedPools = new Set<string>();
    const selected: ArbitrageOpportunity[] = [];

    for (const path of opportunities) {
      const poolKeys = path.steps.map((s) => s.pool.id);

      const hasOverlap = poolKeys.some((k) => usedPools.has(k));
      if (!hasOverlap) {
        selected.push(path);
        poolKeys.forEach((k) => usedPools.add(k));
      }
    }

    return selected;
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
