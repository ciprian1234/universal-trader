import { ethers } from 'ethers';

// create random private key
const privateKey = ethers.Wallet.createRandom().privateKey;
const wallet = new ethers.Wallet(privateKey);
console.log('Generated Wallet Address:', wallet.address);
console.log('Generated Private Key:', wallet.privateKey);
