/**
 * faucet.ts — server-side BEES distribution for the onboarding flow.
 *
 * A new user pastes a PUBLIC Base Sepolia address; this service has the faucet
 * owner (a server-side key, never the user's) call HabitraBeesFaucet.claimFor()
 * to send exactly 10 BEES from the faucet's already-funded supply to that
 * address. No user wallet signature is involved in RECEIVING BEES — signing
 * stays required later, when the user actually stakes (approval/lock flow).
 *
 * Safety:
 *  - The recipient address is validated (isAddress, not the zero address).
 *  - The on-chain hasClaimed[recipient] guard is checked BEFORE broadcasting, so
 *    the same address can never be funded twice (case/checksum variants map to
 *    the same address bytes, so they cannot bypass the guard either).
 *  - Only 10 BEES (claimAmount) is ever transferred; the contract reverts if it
 *    is empty. The owner key used here cannot mint BEES.
 *  - The signing key is read from the environment by getFaucetWalletClient(); it
 *    is never logged or exposed.
 */

import { getAddress, isAddress, type Address } from 'viem';

import { getFaucetWalletClient, getBlockchainConfig, getPublicClient } from './blockchain.js';
import { habitraBeesFaucetAbi } from '../contracts/abi.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

/** Thrown when the recipient has already been funded (idempotency guard). */
export class AlreadyClaimedError extends Error {
  constructor() {
    super('This address has already claimed BEES from the faucet.');
    this.name = 'AlreadyClaimedError';
  }
}

export interface FaucetClaimResult {
  txHash: string;
  amount: bigint;
  recipient: Address;
}

/**
 * Distribute 10 BEES from the faucet to `recipient` via the faucet owner's
 * server-side signature. Returns the confirmed transaction hash and amount.
 * Throws AlreadyClaimedError if the address was already funded, or a generic
 * Error for configuration/network/revert problems.
 */
export async function claimBeesTo(recipient: string): Promise<FaucetClaimResult> {
  const config = getBlockchainConfig();
  const faucetAddress = config.faucetAddress;
  const beesAddress = config.beesTokenAddress;

  if (!faucetAddress || !beesAddress) {
    throw new Error('The BEES faucet is not configured on the backend.');
  }
  if (!isAddress(recipient)) {
    throw new Error('Invalid wallet address.');
  }
  // Normalise to a checksum form for stable, consistent handling. The on-chain
  // hasClaimed guard keys on the raw bytes, so this is purely cosmetic.
  const to = getAddress(recipient);
  if (to.toLowerCase() === ZERO_ADDRESS) {
    throw new Error('Invalid wallet address.');
  }

  const publicClient = getPublicClient();
  const walletClient = getFaucetWalletClient();
  if (!publicClient || !walletClient) {
    throw new Error(
      'On-chain signing is unavailable (demo mode or missing faucet signer).',
    );
  }

  // Pre-flight: has this address already claimed? Surfaces a clean, retry-safe
  // error instead of broadcasting a tx that would revert.
  const alreadyClaimed = await publicClient.readContract({
    address: faucetAddress,
    abi: habitraBeesFaucetAbi,
    functionName: 'hasClaimed',
    args: [to],
  });
  if (alreadyClaimed) {
    throw new AlreadyClaimedError();
  }

  // Simulate first so a revert (FaucetEmpty / AlreadyClaimed / ZeroAddress) is
  // caught before any gas is spent.
  const { request } = await publicClient.simulateContract({
    account: walletClient.account,
    address: faucetAddress,
    abi: habitraBeesFaucetAbi,
    functionName: 'claimFor',
    args: [to],
  });

  const hash = await walletClient.writeContract(request);

  // Wait for a couple of confirmations before reporting success. The RPC sits
  // behind a load balancer, so a read issued immediately after the first receipt
  // can still observe pre-transaction state (balance/hasClaimed). Waiting here
  // keeps the value this endpoint returns consistent with what a client reads
  // straight afterwards.
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });

  if (receipt.status !== 'success') {
    throw new Error('The BEES claim transaction reverted on-chain.');
  }

  return { txHash: hash, amount: await claimAmountOf(faucetAddress, publicClient), recipient: to };
}

/** Read the faucet's configured per-claim amount (10 BEES, 18 decimals). */
async function claimAmountOf(
  faucetAddress: `0x${string}`,
  publicClient: ReturnType<typeof getPublicClient>,
): Promise<bigint> {
  if (!publicClient) return 0n;
  return publicClient.readContract({
    address: faucetAddress,
    abi: habitraBeesFaucetAbi,
    functionName: 'claimAmount',
  }) as Promise<bigint>;
}
