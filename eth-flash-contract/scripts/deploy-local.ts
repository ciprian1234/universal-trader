const { ethers } = require('hardhat');

async function main() {
  // NOTE: use account[0] for contract deployment
  // NOTE: use account[1] for swaps
  const [_, deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const balance = await deployer.provider.getBalance(deployer.address);
  const balanceETH = ethers.formatEther(balance);

  // Get current base fee and set appropriate fees
  const block = await ethers.provider.getBlock('latest');
  const baseFee = block.baseFeePerGas;

  // Set fees well above current base fee
  const maxPriorityFeePerGas = ethers.parseUnits('0.01', 'gwei');
  const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas; // 2x base fee + tip

  console.log('🚀 Deploying FlashArbitrage contract...');
  console.log('🌐 Network:', network.name);
  console.log('🔗 Chain ID:', network.chainId.toString());
  console.log('📝 Deployer address:', deployer.address);
  console.log(`💰 Deployer balance: ${balanceETH} ETH`);
  console.log('⛽ Current base fee:', ethers.formatUnits(baseFee, 'gwei'), 'gwei');
  console.log('⛽ Max fee per gas:', ethers.formatUnits(maxFeePerGas, 'gwei'), 'gwei');
  console.log('⛽ Max priority fee:', ethers.formatUnits(maxPriorityFeePerGas, 'gwei'), 'gwei');

  // Deploy the contract
  console.log('📦 Deploying contract...');
  const FlashArbitrage = await ethers.getContractFactory('FlashArbitrage');
  const flashArbitrage = await FlashArbitrage.deploy({
    maxFeePerGas,
    maxPriorityFeePerGas,
    gasLimit: 3_000_000, // curently required ~2.1M gas
  });

  // wait for deployment
  await flashArbitrage.waitForDeployment();

  const contractAddress = await flashArbitrage.getAddress();
  console.log('✅ FlashArbitrage contract deployed to:', contractAddress);
  console.log('👤 Owner:', await flashArbitrage.owner());

  // Verify deployment
  const code = await ethers.provider.getCode(contractAddress);
  console.log('📋 Contract code length:', code.length);

  // gas used
  const receipt = await ethers.provider.getTransactionReceipt(flashArbitrage.deploymentTransaction().hash);
  console.log('⛽ Gas used for deployment:', receipt.gasUsed.toString());
  // get balance after deployment
  const finalBalance = await deployer.provider.getBalance(deployer.address);
  const finalBalanceETH = ethers.formatEther(finalBalance);
  console.log(`💰 Deployer final balance: ${finalBalanceETH} ETH`);
  console.log(`💸 Deployment cost: ${balanceETH - finalBalanceETH} ETH`);

  return flashArbitrage;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Deployment failed:', error);
    process.exit(1);
  });
