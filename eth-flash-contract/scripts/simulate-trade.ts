import { ethers } from 'hardhat';
import { Contract } from 'ethers';

// 🏦 TOKEN ADDRESSES (Ethereum Mainnet)
const TOKENS = {
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
  DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
};

// 🔧 SPECIAL CONSTANT FOR NATIVE ETH
const NATIVE_ETH = 'ETH'; // Use special identifier for native ETH

// 🏭 DEX ADDRESSES
const DEX_ADDRESSES = {
  UNISWAP_V2_ROUTER: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
  UNISWAP_V3_ROUTER: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  UNISWAP_V3_QUOTER: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
  SUSHISWAP_ROUTER: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
};

// 📊 ABIS
const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

const UNISWAP_V2_ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
];

const UNISWAP_V3_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];

const UNISWAP_V3_QUOTER_ABI = [
  'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external view returns (uint256 amountOut)',
];

// 📋 INTERFACES
interface TradeParams {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  slippage?: number; // Percentage (default: 1%)
  deadline?: number; // Seconds from now (default: 300)
}

interface V2TradeParams extends TradeParams {
  // V2 doesn't need additional params
}

interface V3TradeParams extends TradeParams {
  fee: number; // Fee tier (500 = 0.05%, 3000 = 0.3%, 10000 = 1%)
}

// 🎯 MAIN EXECUTION - Example trades
async function main() {
  console.log('🚀 Starting Generic DEX Trade Simulation...\n');

  const [_, signer] = await ethers.getSigners(); // Second wallet from array
  console.log(`📝 Signer address: ${signer.address}`);

  // 0. Get initial balances
  console.log('🔍 Checking initial token balances...');
  await printTokenBalance(NATIVE_ETH, signer); // ✅ Native ETH
  await printTokenBalance(TOKENS.WETH, signer); // ✅ WETH token
  await printTokenBalance(TOKENS.USDC, signer);
  await printTokenBalance(TOKENS.WBTC, signer);
  await printTokenBalance(TOKENS.DAI, signer);
  console.log();

  // wrap eth first
  const tradeAmount = ethers.parseEther('1');
  await wrapETH(signer, tradeAmount);

  // 4. WETH token → USDC (treating WETH as regular ERC-20)
  await executeUniswapV2Trade(signer, {
    tokenIn: TOKENS.WETH, // ✅ WETH as ERC-20 token
    tokenOut: TOKENS.USDC,
    amountIn: tradeAmount,
    slippage: 1,
  });

  // 1. Native ETH → USDC on Uniswap V2
  // await executeUniswapV2Trade(signer, {
  //   tokenIn: NATIVE_ETH, // ✅ Use NATIVE_ETH
  //   tokenOut: TOKENS.USDC,
  //   amountIn: ethers.parseEther('1'), // 1 ETH
  //   slippage: 1,
  // });

  // 2. USDC → WBTC on Uniswap V3
  // await executeUniswapV2Trade(signer, {
  //   tokenIn: TOKENS.USDC,
  //   tokenOut: TOKENS.WBTC,
  //   amountIn: ethers.parseUnits('0.1', 6), // 0.1 USDC
  //   slippage: 1,
  // });

  // 3. WBTC → Native ETH on Uniswap V2
  // await executeUniswapV2Trade(signer, {
  //   tokenIn: TOKENS.WBTC,
  //   tokenOut: NATIVE_ETH, // ✅ Use NATIVE_ETH
  //   amountIn: ethers.parseUnits('0.01', 8), // 0.01 WBTC
  //   slippage: 1,
  // });

  console.log('✅ All trades completed successfully!');
}

/**
 * 🦄 CORRECTED UNISWAP V2 TRADE
 */
async function executeUniswapV2Trade(signer: any, params: V2TradeParams) {
  console.log('🦄 === UNISWAP V2 TRADE ===');

  try {
    const router = new Contract(DEX_ADDRESSES.UNISWAP_V2_ROUTER, UNISWAP_V2_ROUTER_ABI, signer);

    const { tokenIn, tokenOut, amountIn } = params;
    const slippage = params.slippage || 1;
    const deadline = Math.floor(Date.now() / 1000) + (params.deadline || 300);

    // ✅ CORRECTED: Check for native ETH, not WETH token
    const isNativeETHIn = tokenIn === NATIVE_ETH;
    const isNativeETHOut = tokenOut === NATIVE_ETH;

    // Build path (convert native ETH to WETH for router)
    const pathTokenIn = isNativeETHIn ? TOKENS.WETH : tokenIn;
    const pathTokenOut = isNativeETHOut ? TOKENS.WETH : tokenOut;
    const path = [pathTokenIn, pathTokenOut];

    // Get token info for display
    const tokenInInfo = isNativeETHIn ? { symbol: 'ETH', decimals: 18 } : await getTokenInfo(tokenIn, signer);
    const tokenOutInfo = isNativeETHOut ? { symbol: 'ETH', decimals: 18 } : await getTokenInfo(tokenOut, signer);

    // gas tx settings
    const gasSettings: any = {
      gasLimit: 300000,
      maxFeePerGas: ethers.parseUnits('20', 'gwei'), // Set a high max fee to prioritize the transaction
      maxPriorityFeePerGas: ethers.parseUnits('5', 'gwei'), // Set a high priority fee to incentivize miners
    };

    console.log(
      `📊 Trading: ${ethers.formatUnits(amountIn, tokenInInfo.decimals)} ${tokenInInfo.symbol} → ${tokenOutInfo.symbol}`,
    );

    // Get quote
    const amountsOut = await router.getAmountsOut(amountIn, path);
    const expectedOut = amountsOut[1];
    console.log(`📈 Expected: ${ethers.formatUnits(expectedOut, tokenOutInfo.decimals)} ${tokenOutInfo.symbol}`);

    // Calculate minimum amount out with slippage
    const amountOutMin = (expectedOut * BigInt(100 - slippage)) / BigInt(100);

    let tx;
    if (isNativeETHIn) {
      tx = await router.swapExactETHForTokens(amountOutMin, path, signer.address, deadline, { value: amountIn, ...gasSettings });
    } else if (isNativeETHOut) {
      await ensureApproval(tokenIn, DEX_ADDRESSES.UNISWAP_V2_ROUTER, amountIn, signer);
      tx = await router.swapExactTokensForETH(amountIn, amountOutMin, path, signer.address, deadline, gasSettings);
    } else {
      await ensureApproval(tokenIn, DEX_ADDRESSES.UNISWAP_V2_ROUTER, amountIn, signer);
      tx = await router.swapExactTokensForTokens(amountIn, amountOutMin, path, signer.address, deadline, gasSettings);
    }

    const receipt = await tx.wait();
    console.log(`✅ Transaction confirmed: ${receipt.hash}`);
    console.log(`⛽ Gas used: ${receipt.gasUsed.toString()}`);

    // Check final balance
    await printTokenBalance(tokenOut, signer);
    console.log();
  } catch (error) {
    console.error('❌ Uniswap V2 trade failed:', error);
  }
}

/**
 * 🦄 CORRECTED UNISWAP V3 TRADE
 */
async function executeUniswapV3Trade(signer: any, params: V3TradeParams) {
  console.log('🦄 === UNISWAP V3 TRADE ===');

  try {
    const router = new Contract(DEX_ADDRESSES.UNISWAP_V3_ROUTER, UNISWAP_V3_ROUTER_ABI, signer);
    const quoter = new Contract(DEX_ADDRESSES.UNISWAP_V3_QUOTER, UNISWAP_V3_QUOTER_ABI, signer);

    const { tokenIn, tokenOut, amountIn, fee } = params;
    const slippage = params.slippage || 1;
    const deadline = Math.floor(Date.now() / 1000) + (params.deadline || 300);

    // ✅ CORRECTED: Check for native ETH, not WETH token
    const isNativeETHIn = tokenIn === NATIVE_ETH;
    const isNativeETHOut = tokenOut === NATIVE_ETH;

    // Build path (convert native ETH to WETH for router)
    const pathTokenIn = isNativeETHIn ? TOKENS.WETH : tokenIn;
    const pathTokenOut = isNativeETHOut ? TOKENS.WETH : tokenOut;

    // Get token info for display
    const tokenInInfo = isNativeETHIn ? { symbol: 'ETH', decimals: 18 } : await getTokenInfo(tokenIn, signer);
    const tokenOutInfo = isNativeETHOut ? { symbol: 'ETH', decimals: 18 } : await getTokenInfo(tokenOut, signer);

    console.log(
      `📊 Trading: ${ethers.formatUnits(amountIn, tokenInInfo.decimals)} ${tokenInInfo.symbol} → ${tokenOutInfo.symbol} (${
        fee / 10000
      }% fee)`,
    );

    // ✅ Check token balance (only for actual ERC-20 tokens)
    if (!isNativeETHIn) {
      const balance = await getTokenBalance(tokenIn, signer.address, signer);
      if (balance < amountIn) {
        console.log(`❌ Insufficient ${tokenInInfo.symbol} balance for V3 trade`);
        return;
      }
    }

    // Get quote (use WETH addresses for router)
    const expectedOut = await quoter.quoteExactInputSingle(pathTokenIn, pathTokenOut, fee, amountIn, 0);
    console.log(`📈 Expected: ${ethers.formatUnits(expectedOut, tokenOutInfo.decimals)} ${tokenOutInfo.symbol}`);

    // ✅ Approve router to spend tokens (only for ERC-20 tokens, not native ETH)
    if (!isNativeETHIn) {
      console.log('🔓 Approving token spend...');
      await ensureApproval(tokenIn, DEX_ADDRESSES.UNISWAP_V3_ROUTER, amountIn, signer);
    }

    // Calculate minimum amount out with slippage
    const amountOutMin = (expectedOut * BigInt(100 - slippage)) / BigInt(100);

    // Prepare parameters as array (use WETH addresses for router)
    const swapParams = [
      pathTokenIn, // tokenIn (WETH if native ETH)
      pathTokenOut, // tokenOut (WETH if native ETH)
      fee, // fee
      signer.address, // recipient
      deadline, // deadline
      amountIn, // amountIn
      amountOutMin, // amountOutMinimum
      0, // sqrtPriceLimitX96
    ];

    console.log('🔄 Executing V3 swap...');
    const txOptions: any = { gasLimit: 300000 };

    // ✅ Add ETH value only for native ETH input
    if (isNativeETHIn) {
      txOptions.value = amountIn;
    }

    const tx = await router.exactInputSingle(swapParams, txOptions);
    const receipt = await tx.wait();

    console.log(`✅ Transaction confirmed: ${receipt.hash}`);
    console.log(`⛽ Gas used: ${receipt.gasUsed.toString()}`);

    // Check final balance
    await printTokenBalance(tokenOut, signer);
    console.log();
  } catch (error) {
    console.error('❌ Uniswap V3 trade failed:', error);
  }
}

/**
 * 🛠️ UTILITY FUNCTIONS
 */
async function getTokenInfo(tokenAddress: string, signer: any) {
  const contract = new Contract(tokenAddress, ERC20_ABI, signer);
  const [symbol, decimals] = await Promise.all([contract.symbol(), contract.decimals()]);

  return {
    address: tokenAddress,
    symbol,
    decimals: Number(decimals),
  };
}

async function getTokenBalance(tokenAddress: string, userAddress: string, signer: any): Promise<bigint> {
  // ✅ CORRECTED: Check for native ETH identifier, not WETH address
  if (tokenAddress === NATIVE_ETH) {
    return await signer.provider.getBalance(userAddress);
  }

  // For all ERC-20 tokens (including WETH)
  const contract = new Contract(tokenAddress, ERC20_ABI, signer);
  return await contract.balanceOf(userAddress);
}

async function printTokenBalance(tokenAddress: string, signer: any) {
  const balance = await getTokenBalance(tokenAddress, signer.address, signer);

  // ✅ CORRECTED: Check for native ETH identifier, not WETH address
  if (tokenAddress === NATIVE_ETH) {
    console.log(`💰 ETH balance: ${ethers.formatEther(balance)} ETH`);
  } else {
    const tokenInfo = await getTokenInfo(tokenAddress, signer);
    console.log(`💰 ${tokenInfo.symbol} balance: ${ethers.formatUnits(balance, tokenInfo.decimals)} ${tokenInfo.symbol}`);
  }
}

async function ensureApproval(tokenAddress: string, spenderAddress: string, amountNeeded: bigint, signer: any) {
  const tokenContract = new Contract(tokenAddress, ERC20_ABI, signer);
  const currentAllowance = await tokenContract.allowance(signer.address, spenderAddress);

  if (currentAllowance < amountNeeded) {
    const approveTx = await tokenContract.approve(spenderAddress, amountNeeded);
    await approveTx.wait();
    console.log('   ✅ Approval confirmed');
  } else {
    console.log('   ✅ Already approved');
  }
}

async function wrapETH(signer: any, amount: bigint) {
  console.log('🔄 === WRAPPING ETH TO WETH ===');

  try {
    const wethContract = new Contract(
      TOKENS.WETH,
      ['function deposit() external payable', 'function balanceOf(address) view returns (uint256)'],
      signer,
    );

    console.log(`🔄 Wrapping ${ethers.formatEther(amount)} ETH to WETH...`);

    const tx = await wethContract.deposit({
      value: amount,
      gasLimit: 100000,
      maxFeePerGas: ethers.parseUnits('2', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
    });

    const receipt = await tx.wait();

    console.log(`✅ Wrap confirmed: ${receipt.hash}`);
    console.log(`⛽ Gas used: ${receipt.gasUsed.toString()}`);

    const wethBalance = await wethContract.balanceOf(signer.address);
    console.log(`💰 New WETH balance: ${ethers.formatEther(wethBalance)} WETH\n`);
  } catch (error) {
    console.error('❌ ETH wrapping failed:', error);
  }
}

async function unwrapWETH(signer: any, amount: bigint) {
  console.log('🔄 === UNWRAPPING WETH TO ETH ===');

  try {
    const wethContract = new Contract(
      TOKENS.WETH,
      ['function withdraw(uint256) external', 'function balanceOf(address) view returns (uint256)'],
      signer,
    );

    console.log(`🔄 Unwrapping ${ethers.formatEther(amount)} WETH to ETH...`);

    const tx = await wethContract.withdraw(amount, { gasLimit: 100000 });
    const receipt = await tx.wait();

    console.log(`✅ Unwrap confirmed: ${receipt.hash}`);
    console.log(`⛽ Gas used: ${receipt.gasUsed.toString()}`);

    const ethBalance = await signer.provider.getBalance(signer.address);
    console.log(`💰 New ETH balance: ${ethers.formatEther(ethBalance)} ETH\n`);
  } catch (error) {
    console.error('❌ WETH unwrapping failed:', error);
  }
}

// 🚀 Execute main function
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
