/**
 * Mint BEES on Base Sepolia (chain 84532) to a recipient address.
 *
 * !!! NOT EXECUTED AUTOMATICALLY — run only on explicit operator decision !!!
 *
 * Safety model (mirrors scripts/deploy.js):
 *   - fails closed: refuses any chain other than Base Sepolia (84532), both via
 *     the hardhat --network config AND a live eth_chainId check,
 *   - the signer key is read from contracts/.env (gitignored) at run time only,
 *   - the key is NEVER logged, echoed, persisted, or written to source,
 *   - only PUBLIC data is printed (chain id, deployer address, recipient,
 *     amount, tx hash).
 *
 * BEES.mint is owner-only; the DEPLOYER_PRIVATE_KEY holder is the BEES owner.
 *
 * Manual run:
 *   cd contracts && npm run mint:base-sepolia
 * (BASE_RPC_URL and DEPLOYER_PRIVATE_KEY are loaded from contracts/.env.)
 */

const path = require('node:path');
const hre = require('hardhat');
const { createWalletClient, createPublicClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { baseSepolia } = require('viem/chains');

// Load secrets from contracts/.env (gitignored). Idempotent: dotenv leaves any
// variable already present in the shell untouched. The key is read here only
// and is never logged, echoed, or written to source.
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const BASE_SEPOLIA_CHAIN_ID = 84532;

// --- Mint parameters (PUBLIC: on-chain addresses + a token amount) ----------
const BEES_ADDRESS = '0x43e67b33248e3262fe12d3ae826850936a2d1cd9'; // backend/.env BEES_TOKEN_ADDRESS
const RECIPIENT = '0xB340a31D33D361CC9809B3C8D26D03F088A2e20e'; // Account 2
const MINT_AMOUNT = 5000000000000000000n; // 5 BEES (18 decimals)

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        'Minting is a manual operator action; nothing is sent automatically.',
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

async function main() {
  if (hre.network.config.chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(
      `Refusing to mint: this script only targets Base Sepolia (${BASE_SEPOLIA_CHAIN_ID}), ` +
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

  // Defence-in-depth: prove BASE_RPC_URL actually points at Base Sepolia, not
  // some other network, before any broadcast.
  const liveChainId = await publicClient.getChainId();
  if (liveChainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(
      `Refusing to mint: BASE_RPC_URL points at chainId ${liveChainId}, ` +
        `expected Base Sepolia (${BASE_SEPOLIA_CHAIN_ID}).`,
    );
  }

  // Public-only log output — the key is never printed.
  console.log('Network  :', hre.network.name, `(chainId ${BASE_SEPOLIA_CHAIN_ID})`);
  console.log('BEES     :', BEES_ADDRESS);
  console.log('Deployer :', account.address);
  console.log('Recipient:', RECIPIENT);
  console.log('Amount   :', MINT_AMOUNT.toString(), 'base units (5 BEES, 18 decimals)');

  const beesArtifact = await hre.artifacts.readArtifact('BEES');

  const hash = await walletClient.writeContract({
    address: BEES_ADDRESS,
    abi: beesArtifact.abi,
    functionName: 'mint',
    args: [RECIPIENT, MINT_AMOUNT],
    chain: baseSepolia,
  });
  console.log('Tx sent  :', hash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status === 'reverted') {
    throw new Error(`Mint transaction reverted (tx ${hash}).`);
  }
  console.log('Confirmed:', receipt.transactionHash);
  console.log(`Minted 5 BEES to ${RECIPIENT} on Base Sepolia.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
