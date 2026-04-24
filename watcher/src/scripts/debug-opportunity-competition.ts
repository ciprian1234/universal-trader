// watcher/src/scripts/debug-opportunity-competition.ts
import { appConfig } from '@/config';
import type { ChainConfig } from '@/config/models';
import { logger } from '@/utils';
import { ethers } from 'ethers';
import { WorkerDb } from '@/db';
import type { ArbitrageOpportunity, SwapStep } from '@/core/interfaces';
import type { DexPoolState, DexV4PoolState } from '@/shared/data-model/layer1';

// ========================================================================================
// CONFIG — edit these
// ========================================================================================
const DB_OPPORTUNITY_ID = '1776790440947@uniswap-v3(10000)[WETH->WOJAK]___uniswap-v2(30)[WOJAK->WETH]';

if (!process.env.SCRIPTS_DATABASE_URL) throw new Error('SCRIPTS_DATABASE_URL not set');
if (!process.env.SCRIPTS_PROVIDER_RPC_URL) throw new Error('SCRIPTS_PROVIDER_RPC_URL not set');
const chainConfig = appConfig.platforms['ethereum'] as ChainConfig;
const db = new WorkerDb(process.env.SCRIPTS_DATABASE_URL, chainConfig.chainId);
const provider = new ethers.JsonRpcProvider(process.env.SCRIPTS_PROVIDER_RPC_URL, chainConfig.chainId, { staticNetwork: true });

// ========================================================================================
// SWAP EVENT TOPICS (keccak256 of the event signatures)
// ========================================================================================
// V2: Swap(address sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address to)
const V2_SWAP_TOPIC = ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)');
// V3: Swap(address sender, address recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
const V3_SWAP_TOPIC = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
// V4: Swap(bytes32 poolId, address sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)
const V4_SWAP_TOPIC = ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');

// ========================================================================================
// TYPES
// ========================================================================================
interface PoolTarget {
  stepIndex: number;
  protocol: 'v2' | 'v3' | 'v4';
  poolAddress: string; // V2/V3: pool contract; V4: PoolManager singleton
  poolKeyHash?: string; // V4 only: bytes32 pool id (the indexed `id` in Swap event)
  label: string; // human-readable for logs
  swapTopic: string;
  swapInterface: ethers.Interface;
}

interface SwapEventDecoded {
  protocol: 'v2' | 'v3' | 'v4';
  poolAddress: string;
  poolKeyHash?: string;
  label: string;
  amount0: bigint;
  amount1: bigint;
  sqrtPriceX96?: bigint;
  tick?: number;
  raw: ethers.Log;
}

interface CompetingTx {
  txHash: string;
  blockNumber: number;
  txIndex: number;
  from: string;
  to: string | null;
  gasLimit: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint; // baseFee + priorityFee
  maxPriorityFeePerGas: bigint | null; // EIP-1559 tip = proxy for builder bribe
  gasCostWEI: bigint; // gasUsed * effectiveGasPrice
  gasCostETH: string;
  priorityFeeWEI: bigint; // gasUsed * maxPriorityFeePerGas (the "bribe" portion)
  priorityFeeETH: string;
  isPossiblyFlashbots: boolean; // heuristic: type 2 tx with 0 priority fee
  swaps: SwapEventDecoded[];
}

// ========================================================================================
// MAIN
// ========================================================================================
async function main() {
  const opportunity = await db.getArbitrageOpportunityById(DB_OPPORTUNITY_ID);
  if (!opportunity.foundAtBlock) throw new Error('Opportunity has no foundAtBlock');

  const blockN = opportunity.foundAtBlock;
  const blockN1 = blockN + 1;

  logger.info(`🔍 Opportunity: ${opportunity.id}`);
  logger.info(
    `   Profit: $${opportunity.grossProfitUSD.toFixed(2)}, borrow: ${ethers.formatUnits(opportunity.borrowAmount, opportunity.borrowToken.decimals)} ${opportunity.borrowToken.symbol}`,
  );
  logger.info(`🔗 Found at block N=${blockN}, scanning competition in N+1=${blockN1}`);

  const poolTargets = buildPoolTargets(opportunity);
  logger.info(`🏊 Pool targets (${poolTargets.length}):`);
  for (const t of poolTargets) {
    logger.info(`   [step ${t.stepIndex}] ${t.label}  (${t.poolAddress}${t.poolKeyHash ? ` poolKeyHash=${t.poolKeyHash}` : ''})`);
  }

  const [block, baseFee] = await Promise.all([
    provider.getBlock(blockN1),
    provider.getBlock(blockN).then((b) => b?.baseFeePerGas ?? 0n),
  ]);
  if (!block) throw new Error(`Block ${blockN1} not found`);
  logger.info(
    `📦 Block N+1 (${blockN1}): ${block.transactions.length} txs, baseFee=${ethers.formatUnits(block.baseFeePerGas ?? 0n, 'gwei')} gwei`,
  );

  const competingTxs = await findCompetingTransactions(blockN1, poolTargets, opportunity);
  if (competingTxs.length === 0) return logger.warn(`No competing transactions found in block ${blockN1} for these pools.`);

  logger.info(`⚔️  Found ${competingTxs.length} competing transaction(s):\n`);
  for (const ctx of competingTxs) {
    printCompetingTx(ctx, opportunity, baseFee);
  }
}

// ========================================================================================
// BUILD POOL TARGETS from opportunity steps
// ========================================================================================
function buildPoolTargets(opportunity: ArbitrageOpportunity): PoolTarget[] {
  const V2_INTERFACE = new ethers.Interface([
    'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
  ]);
  const V3_INTERFACE = new ethers.Interface([
    'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
  ]);
  const V4_INTERFACE = new ethers.Interface([
    'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
  ]);

  const targets: PoolTarget[] = [];

  for (let i = 0; i < opportunity.steps.length; i++) {
    const step = opportunity.steps[i];
    const pool = step.pool;
    const label = `${pool.venue.name}(${pool.feeBps})[${step.tokenIn.symbol}->${step.tokenOut.symbol}]`;

    if (pool.protocol === 'v4') {
      const v4pool = pool as DexV4PoolState;
      targets.push({
        stepIndex: i,
        protocol: 'v4',
        poolAddress: pool.address.toLowerCase(), // PoolManager address
        poolKeyHash: v4pool.poolKeyHash,
        label,
        swapTopic: V4_SWAP_TOPIC,
        swapInterface: V4_INTERFACE,
      });
    } else {
      // V2 or V3
      targets.push({
        stepIndex: i,
        protocol: pool.protocol as 'v2' | 'v3',
        poolAddress: pool.address.toLowerCase(),
        label,
        swapTopic: pool.protocol === 'v2' ? V2_SWAP_TOPIC : V3_SWAP_TOPIC,
        swapInterface: pool.protocol === 'v2' ? V2_INTERFACE : V3_INTERFACE,
      });
    }
  }

  return targets;
}

// ========================================================================================
// FIND COMPETING TRANSACTIONS
// ========================================================================================
async function findCompetingTransactions(
  blockN1: number,
  poolTargets: PoolTarget[],
  opportunity: ArbitrageOpportunity,
): Promise<CompetingTx[]> {
  // Fetch logs for each pool target in parallel
  const logFetches = poolTargets.map(async (target) => {
    const filter: ethers.Filter = {
      fromBlock: blockN1,
      toBlock: blockN1,
      address: target.poolAddress,
      topics:
        target.protocol === 'v4' && target.poolKeyHash
          ? [target.swapTopic, ethers.zeroPadValue(target.poolKeyHash, 32)]
          : [target.swapTopic],
    };
    const logs = await provider.getLogs(filter);
    return { target, logs };
  });

  const results = await Promise.all(logFetches);

  // Collect all matching logs and group by tx hash
  const txHashToSwaps = new Map<string, SwapEventDecoded[]>();
  for (const { target, logs } of results) {
    for (const log of logs) {
      const decoded = decodeSwapLog(log, target);
      if (!decoded) continue;
      const existing = txHashToSwaps.get(log.transactionHash) ?? [];
      existing.push(decoded);
      txHashToSwaps.set(log.transactionHash, existing);
    }
  }

  if (txHashToSwaps.size === 0) return [];

  // Fetch tx + receipt for each matching tx hash
  const txHashes = [...txHashToSwaps.keys()];
  logger.info(`   Found ${txHashes.length} matching tx hash(es), fetching tx+receipt...`);

  const txResults = await Promise.all(
    txHashes.map(async (hash) => {
      const [tx, receipt] = await Promise.all([provider.getTransaction(hash), provider.getTransactionReceipt(hash)]);
      return { hash, tx, receipt, swaps: txHashToSwaps.get(hash)! };
    }),
  );

  const competingTxs: CompetingTx[] = [];
  for (const { hash, tx, receipt, swaps } of txResults) {
    if (!tx || !receipt) {
      logger.warn(`⚠️  Could not fetch tx or receipt for ${hash}`);
      continue;
    }

    const gasUsed = receipt.gasUsed;
    const effectiveGasPrice = receipt.gasPrice ?? 0n;
    const maxPriorityFeePerGas = tx.maxPriorityFeePerGas ?? null; // null for legacy txs
    const gasCostWEI = gasUsed * effectiveGasPrice;
    const priorityFeeWEI = maxPriorityFeePerGas != null ? gasUsed * maxPriorityFeePerGas : 0n;

    competingTxs.push({
      txHash: hash,
      blockNumber: receipt.blockNumber,
      txIndex: receipt.index,
      from: tx.from,
      to: tx.to,
      gasLimit: tx.gasLimit,
      gasUsed,
      effectiveGasPrice,
      maxPriorityFeePerGas,
      gasCostWEI,
      gasCostETH: ethers.formatEther(gasCostWEI),
      priorityFeeWEI,
      priorityFeeETH: ethers.formatEther(priorityFeeWEI),
      isPossiblyFlashbots: tx.type === 2 && (maxPriorityFeePerGas === 0n || maxPriorityFeePerGas === null),
      swaps,
    });
  }

  // Sort by tx position in block (txIndex)
  competingTxs.sort((a, b) => a.txIndex - b.txIndex);
  return competingTxs;
}

// ========================================================================================
// DECODE SWAP LOG
// ========================================================================================
function decodeSwapLog(log: ethers.Log, target: PoolTarget): SwapEventDecoded | null {
  try {
    const parsed = target.swapInterface.parseLog({ topics: log.topics as string[], data: log.data });
    if (!parsed) return null;

    let amount0: bigint, amount1: bigint, sqrtPriceX96: bigint | undefined, tick: number | undefined;

    if (target.protocol === 'v2') {
      // Swap(sender, amount0In, amount1In, amount0Out, amount1Out, to)
      const a0In = parsed.args[1] as bigint;
      const a0Out = parsed.args[3] as bigint;
      const a1In = parsed.args[2] as bigint;
      const a1Out = parsed.args[4] as bigint;
      amount0 = a0Out - a0In; // net: negative = out of pool, positive = into pool
      amount1 = a1Out - a1In;
    } else {
      // V3/V4: amount0 and amount1 are signed (negative = out of pool)
      amount0 = parsed.args.amount0 as bigint;
      amount1 = parsed.args.amount1 as bigint;
      sqrtPriceX96 = parsed.args.sqrtPriceX96 as bigint;
      tick = Number(parsed.args.tick as bigint);
    }

    return {
      protocol: target.protocol,
      poolAddress: target.poolAddress,
      poolKeyHash: target.poolKeyHash,
      label: target.label,
      amount0,
      amount1,
      sqrtPriceX96,
      tick,
      raw: log,
    };
  } catch (err) {
    logger.warn(`⚠️  Failed to decode ${target.protocol} swap log: ${err}`);
    return null;
  }
}

// ========================================================================================
// PRINT
// ========================================================================================
function printCompetingTx(ctx: CompetingTx, opportunity: ArbitrageOpportunity, baseFee: bigint) {
  const borrowToken = opportunity.borrowToken;
  logger.info(`─────────────────────────────────────────────────────────`);
  logger.info(`🏁 TX #${ctx.txIndex}  ${ctx.txHash}`);
  logger.info(`   From: ${ctx.from}  →  To: ${ctx.to}`);
  logger.info(`   Gas: used ${ctx.gasUsed.toLocaleString()} / limit ${ctx.gasLimit.toLocaleString()}`);
  logger.info(`   Effective gas price: ${ethers.formatUnits(ctx.effectiveGasPrice, 'gwei')} gwei`);
  logger.info(`   Gas cost: ${ctx.gasCostETH} ETH`);
  if (ctx.maxPriorityFeePerGas !== null) {
    logger.info(
      `   Priority fee (tip/bribe): ${ethers.formatUnits(ctx.maxPriorityFeePerGas, 'gwei')} gwei  →  ${ctx.priorityFeeETH} ETH total`,
    );
  } else {
    logger.info(`   Priority fee: (legacy tx, no EIP-1559 tip)`);
  }
  if (ctx.isPossiblyFlashbots) {
    logger.warn(`   ⚠️  Possibly Flashbots bundle (0 priority fee — check for coinbase transfer via trace)`);
  }
  logger.info(`   Swaps in this tx touching our pools:`);
  for (const swap of ctx.swaps) {
    const a0Fmt = ethers.formatUnits(swap.amount0 < 0n ? -swap.amount0 : swap.amount0, 18); // TODO: use actual token decimals
    const a1Fmt = ethers.formatUnits(swap.amount1 < 0n ? -swap.amount1 : swap.amount1, 18);
    const dir0 = swap.amount0 < 0n ? 'OUT' : 'IN';
    const dir1 = swap.amount1 < 0n ? 'OUT' : 'IN';
    logger.info(
      `     [${swap.label}]  token0: ${dir0} ${a0Fmt}  |  token1: ${dir1} ${a1Fmt}${swap.tick !== undefined ? `  tick=${swap.tick}` : ''}`,
    );
  }
}

// ========================================================================================
main()
  .then(() => logger.info('✅ Done'))
  .catch((err) => {
    logger.error(`❌ Error: ${err.message}`, { err });
    process.exit(1);
  })
  .finally(async () => {
    await db.destroy();
    process.exit(0);
  });
