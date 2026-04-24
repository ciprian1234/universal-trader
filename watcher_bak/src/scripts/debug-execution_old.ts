import 'dotenv/config'; // Load environment variables
import CONFIG from '../config';
import * as fs from 'fs';
import { PrismaStorage } from '../services/storageService';
import { Blockchain } from '../core/blockchain';
import { CacheService } from '../core/cache-service';
import { TokenManager } from '../core/token-manager';
import { DexRegistry } from '../services/dex-registry';
import { ArbitrageOpportunity, PoolState } from '../core/interfaces';
import { exec, spawn } from 'child_process';
import path from 'path';
import { ethers } from 'ethers';
import { Trade } from '../core/flash-arbitrage-handler/flashArbitrageConfig';
import { ArbitrageExecution } from '@prisma/client';

// ================================================================================================
// CONFIGURATION
// ================================================================================================

// Explicitly set latest block number for fork (overrides opportunity data)
let latestBlockNumber = 24235025; // If set to 0, will use block number from opportunity data

// Opportunity ID to debug
const SPAWN_HARDHAT_NODE = true; // set to false to connect to an existing hardhat node, or true to spawn a node
const CONTRACT_ADDR = ''; // set to existing deployed contract address if not spawning hardhat node
const opportunityId =
  '1768418796799_0x91a76255ddeee3f03267c9cbe5a28311a6abb58d→0x5ae13baaef0620fdae1d355495dc51a17adb4082→0x7858e59e0c01ea06df3af3d20ac7b0003275d4bf'; // replace with desired opportunity ID

const WALLET_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // default hardhat account 0 private key
if (!process.env.CHAIN_ID) throw new Error('CHAIN_ID environment variable is not set');
if (!process.env.CHAIN_RPC_URL_HTTP) throw new Error('CHAIN_RPC_URL_HTTP environment variable is not set');
if (!SPAWN_HARDHAT_NODE && !CONTRACT_ADDR) throw new Error('CONTRACT_ADDR must be set if not spawning Hardhat node');

const chainId = parseInt(process.env.CHAIN_ID);
const storage = new PrismaStorage();
const cache = new CacheService(chainId);

const HARDHAT_PORT = 8545;
const HARDHAT_RPC_URL = `http://127.0.0.1:${HARDHAT_PORT}`;
const HARDHAT_PROJECT_PATH = path.resolve(__dirname, '../../../arbitrage_contract'); // path to Hardhat project

// hardhat process handle
let hardhatProcess: any = null;
let hardhatOutput = '';

// Core app services
let blockchain: Blockchain;
let tokenManager: TokenManager;
let dexRegistry: DexRegistry;

// ================================================================================================
// Main wrapper
// ================================================================================================
async function main() {
  try {
    await storage.initialize();
    await cache.load();

    const db = storage.getDB();
    console.log(`Fetching opportunity ID: ${opportunityId} from database...`);

    const opportunity = (await db.arbitrageOpportunity.findUnique({
      where: { id: opportunityId },
    })) as unknown as ArbitrageOpportunity | null;
    if (!opportunity) throw new Error(`Opportunity not found in database: ${opportunityId}`);

    const execution = await db.arbitrageExecution.findFirst({ where: { id: opportunityId }, orderBy: { submittedAt: 'desc' } });
    if (!execution) throw new Error(`No execution found for opportunity ID: ${opportunityId}`);

    // Extract block number from opportunity
    if (!opportunity.steps || opportunity.steps.length < 2)
      throw new Error('Opportunity does not have enough steps to determine block number');
    for (const eventMeta of opportunity.steps.map((step) => step.pool!.latestEventMeta)) {
      // console.log('Event meta:', eventMeta);
      if (eventMeta && eventMeta.blockNumber > latestBlockNumber) latestBlockNumber = eventMeta.blockNumber;
    }

    console.log(`Latest block number from opportunity events: ${latestBlockNumber}`);
    if (latestBlockNumber === 0) throw new Error('Could not determine latest block number from opportunity events');

    // Start Hardhat fork at the specific block
    if (SPAWN_HARDHAT_NODE) await startHardhatFork(latestBlockNumber);

    // Init Required App Services
    blockchain = new Blockchain({ chainId, providerURL: HARDHAT_RPC_URL!, cache });
    tokenManager = new TokenManager({ blockchain, priceUpdateIntervalMs: 60000 * 60, inputTokens: CONFIG.TOKENS });
    dexRegistry = new DexRegistry({ blockchain, tokenManager });
    await tokenManager.batchRegisterTokens();
    dexRegistry.setupDexAdapters();
    const provider = blockchain.getProvider();
    const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);
    console.log('\n✅ Services initialized on forked network');

    await comparePoolStatesWithOnChainData(
      opportunity.steps.map((step) => step.pool!),
      blockchain,
      dexRegistry,
    );

    // deploy flash arbitrage contract on forked network
    let contractAddress = CONTRACT_ADDR;
    if (SPAWN_HARDHAT_NODE) contractAddress = await deployDebugFlashArbitrageContract(provider, wallet);

    // execute trade
    // await debugExecutionOnForkedNetwork(contractAddress, execution, provider, wallet);

    // debug opportunity parameters
    await debugOpportunityParameters(opportunity);

    console.log('\n✅ Debug script completed successfully');
  } catch (error) {
    console.error('\n❌ Error in debug script:', error);
  } finally {
    // Cleanup
    if (SPAWN_HARDHAT_NODE) await stopHardhatFork();
    await storage.cleanup();
  }
}

// Entry point
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });

// ================================================================================================
// SCRIPT: Script core logic
// ================================================================================================
async function comparePoolStatesWithOnChainData(pools: PoolState[], blockchain: Blockchain, dexRegistry: DexRegistry) {
  console.log('🔍 Debugging arbitrage opportunities in storage...');

  let swapIndex = 1;
  for (const pool of pools) {
    const adapter = dexRegistry.getAdapter(pool.dexName)!;
    blockchain.initContract(pool.id as string, adapter.POOL_ABI); // NOTE: only for uniswap v2 and v3 this works
    let realPoolState = await adapter.initPool(pool.id);
    realPoolState = await adapter.updatePool(realPoolState)!;
    console.log(`\n\n\n--- [Swap ${swapIndex}] ${pool.dexName} ${pool.tokenPair.pairKey} (${pool.fee}) Pool State Comparison ---`);
    console.log('Reserve0:');
    console.log('  Stored:', pool.reserve0!.toString());
    console.log('  Real:  ', realPoolState.reserve0!.toString());
    console.log('Reserve1:');
    console.log('  Stored:', pool.reserve1!.toString());
    console.log('  Real:  ', realPoolState.reserve1!.toString());
    if (pool.dexType === 'uniswap-v3') {
      console.log('SqrtPriceX96:');
      console.log('  Stored:', pool.sqrtPriceX96!.toString());
      console.log('  Real:  ', realPoolState.sqrtPriceX96!.toString());
      console.log('Tick:');
      console.log('  Stored:', pool.tick);
      console.log('  Real:  ', realPoolState.tick);
      console.log('Liquidity:');
      console.log('  Stored:', pool.liquidity!.toString());
      console.log('  Real:  ', realPoolState.liquidity!.toString());
    } else {
      console.log('Unknown DEX type for pool state comparison');
    }
    swapIndex++;
  }
}

// ================================================================================================
// HARDHAT FORK MANAGEMENT
// ================================================================================================
async function startHardhatFork(blockNumber: number): Promise<void> {
  console.log(`🔧 Starting Hardhat fork at block ${blockNumber}...`);
  console.log(`   Hardhat project path: ${HARDHAT_PROJECT_PATH}`);
  console.log(`   Forking from: ${process.env.CHAIN_RPC_URL_HTTP}`);

  return new Promise((resolve, reject) => {
    // Start Hardhat node with forking
    hardhatProcess = spawn(
      'npx',
      [
        'hardhat',
        'node',
        '--fork',
        process.env.CHAIN_RPC_URL_HTTP!,
        '--fork-block-number',
        blockNumber.toString(),
        '--port',
        HARDHAT_PORT.toString(),
      ],
      {
        cwd: HARDHAT_PROJECT_PATH, // run from hardhat project directory
        shell: true,
      },
    );

    hardhatProcess.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      hardhatOutput += text;
      // Wait for "Started HTTP and WebSocket JSON-RPC server"
      if (text.includes('Started HTTP and WebSocket JSON-RPC server')) {
        console.log('✅ Hardhat fork ready');
        // Give it a moment to fully initialize
        setTimeout(() => resolve(), 2000);
      }
    });

    hardhatProcess.stderr.on('data', (data: Buffer) => {
      hardhatOutput += data.toString();
    });

    hardhatProcess.on('error', (error: Error) => {
      reject(new Error(`Failed to start Hardhat: ${error.message}`));
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (!hardhatOutput.includes('Started HTTP and WebSocket JSON-RPC server')) {
        reject(new Error('Hardhat fork timed out'));
      }
    }, 30000);
  });
}

async function stopHardhatFork(): Promise<void> {
  if (hardhatProcess) {
    console.log('🛑 Stopping Hardhat fork...');

    try {
      // Try graceful shutdown first
      hardhatProcess.kill('SIGTERM');

      // Wait for process to exit
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          console.warn('⚠️  Hardhat process did not exit gracefully, forcing...');
          hardhatProcess.kill('SIGKILL');
          resolve();
        }, 3000);

        hardhatProcess.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      console.log('✅ Hardhat fork stopped');
    } catch (error) {
      console.error('Error stopping Hardhat:', error);
    }

    // Finalize hardhat output
    // wait a moment to capture any remaining hardhat output
    await new Promise((resolve) => setTimeout(resolve, 2000));
    // write hardhat output to file for analysis
    const outputFilePath = path.resolve(__dirname, `hardhat-output.log`);
    fs.writeFileSync(outputFilePath, hardhatOutput);
    console.log(`Hardhat output saved to: ${outputFilePath}`);

    hardhatProcess = null;
  }
}

// ================================================================================================
// Deploy Debug Flash Arbitrage Contract
// ================================================================================================
async function deployDebugFlashArbitrageContract(provider: ethers.Provider, wallet: ethers.Wallet) {
  console.log('\n🚀 Deploying Debug Flash Arbitrage Contract...');

  // compile contract first
  console.log('🔨 Compiling contract...');
  await exec('npx hardhat compile', { cwd: HARDHAT_PROJECT_PATH });
  console.log('✅ Contract compiled');

  const contractFactory = new ethers.ContractFactory(
    require('../../../arbitrage_contract/artifacts/contracts/FlashArbitrage.sol/FlashArbitrage.json').abi,
    require('../../../arbitrage_contract/artifacts/contracts/FlashArbitrage.sol/FlashArbitrage.json').bytecode,
    wallet,
  );

  const contract = await contractFactory.deploy();
  await contract.waitForDeployment();

  const contractAddress = await contract.getAddress();
  console.log(`✅ Contract deployed at: ${contractAddress}`);
  return contractAddress;
}

// ================================================================================================
// Execute Trade on Forked Network
// ================================================================================================
async function debugExecutionOnForkedNetwork(
  contractAddress: string,
  execution: ArbitrageExecution,
  provider: ethers.Provider,
  wallet: ethers.Wallet,
) {
  const trade = execution.trade as unknown as Trade;
  if (!trade || !trade.swaps || trade.swaps.length < 2) throw new Error('Invalid trade data in execution');
  // set additional fields for new DEX types
  trade.swaps.forEach((swap) => {
    swap.amountIn = BigInt(swap.amountIn);
    swap.amountOutMin = BigInt(swap.amountOutMin);
    swap.fee = Number(swap.fee);

    // SET TO 0 OR EMPTY FOR NOW
    swap.poolId = '0x0000000000000000000000000000000000000000000000000000000000000000';
    swap.curveIndexIn = 0;
    swap.curveIndexOut = 0;
    swap.extraData = '0x';
  });

  console.log('\n================================== Debugging Execution ================================== ');
  console.log(`Trade:`, trade);

  console.log('\n🐛 Debugging Opportunity Execution on Forked Network...');
  const abi = require('../../../arbitrage_contract/artifacts/contracts/FlashArbitrage.sol/FlashArbitrage.json').abi;
  const flashArbitrageContract = new ethers.Contract(contractAddress, abi, wallet);

  // get contract code
  const code = await provider.getCode(contractAddress);
  if (code === '0x') throw new Error('❌ NO CONTRACT AT THIS ADDRESS!');
  console.log('✅ Contract exists (code length:', code.length, 'bytes)');

  // contract owner
  const owner = await flashArbitrageContract.owner();
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) throw new Error(`❌ Wallet is not the owner: ${wallet.address} != ${owner}`);
  console.log('✅ Contract owner:', owner);

  // Check token balances before trade
  await checkTokenBalances(provider, wallet, trade);

  // Verify swap parameters
  await verifySwapParams(provider, trade);

  // ✅ CRITICAL: Test with static call first to get proper error message
  // console.log('\n🔍 Testing with static call first (dry run)...');
  // console.log('Trade data:', trade);
  // try {
  //   const staticResult = await flashArbitrageContract.executeTrade.staticCall(trade, {
  //     from: wallet.address,
  //     gasLimit: 5000000n, // High limit for simulation
  //   });
  //   console.log('✅ Static call successful! Result:', staticResult);
  // } catch (error: any) {
  //   console.error('❌ Static call failed:', error);

  //   // Try to decode revert reason
  //   if (error.data) {
  //     console.error('   Data:', error.data);

  //     // Check if it's a standard Error(string) revert
  //     if (typeof error.data === 'string' && error.data.startsWith('0x08c379a0')) {
  //       try {
  //         const reason = ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + error.data.slice(10))[0];
  //         console.error('   ❌ REVERT REASON:', reason);
  //       } catch (e) {
  //         console.error('   Could not decode revert reason');
  //       }
  //     }
  //   }

  //   // Try Hardhat trace for detailed debugging
  //   console.log('\n🔍 Attempting detailed trace with debug_traceCall...');
  //   try {
  //     const tracePromise = (provider as HardhatProvider).send('debug_traceCall', [
  //       {
  //         from: wallet.address,
  //         to: contractAddress,
  //         data: flashArbitrageContract.interface.encodeFunctionData('executeTrade', [trade]),
  //         gas: ethers.toQuantity(5000000n),
  //       },
  //       'latest',
  //     ]);

  //     const timeoutPromise = new Promise((_, reject) => {
  //       setTimeout(() => reject(new Error('Trace timeout after 30 seconds')), 30000);
  //     });

  //     const trace = await Promise.race([tracePromise, timeoutPromise]);

  //     // saving trace to file for easier analysis
  //     const traceFilePath = path.resolve(__dirname, `debug-trace-${Date.now()}.json`);
  //     require('fs').writeFileSync(traceFilePath, JSON.stringify(trace, null, 2));
  //     console.log(`Saved trace saved to file: ${traceFilePath}`);

  //     // Look for revert in trace
  //     if (trace.error) {
  //       console.error('\n❌ TRACE ERROR:', trace.error);
  //     }
  //   } catch (traceError: any) {
  //     console.error('   Could not get trace:', traceError.message);
  //   }

  //   console.error('\n❌ Transaction would fail - stopping here');
  //   return;
  // }

  // Only proceed if static call succeeded
  console.log('\n🚀 Static call passed, now sending real transaction...');

  try {
    // ✅ Fetch current nonce from Hardhat node (CRITICAL for forked nodes)
    const currentNonce = await wallet.getNonce('latest');
    console.log(`📊 Current nonce: ${currentNonce}`);

    // Execute transaction
    const tx = await flashArbitrageContract.executeTrade(trade, {
      nonce: currentNonce, // Explicitly set nonce
      gasLimit: 2000000n, // Increased gas limit
      maxFeePerGas: ethers.parseUnits('10', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
    });
    if (!tx) throw new Error('Failed to send transaction');
    console.log(`📝 Transaction hash: ${tx.hash}`);
    console.log('⏳ Waiting for confirmation...');

    const receipt = await tx.wait(1, 60000); // wait max 60 seconds
    console.log(`✅ Transaction confirmed in block ${receipt!.blockNumber}`);
    console.log(`   Gas used: ${receipt!.gasUsed.toString()}`);

    // ✅ Parse events
    parseLogsFromReceipt(receipt!, flashArbitrageContract);

    console.log('\n✅ Transaction succeeded!');
  } catch (error: any) {
    const waitError = error.error;
    console.error('\n❌ Transaction failed!');
    console.error('Error:', waitError);

    // Try to decode revert reason
    if (waitError.data) {
      console.error('WaitError:', waitError.data);
      const tx = await provider.getTransaction(waitError.data.txHash);
      // console.log('Transaction:', tx);

      // get receipt
      const receipt = await provider.getTransactionReceipt(tx!.hash);
      console.log('Receipt:', receipt);
      parseLogsFromReceipt(receipt!, flashArbitrageContract);
    }
  }

  // Check token balances after trade
  await checkTokenBalances(provider, wallet, trade);
}

// ================================================================================================
// Debug Opportunity Parameters
// ================================================================================================
async function debugOpportunityParameters(opportunity: ArbitrageOpportunity) {
  console.log('\n================================== Debugging Opportunity Parameters ================================== ');
  console.log(`Opportunity ID: ${opportunity.id}`);
  console.log(`Timestamp: ${opportunity.timestamp}`);
  console.log(`Borrow Token: ${opportunity.borrowToken.symbol} (${opportunity.borrowToken.address})`);
  console.log(`Borrow Amount: ${opportunity.borrowAmount.toString()}`);
  console.log(`Gross Profit (Token): ${opportunity.grossProfitToken.toString()}`);
  console.log(`Gross Profit (USD): $${opportunity.grossProfitUSD.toFixed(2)}`);
  console.log(`Net Profit (USD): $${opportunity.netProfitUSD.toFixed(2)}`);
  console.log(`Total Slippage: ${(opportunity.totalSlippage * 100).toFixed(4)}%`);
  console.log(`Total Price Impact: ${(opportunity.totalPriceImpact * 100).toFixed(4)}%`);

  console.log(`\nSteps:`);
  let stepIndex = 1;
  for (const step of opportunity.steps) {
    const t_in = step.tokenIn;
    const t_out = step.tokenOut;
    console.log(`  Step ${stepIndex}:`);
    console.log(`    DEX: ${step.pool.dexName} ${step.pool.tokenPair.pairKey} (${step.pool.fee})`);
    console.log(`    Pool ID: ${step.pool.id}`);
    console.log(`    STATE:`);
    console.log(`      Reserve0: ${step.pool.reserve0?.toString()}`);
    console.log(`      Reserve1: ${step.pool.reserve1?.toString()}`);
    console.log(`      SqrtPriceX96: ${step.pool.sqrtPriceX96?.toString()}`);
    console.log(`      Tick: ${step.pool.tick}`);
    console.log(`      Liquidity: ${step.pool.liquidity?.toString()}`);
    console.log(`      Computed:`);
    console.log(`        Spot Price 0 to 1: ${step.pool.spotPrice0to1}`);
    console.log(`        Spot Price 1 to 0: ${step.pool.spotPrice1to0}`);
    console.log(`        Total Liquidity in USD: $${step.pool.totalLiquidityInUSD.toFixed(2)}`);
    console.log(`    Token In: ${step.tokenIn.symbol} (${step.tokenIn.address})`);
    console.log(`    Token Out: ${step.tokenOut.symbol} (${step.tokenOut.address})`);
    console.log(`    Amount In: ${step.amountIn.toString()} (${ethers.formatUnits(step.amountIn, t_in.decimals)} ${t_in.symbol})`);
    console.log(`    Amount Out: ${step.amountOut.toString()} (${ethers.formatUnits(step.amountOut, t_out.decimals)} ${t_out.symbol})`);
    stepIndex++;

    // simulate swap
    const adapter = dexRegistry.getAdapter(step.pool.dexName)!;
    const zeroForOne = step.pool.tokenPair.token0.address.toLowerCase() === step.tokenIn.address.toLowerCase();
    const normalizedPool = {
      ...step.pool,
      reserve0: BigInt(step.pool.reserve0!),
      reserve1: BigInt(step.pool.reserve1!),
      liquidity: BigInt(step.pool.liquidity!),
      sqrtPriceX96: BigInt(step.pool.sqrtPriceX96!),
      fee: Number(step.pool.fee),
    };
    const simulatedAmountOut = adapter.simulateSwap(normalizedPool, BigInt(step.amountIn), zeroForOne);
    const quoteCall = await adapter.getTradeQuote(normalizedPool, BigInt(step.amountIn), zeroForOne);
    console.log(`    Simulated Amount Out: ${simulatedAmountOut.toString()}`);
    console.log(
      `    Quoted Amount Out: ${quoteCall.amountOut.toString()} ${ethers.formatUnits(quoteCall.amountOut, t_out.decimals)} ${
        t_out.symbol
      }\n\n`,
    );
  }
}

function parseLogsFromReceipt(receipt: ethers.TransactionReceipt, contract: ethers.Contract) {
  // ✅ Parse events
  console.log('\n📋 Events emitted:');
  for (const [i, log] of receipt!.logs.entries()) {
    try {
      const parsed = contract.interface.parseLog({
        topics: log.topics as string[],
        data: log.data,
      });

      if (parsed) {
        console.log(`[${i}] ${parsed.name}:`, parsed.args);
      }
    } catch (e) {
      console.log('   Unparseable log:', log);
    }
  }
}

const TOKEN_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

async function checkTokenBalances(provider: ethers.Provider, wallet: ethers.Wallet, trade: Trade) {
  console.log('\n================================== Token Balances ================================== ');
  const walletBalance = await provider.getBalance(wallet.address);
  console.log(`ETH Balance: ${ethers.formatEther(walletBalance)}`);
  for (const swap of trade.swaps) {
    const tokenContract = new ethers.Contract(swap.tokenIn, TOKEN_ABI, provider);
    const balance: bigint = await tokenContract.balanceOf(wallet.address);
    const symbol: string = await tokenContract.symbol();
    const decimals: number = await tokenContract.decimals();
    console.log(`Token: ${symbol} (decimals: ${decimals}) (${swap.tokenIn}) - Balance: ${ethers.formatUnits(balance, decimals)}`);
  }
}

async function verifySwapParams(provider: ethers.Provider, trade: Trade) {
  // 6. Check Balancer Vault
  const balancerVaultAddress = '0xBA12222222228d8Ba445958a75a0704d566BF2C8';
  const vaultCode = await provider.getCode(balancerVaultAddress);
  if (vaultCode === '0x') throw new Error(`❌ Balancer Vault contract does not exist at address ${balancerVaultAddress}`);
  else console.log(`✅ Balancer Vault contract exists (code length: ${vaultCode.length} bytes)`);

  // verify vault balance for borrowed token
  const vaultAbi = ['function getPoolTokens(bytes32 poolId) view returns (address[] tokens, uint256[] balances, uint256 lastChangeBlock)'];

  try {
    const vault = new ethers.Contract(balancerVaultAddress, vaultAbi, provider);

    // Get token balance in Balancer
    // Note: This is a simplified check - Balancer flash loans pull from all pools
    const borrowTokenContract = new ethers.Contract(trade.swaps[0].tokenIn, TOKEN_ABI, provider);
    const borrowTokenSymbol: string = await borrowTokenContract.symbol();
    const borrowTokenDecimals: number = await borrowTokenContract.decimals();
    const vaultTokenBalance = await borrowTokenContract.balanceOf(balancerVaultAddress);

    console.log(
      `✅ Balancer Vault ${borrowTokenSymbol} balance: ${ethers.formatUnits(vaultTokenBalance, borrowTokenDecimals)} ${borrowTokenSymbol}`,
    );

    const borrowAmount = BigInt(trade.swaps[0].amountIn);
    if (vaultTokenBalance < borrowAmount) {
      console.error(`❌ INSUFFICIENT LIQUIDITY IN BALANCER!`);
      console.error(`   Required: ${ethers.formatUnits(borrowAmount, borrowTokenDecimals)} ${borrowTokenSymbol}`);
      console.error(`   Available: ${ethers.formatUnits(vaultTokenBalance, borrowTokenDecimals)} ${borrowTokenSymbol}`);
      return;
    }
    console.log(`✅ Balancer has enough liquidity for flash loan`);
  } catch (error: any) {
    console.warn('⚠️  Could not verify Balancer liquidity:', error.message);
  }

  const tokens = new Map<string, { symbol: string; decimals: number; balance: bigint }>();
  for (const [index, swap] of trade.swaps.entries()) {
    console.log(`Verifying swap ${index + 1}:`);
    // Check if router contract exists
    const code = await provider.getCode(swap.router);
    if (code === '0x') throw new Error(`❌ Router contract does not exist at address ${swap.router}`);
    else console.log(`  ✅ Router contract exists (code length: ${code.length} bytes)`);

    // Check if tokenIn contract exists
    const tokenInCode = await provider.getCode(swap.tokenIn);
    if (tokenInCode === '0x') throw new Error(`❌ tokenIn contract does not exist at address ${swap.tokenIn}`);
    else console.log(`  ✅ tokenIn contract exists (code length: ${tokenInCode.length} bytes)`);

    // Check if tokenOut contract exists
    const tokenOutCode = await provider.getCode(swap.tokenOut);
    if (tokenOutCode === '0x') throw new Error(`❌ tokenOut contract does not exist at address ${swap.tokenOut}`);
    else console.log(`  ✅ tokenOut contract exists (code length: ${tokenOutCode.length} bytes)`);
  }
}
