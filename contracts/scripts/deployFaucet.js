/**
 * Deploy + fund the Habitra BEES faucet on Base Sepolia (chain 84532).
 *
 * !!! NOT EXECUTED AUTOMATICALLY — run only on explicit operator decision !!!
 *
 * Safety model (mirrors scripts/deploy.js and scripts/mint.js):
 *   - fails closed: refuses any chain other than Base Sepolia (84532), both via
 *     the hardhat --network config AND a live eth_chainId check,
 *   - the signer key is read from contracts/.env (gitignored) at run time only,
 *   - the key is NEVER logged, echoed, persisted, or written to source,
 *   - only PUBLIC data is printed (chain id, deployer address, addresses,
 *     amounts, tx hashes).
 *
 * The faucet does NOT mint. It distributes BEES it already holds. Funding is
 * done here by the BEES owner (the DEPLOYER_PRIVATE_KEY holder) minting BEES
 * to the freshly-deployed faucet address — the same owner-only BEES.mint the
 * rest of the project uses. No frontend, no user, and no unlimited minting
 * path is created.
 *
 * Manual run:
 *   cd contracts && npm run deploy:faucet:base-sepolia
 * (BASE_RPC_URL and DEPLOYER_PRIVATE_KEY are loaded from contracts/.env.)
 *
 * After a successful run, copy the printed faucet address into backend/.env as
 * FAUCET_ADDRESS (a public address — not a secret).
 */

const path = require('node:path');
const hre = require('hardhat');
const { createWalletClient, createPublicClient, http, parseUnits } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { baseSepolia } = require('viem/chains');

// Load secrets from contracts/.env (gitignored). Idempotent.
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const BASE_SEPOLIA_CHAIN_ID = 84532;

// Existing deployed BEES token (backend/.env BEES_TOKEN_ADDRESS). Override with
// BEES_TOKEN_ADDRESS if the deployment ever changes.
const BEES_ADDRESS = process.env.BEES_TOKEN_ADDRESS || '0x43e67b33248e3262fe12d3ae826850936a2d1cd9';

// 10 BEES per claim (18 decimals). One claim per wallet.
const CLAIM_AMOUNT = parseUnits('10', 18);

// BEES to fund the faucet with — enough for the hackathon demo. Override via
// FAUCET_FUND_BEES (a whole number of BEES). 100 BEES = 10 claims of 10 BEES.
const FUND_BEES = parseUnits(process.env.FAUCET_FUND_BEES || '100', 18);

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
 * Normalize a key read from the environment so viem accepts it (strip quotes,
 * ensure 0x prefix). Never logged.
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

  // Defence-in-depth: prove BASE_RPC_URL actually points at Base Sepolia before
  // any broadcast.
  const liveChainId = await publicClient.getChainId();
  if (liveChainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(
      `Refusing to deploy: BASE_RPC_URL points at chainId ${liveChainId}, ` +
        `expected Base Sepolia (${BASE_SEPOLIA_CHAIN_ID}).`,
    );
  }

  // Public-only log output — the key is never printed.
  console.log('Network  :', hre.network.name, `(chainId ${BASE_SEPOLIA_CHAIN_ID})`);
  console.log('Deployer :', account.address);
  console.log('BEES     :', BEES_ADDRESS);
  console.log('Claim    :', CLAIM_AMOUNT.toString(), 'base units (10 BEES, 18 decimals)');

  const faucetAddress = await deployContract(
    walletClient,
    publicClient,
    'HabitraBeesFaucet',
    [BEES_ADDRESS, account.address, CLAIM_AMOUNT],
  );
  console.log('Faucet   :', faucetAddress);

  // Fund the faucet: the BEES owner mints BEES to the faucet address. This is
  // the same owner-only BEES.mint used elsewhere; the faucet never mints.
  const beesArtifact = await hre.artifacts.readArtifact('BEES');
  const fundHash = await walletClient.writeContract({
    address: BEES_ADDRESS,
    abi: beesArtifact.abi,
    functionName: 'mint',
    args: [faucetAddress, FUND_BEES],
    chain: baseSepolia,
  });
  console.log('Fund tx  :', fundHash);

  const fundReceipt = await publicClient.waitForTransactionReceipt({ hash: fundHash });
  if (fundReceipt.status === 'reverted') {
    throw new Error(`Faucet funding transaction reverted (tx ${fundHash}).`);
  }
  console.log('Funded   :', FUND_BEES.toString(), 'base units (100 BEES) confirmed:', fundReceipt.transactionHash);

  console.log('');
  console.log('Add to backend/.env (a public address — not a secret):');
  console.log(`FAUCET_ADDRESS=${faucetAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
