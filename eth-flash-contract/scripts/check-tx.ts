import { ethers } from 'hardhat';

async function main() {
  const txHash = '0xf741484489ad70bce5f0fc5a799d28658f38802119f5067c76649462e8cd7871';

  console.log('🔍 Checking transaction:', txHash);

  try {
    const receipt = await ethers.provider.getTransactionReceipt(txHash);

    if (receipt) {
      console.log('✅ Transaction found!');
      console.log('Status:', receipt.status === 1 ? 'SUCCESS' : 'FAILED');
      console.log('Block:', receipt.blockNumber);
      console.log('Gas Used:', receipt.gasUsed.toString());

      if (receipt.contractAddress) {
        console.log('🎉 CONTRACT DEPLOYED!');
        console.log('📍 Contract Address:', receipt.contractAddress);

        // Test the contract
        const code = await ethers.provider.getCode(receipt.contractAddress);
        console.log('✅ Code exists:', code !== '0x');

        if (code !== '0x') {
          const flashArbitrage = await ethers.getContractAt(
            'FlashArbitrage',
            receipt.contractAddress,
          );
          const owner = await flashArbitrage.owner();
          console.log('👤 Owner:', owner);
        }
      }
    } else {
      console.log('❌ Transaction not found');
    }
  } catch (error) {
    console.error('Error:', error.message);
  }
}

main().catch(console.error);
