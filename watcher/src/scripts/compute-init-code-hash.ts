const { ethers } = require('ethers');
import path from 'path';

// full creation bytecode (get from Etherscan > Contract > Contract Creation Code)
// example for Uniswap V2: https://etherscan.io/address/0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f#code
// read bytecode from bytecode.txt file
const file = Bun.file(path.join(__dirname, 'bytecode.txt'));
let pairBytecode = await file.text();
pairBytecode = pairBytecode.trim();

// const initCodeHash = ethers.keccak256(pairBytecode);
// console.log('Init Code Hash:', initCodeHash);

// Convert hex string to Uint8Array bytes, then hash
const initCodeHash = ethers.keccak256(ethers.getBytes(pairBytecode));
console.log('Init Code Hash:', initCodeHash);
