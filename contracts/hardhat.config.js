/**
 * Hardhat configuration for the Habitra on-chain layer.
 *
 * Scope: compile + test locally. Base Sepolia (84532) is declared as a network
 * so `scripts/deploy.js` can be reviewed, but NOTHING here deploys anything and
 * NO private key is ever stored in this file or anywhere else in the repo.
 *
 * The deploy script reads the deployer key from the environment only
 * (DEPLOYER_PRIVATE_KEY) and refuses to run without it.
 */
require('dotenv').config();
const BASE_SEPOLIA_CHAIN_ID = 84532;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: '0.8.28',
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  paths: {
    sources: './src',
    tests: './test',
    cache: './cache',
    artifacts: './artifacts',
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    baseSepolia: {
      chainId: BASE_SEPOLIA_CHAIN_ID,
      url: process.env.BASE_RPC_URL || '',
      // Empty when DEPLOYER_PRIVATE_KEY is unset: hardhat then simply has no
      // accounts to sign with, so any accidental deploy fails immediately.
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
};
