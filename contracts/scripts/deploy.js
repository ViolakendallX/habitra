/**
 * Deployment script for Base Sepolia (chain 84532).
 *
 * !!! NOT EXECUTED — DO NOT RUN AS PART OF ANY BUILD OR TEST STEP !!!
 *
 * This script is committed for review only, so the deployment path is explicit
 * and auditable. It is intentionally written to fail closed:
 *   - it refuses to run on any chain other than Base Sepolia (84532),
 *   - it refuses to run without BASE_RPC_URL / DEPLOYER_PRIVATE_KEY in the
 *     environment (the key is read from the environment at run time only),
 *   - it NEVER hardcodes, persists, logs or echoes a private key.
 *
 * The deployer key may be stored WITH or WITHOUT a `0x` prefix; deploy.js
 * normalizes it before handing it to viem.
 *
 * Manual run (only when an operator explicitly decides to deploy):
 *   BASE_RPC_URL=https://sepolia.base.org \
 *   DEPLOYER_PRIVATE_KEY=<throwaway testnet key> \
 *   TREASURY_ADDRESS=0x... \
 *   npm run deploy:base-sepolia
 *
 * After a successful run, copy the printed addresses into backend/.env as
 * BEES_TOKEN_ADDRESS and CHALLENGE_CONTRACT_ADDRESS.
 *
 * This project is CommonJS and uses viem (already a project dependency).
 */

const path = require('node:path');
const hre = require('hardhat');
const { createWalletClient, createPublicClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { baseSepolia } = require('viem/chains');

// Load deployment secrets from contracts/.env (gitignored). This is idempotent:
// if the variable is already in the environment (exported in the shell or loaded
// by hardhat.config.js) dotenv leaves it untouched. This makes the deploy path
// self-sufficient regardless of how the script is invoked. The key is read here
// only; it is NEVER logged, echoed, or written to source.
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const BASE_SEPOLIA_CHAIN_ID = 84532;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        'Deployment is a manual operator action; nothing is deployed automatically.',
    );
  }
  return value;
}

/**
 * Normalize a private key read from the environment so viem accepts it:
 *   - strip surrounding whitespace and quote characters,
 *   - ensure a `0x` prefix (viem needs `0x` + 64 hex, or a 32-byte Uint8Array).
 * A bare 64-character hex string (no `0x`) is what currently trips viem's
 * "expected hex or 32 bytes, got string" error. The value is never logged.
 */
function normalizePrivateKey(raw) {
  const k = String(raw).trim().replace(/^["']|["']$/g, '');
  return k.startsWith('0x') ? k : `0x${k}`;
}

async function deployContract(walletClient, publicClient, name, args) {
  const { abi, bytecode } = await hre.artifacts.readArtifact(name);
  const hash = await walletClient.deployContract({ abi, bytecode, args, chain: baseSepolia });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) {
    throw new Error(`${name} deployment produced no contract address (tx ${hash})`);
  }
  return receipt.contractAddress;
}

async function main() {
  if (hre.network.config.chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(
      `Refusing to deploy: this script only targets Base Sepolia (${BASE_SEPOLIA_CHAIN_ID}), ` +
        `got chainId ${hre.network.config.chainId}.`,
    );
  }

  const rpcUrl = requireEnv('BASE_RPC_URL');
  const treasury = requireEnv('TREASURY_ADDRESS');
  // Normalize so a key stored with or without a `0x` prefix both work.
  const deployerKey = normalizePrivateKey(requireEnv('DEPLOYER_PRIVATE_KEY'));
  if (!/^0x[0-9a-fA-F]{64}$/.test(deployerKey)) {
    throw new Error(
      'DEPLOYER_PRIVATE_KEY is not a valid private key. It must be a ' +
        '64-character hex string (optionally 0x-prefixed).',
    );
  }
  const account = privateKeyToAccount(deployerKey);

  const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });

  // Defence-in-depth: the check above only proves the operator passed
  // `--network baseSepolia`. It does NOT prove BASE_RPC_URL points at the right
  // chain — a misconfigured RPC (e.g. Base mainnet) would otherwise broadcast
  // real funds to the wrong network. Refuse unless the live chain reports 84532.
  const liveChainId = await publicClient.getChainId();
  if (liveChainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(
      `Refusing to deploy: BASE_RPC_URL points at chainId ${liveChainId}, ` +
        `expected Base Sepolia (${BASE_SEPOLIA_CHAIN_ID}).`,
    );
  }

  console.log('Network  :', hre.network.name, `(chainId ${BASE_SEPOLIA_CHAIN_ID})`);
  console.log('Deployer :', account.address);
  console.log('Treasury :', treasury);

  const beesAddress = await deployContract(walletClient, publicClient, 'BEES', [account.address]);
  console.log('BEES     :', beesAddress);

  const escrowAddress = await deployContract(
    walletClient,
    publicClient,
    'HabitraChallengeEscrow',
    [beesAddress, treasury, account.address],
  );
  console.log('Escrow   :', escrowAddress);

  console.log('');
  console.log('Add to backend/.env (never commit that file):');
  console.log(`BEES_TOKEN_ADDRESS=${beesAddress}`);
  console.log(`CHALLENGE_CONTRACT_ADDRESS=${escrowAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
