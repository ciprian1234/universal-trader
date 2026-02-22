import { ethers } from 'ethers';
import type { PoolState, PoolEvent } from './interfaces';
import { EventBus } from './event-bus';
import { PoolStatesManager } from './pool-states-manager';
import { Blockchain } from './blockchain';
import type { Logger } from '@/utils';

type BlockManagerInput = {
  blockchain: Blockchain;
  eventBus: EventBus;
  poolStatesManager: PoolStatesManager;
  logger: Logger;
};

export interface BlockEntry {
  number: number;
  receivedTimestamp: number; // set when block event is received
}

export class BlockManager {
  private readonly logger: Logger;
  private readonly blockchain: Blockchain;
  private readonly eventBus: EventBus;
  private readonly poolStatesManager: PoolStatesManager;
  private poolAddressesSet: Set<string> = new Set();

  // Configuration
  private readonly BLOCK_EVENT_TIMEOUT = 50; // Wait 50ms for all events from a block (with debounce)

  // new block data
  private currentBlock: BlockEntry = { number: 0, receivedTimestamp: 0 };

  // events
  private eventFilter: ethers.Filter | null = null;
  private eventBuffer: PoolEvent[] = [];
  private eventsProcessingTimer: NodeJS.Timeout | null = null;

  // Event signatures - Support V2, V3, and V4
  private readonly EVENT_TOPICS = {
    // Uniswap V2 / Sushiswap
    V2_SYNC: ethers.id('Sync(uint112,uint112)'),

    // Uniswap V3
    V3_SWAP: ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)'),
    V3_MINT: ethers.id('Mint(address,address,int24,int24,uint128,uint256,uint256)'), // TODO: verify signature
    V3_BURN: ethers.id('Burn(address,int24,int24,uint128,uint256,uint256)'), // TODO: verify signature

    // Uniswap V4 (Singleton pattern - different event structure)
    V4_SWAP: ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'),
    V4_MODIFY_LIQUIDITY: ethers.id('ModifyLiquidity(bytes32,address,int24,int24,int256,int256)'),
  };

  // ABIs for parsing
  private readonly EVENT_ABIS = {
    V2_SYNC: ['event Sync(uint112 reserve0, uint112 reserve1)'],

    V3_SWAP: [
      'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
    ],
    V3_MINT: [
      'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
    ],
    V3_BURN: [
      'event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
    ],

    V4_SWAP: [
      'event Swap(bytes32 indexed poolId, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
    ],
    V4_MODIFY_LIQUIDITY: [
      'event ModifyLiquidity(bytes32 indexed poolId, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, int256 amount0, int256 amount1)',
    ],
  };

  private readonly EVENT_INTERFACES = {
    V2_SYNC: new ethers.Interface(this.EVENT_ABIS.V2_SYNC),
    V3_SWAP: new ethers.Interface(this.EVENT_ABIS.V3_SWAP),
    V3_MINT: new ethers.Interface(this.EVENT_ABIS.V3_MINT),
    V3_BURN: new ethers.Interface(this.EVENT_ABIS.V3_BURN),
    V4_SWAP: new ethers.Interface(this.EVENT_ABIS.V4_SWAP),
    V4_MODIFY_LIQUIDITY: new ethers.Interface(this.EVENT_ABIS.V4_MODIFY_LIQUIDITY),
  };

  constructor(input: BlockManagerInput) {
    this.blockchain = input.blockchain;
    this.eventBus = input.eventBus;
    this.poolStatesManager = input.poolStatesManager;
    this.logger = input.logger;
  }

  /**
   * 🎬 INITIALIZE: Fetch initial block data
   */
  async init(): Promise<void> {
    const blockNumber = await this.blockchain.getBlockNumber();
    if (!blockNumber) throw new Error(`Failed to fetch initial blockNumber: <${blockNumber}>`);

    // set initial block number in queue
    this.currentBlock = { number: blockNumber, receivedTimestamp: Date.now() };

    // Emit initial block event
    this.logger.info(`Initializing by fetching latest blockNumber: ${blockNumber}`);
    this.eventBus.emitNewBlock(this.currentBlock);
  }

  /**
   * 🎧 Listen for new block events
   */
  listenBlockEvents(): void {
    this.logger.info('🎧 Subscribed to block events');
    this.blockchain.on('block', async (newBlockNumber: number) => {
      try {
        const prevBlockNumber = this.currentBlock.number;
        this.currentBlock = { number: newBlockNumber, receivedTimestamp: Date.now() };
        this.logger.info(`🔗 New block event: ${newBlockNumber}`);

        if (newBlockNumber <= prevBlockNumber) {
          this.logger.warn(
            `⚠️ Received out-of-order blockNumber ${newBlockNumber} while current is ${prevBlockNumber}, (possible reorg)`,
          );
          return this.handleReorg(newBlockNumber);
        }

        // if we reach here it means that this new block its mined in sequence
        this.eventBus.emitNewBlock({ number: newBlockNumber, receivedTimestamp: Date.now() });
      } catch (error) {
        this.logger.error(`❌ Error processing new block ${newBlockNumber}:`, error);
        // Curenltly only gas manager listens to block events => not a big isssue if block processing fails
        // => Gas manager will just miss one block update on next block it will get latest data again
      }
    });
  }

  /**
   * 🎧 Listen for pool events
   */
  listenPoolEvents(): void {
    const poolAddresses = this.poolStatesManager.getPoolAddresses();
    if (poolAddresses.length === 0) {
      this.logger.error('❌ No pools to monitor');
      return;
    }
    this.poolAddressesSet = new Set(poolAddresses.map((a) => a.toLowerCase()));

    // Create single filter for ALL pool addresses and ALL event types
    this.eventFilter = {
      address: poolAddresses, // POST_MVP consider dynamic subscription management
      topics: [
        [
          this.EVENT_TOPICS.V2_SYNC,
          this.EVENT_TOPICS.V3_SWAP,
          // this.EVENT_TOPICS.V3_MINT, // for now ignore mint/burn events
          // this.EVENT_TOPICS.V3_BURN, // for now ignore mint/burn events
          // this.EVENT_TOPICS.V4_SWAP,
          // this.EVENT_TOPICS.V4_MODIFY_LIQUIDITY,
        ],
      ],
    };

    // Subscribe to logs
    this.blockchain.on(this.eventFilter, (log: ethers.Log) => this.handlePoolEvent(log));
    this.logger.info(`🎧 Subscribed to ${this.poolAddressesSet.size} pools events`);
  }

  /**
   * 🔄 HANDLE REORG: Recover from chain reorganization
   */
  private async handleReorg(blockNumber: number) {
    this.logger.info(`🔄 Handling reorg at block ${blockNumber}...`);

    // Notify subscribers (suspend arbitrage checking while we recover)
    this.eventBus.emitApplicationEvent({ name: 'reorg-detected', data: { blockNumber } });

    // reinitialize block manager (safe an straightforward way to recover)
    this.cleanup();
    await this.init(); // re-fetch latest blockNumber
    // this.listenPoolEvents(); // re-subscribe to pool events

    // Refresh all pool states
    this.logger.info('🔄 Refreshing pool states after reorg...');
    await this.poolStatesManager.updateAll();
    this.poolStatesManager.calculateAllPoolsLiquidityUSD();

    // resume arbitrage checking after recovery
    this.logger.info('✅ Reorg recovery completed. Current block number:', this.currentBlock.number);
    this.eventBus.emitApplicationEvent({ name: 'pool-states-updated' });
  }

  /**
   * 📥 HANDLE POOL EVENT: Buffer events by block
   */
  private handlePoolEvent(log: ethers.Log): void {
    try {
      if (!this.poolAddressesSet.has(log.address.toLowerCase())) {
        this.logger.warn(`Received event for unmonitored pool: ${log.address}`, { log }); // POST_MVP allow dynamic pool subscription management
        return;
      }
      const event = this.parseLog(log);

      // Push event to event buffer
      this.eventBuffer.push(event);

      // Update pool state immediately - handlePoolEvent applies only if event is newer (by blockNumber, txIndex, logIndex)
      this.poolStatesManager.handlePoolEvent(event);

      // start processing timer to send all events in batch after timeout (with debounce)
      if (this.eventsProcessingTimer) clearTimeout(this.eventsProcessingTimer); // Reset timer (debounce)
      this.eventsProcessingTimer = setTimeout(() => this.processPoolEventsBatch(), this.BLOCK_EVENT_TIMEOUT);
    } catch (error) {
      this.logger.error('Error handling pool event:', { error });
    }
  }

  /**
   * 📦 PROCESS POOL EVENTS BATCH: Process all buffered events for the latest block
   */
  private processPoolEventsBatch(): void {
    if (!this.eventBuffer.length) {
      this.eventsProcessingTimer = null;
      return; // nothing to process
    }

    // make a copy of the buffer
    const events = [...this.eventBuffer];
    this.eventBuffer = []; // clear buffer

    this.eventBus.emitPoolEventsBatch({ events });

    this.eventsProcessingTimer = null;
  }

  /**
   * 🔍 PARSE LOG: Convert raw log to PoolEvent
   */
  private parseLog(log: ethers.Log): PoolEvent {
    const poolAddress = log.address.toLowerCase();
    const poolState = this.poolStatesManager.getPoolState(poolAddress);
    if (!poolState) throw new Error(`Recieved PoolEvent for unregistered pool: ${poolAddress}`);

    const topic = log.topics[0];
    if (topic === this.EVENT_TOPICS.V2_SYNC) return this.parseV2Sync(log, poolState);
    else if (topic === this.EVENT_TOPICS.V3_SWAP) return this.parseV3Swap(log, poolState);
    else if (topic === this.EVENT_TOPICS.V3_MINT) return this.parseV3Mint(log, poolState);
    else if (topic === this.EVENT_TOPICS.V3_BURN) return this.parseV3Burn(log, poolState);
    else if (topic === this.EVENT_TOPICS.V4_SWAP) return this.parseV4Swap(log, poolState);
    else if (topic === this.EVENT_TOPICS.V4_MODIFY_LIQUIDITY) return this.parseV4ModifyLiquidity(log, poolState);
    else throw new Error(`Unknown event topic: ${topic} for pool ${poolAddress}`);
  }

  // ================================================================================================
  // EVENT PARSERS
  // ================================================================================================

  private parseV2Sync(log: ethers.Log, poolState: PoolState): PoolEvent {
    const iface = this.EVENT_INTERFACES.V2_SYNC;
    const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
    if (!parsed) throw new Error('Failed to parse V2 Sync');

    return {
      type: 'v2-sync',
      dexName: poolState.dexName,
      dexType: poolState.dexType,
      poolId: poolState.id,
      tokenPair: poolState.tokenPair,
      reserve0: parsed.args.reserve0,
      reserve1: parsed.args.reserve1,
      meta: {
        blockNumber: log.blockNumber,
        blockReceiveTimestamp: this.currentBlock.receivedTimestamp,
        transactionHash: log.transactionHash,
        transactionIndex: log.transactionIndex,
        logIndex: log.index,
        timestamp: Date.now(),
      },
    };
  }

  private parseV3Swap(log: ethers.Log, poolState: PoolState): PoolEvent {
    const iface = this.EVENT_INTERFACES.V3_SWAP;
    const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
    if (!parsed) throw new Error('Failed to parse V3 Swap');

    const { sqrtPriceX96, liquidity, tick } = parsed.args;

    return {
      type: 'v3-swap',
      dexName: poolState.dexName,
      dexType: poolState.dexType,
      poolId: poolState.id,
      tokenPair: poolState.tokenPair,
      sqrtPriceX96,
      liquidity,
      tick,
      meta: {
        blockNumber: log.blockNumber,
        blockReceiveTimestamp: this.currentBlock.receivedTimestamp,
        transactionHash: log.transactionHash,
        transactionIndex: log.transactionIndex,
        logIndex: log.index,
        timestamp: Date.now(),
      },
    };
  }

  private parseV3Mint(log: ethers.Log, poolState: PoolState): PoolEvent {
    const iface = this.EVENT_INTERFACES.V3_MINT;
    const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
    if (!parsed) throw new Error('Failed to parse V3 Mint');
    this.logger.info('V3 Mint event parsing:', parsed.args);
    // const updatedPool = await this.getPoolState(pool.poolId);

    // For Mint/Burn, we need to fetch current pool state to get updated sqrtPriceX96
    return {
      type: 'v3-mint',
      dexName: poolState.dexName,
      dexType: poolState.dexType,
      poolId: poolState.id,
      tokenPair: poolState.tokenPair,
      meta: {
        blockNumber: log.blockNumber,
        blockReceiveTimestamp: this.currentBlock.receivedTimestamp,
        transactionHash: log.transactionHash,
        transactionIndex: log.transactionIndex,
        logIndex: log.index,
        timestamp: Date.now(),
      },
    };
  }

  private parseV3Burn(log: ethers.Log, poolState: PoolState): PoolEvent {
    const iface = this.EVENT_INTERFACES.V3_BURN;
    const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
    if (!parsed) throw new Error('Failed to parse V3 Burn');
    this.logger.info('V3 Burn event parsing:', parsed.args);
    // For Mint/Burn, we need to fetch current pool state to get updated sqrtPriceX96
    // const updatedPool = await this.getPoolState(poolState.poolId);

    return {
      type: 'v3-burn',
      dexName: poolState.dexName,
      dexType: poolState.dexType,
      poolId: poolState.id,
      tokenPair: poolState.tokenPair,
      meta: {
        blockNumber: log.blockNumber,
        blockReceiveTimestamp: this.currentBlock.receivedTimestamp,
        transactionHash: log.transactionHash,
        transactionIndex: log.transactionIndex,
        logIndex: log.index,
        timestamp: Date.now(),
      },
    };
  }

  private parseV4Swap(log: ethers.Log, poolState: PoolState): PoolEvent {
    const iface = this.EVENT_INTERFACES.V4_SWAP;
    const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
    if (!parsed) throw new Error('Failed to parse V4 Swap');

    const { poolId, amount0, amount1, sqrtPriceX96, liquidity, tick, fee } = parsed.args;

    return {
      type: 'v4-swap',
      dexName: poolState.dexName,
      dexType: 'uniswap-v4',
      poolId: poolState.id,
      tokenPair: poolState.tokenPair,
      sqrtPriceX96,
      liquidity,
      tick,
      // fee, // V4 has dynamic fees (TODO!!!!)
      meta: {
        blockNumber: log.blockNumber,
        blockReceiveTimestamp: this.currentBlock.receivedTimestamp,
        transactionHash: log.transactionHash,
        transactionIndex: log.transactionIndex,
        logIndex: log.index,
        timestamp: Date.now(),
      },
    };
  }

  private parseV4ModifyLiquidity(log: ethers.Log, poolState: PoolState): PoolEvent {
    const iface = this.EVENT_INTERFACES.V4_MODIFY_LIQUIDITY;
    const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
    if (!parsed) throw new Error('Failed to parse V4 ModifyLiquidity');

    return {
      type: 'v4-modify-liquidity',
      dexName: poolState.dexName,
      dexType: 'uniswap-v4',
      poolId: poolState.id,
      tokenPair: poolState.tokenPair,
      meta: {
        blockNumber: log.blockNumber,
        blockReceiveTimestamp: this.currentBlock.receivedTimestamp,
        transactionHash: log.transactionHash,
        transactionIndex: log.transactionIndex,
        logIndex: log.index,
        timestamp: Date.now(),
      },
    };
  }

  getCurrentBlockNumber(): number {
    return this.currentBlock.number;
  }

  /**
   * 🛑 CLEANUP
   */
  cleanup(): void {
    // Clear all timers
    if (this.eventsProcessingTimer) {
      clearTimeout(this.eventsProcessingTimer);
      this.eventsProcessingTimer = null;
    }

    // NOTE: do not remove listners due to reorg issue (health monitoring becomes broken)
    // Remove listeners (note: block listeners are removed in Blockchain.cleanup())
    // this.blockchain.removeAllListeners('block');
    // if (this.eventFilter) this.blockchain.removeAllListeners(this.eventFilter);

    // Reset state data
    this.currentBlock = { number: 0, receivedTimestamp: 0 };
    this.eventBuffer = [];
    this.logger.info('🛑 Cleanup executed');
  }
}
