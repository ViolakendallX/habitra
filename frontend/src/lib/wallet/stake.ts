/**
 * stake.ts — Phase 3: the two on-chain writes of the real BEES staking flow.
 *
 *   BEES.approve(escrow, amount)   then   Escrow.lock(challengeId, amount, endsAt)
 *
 * SECURITY BOUNDARY (do not break this)
 * -------------------------------------
 * No private key, seed phrase or signing secret is ever created, imported,
 * stored or transmitted here. Both writes go through
 * `createBrowserWalletClient(account)`, which is viem's `custom(window.ethereum)`
 * transport: viem only *asks* the wallet extension to sign and receives the
 * transaction hash back. The key never leaves the user's wallet.
 *
 * Both calls are simulated before they are sent, so a revert (insufficient
 * allowance, a challenge id that is already locked, an end date in the past)
 * is reported to the user before any gas is spent.
 *
 * The existing ABIs (lib/contracts/abi.ts) are reused as-is and are NOT
 * modified. Nothing here decides pass/fail, settles a challenge, mints BEES or
 * duplicates backend logic — the backend remains the only source of truth for
 * the verdict, and it re-verifies the lock on-chain in
 * `POST /api/challenges/:id/escrow/confirm`.
 */

import { isAddress, parseUnits, type Address, type Hash } from 'viem';

import { beesAbi, habitraChallengeEscrowAbi } from '../contracts/abi';
import { BEES_DECIMALS } from './bees';
import { createBrowserPublicClient, createBrowserWalletClient } from './injectedWallet';

/** Default stake: 5 BEES expressed in 18-decimal base units. */
export const DEFAULT_STAKE_BASE_UNITS: bigint = parseUnits('5', BEES_DECIMALS);

/** The same amount as the string the backend expects in the stake payload. */
export const DEFAULT_STAKE_BASE_UNITS_TEXT: string = DEFAULT_STAKE_BASE_UNITS.toString();

/** Human-facing label so the UI never has to re-derive the amount. */
export const DEFAULT_STAKE_LABEL = '5 BEES';

type BrowserPublicClient = NonNullable<ReturnType<typeof createBrowserPublicClient>>;

/** Narrows a configured contract address, failing loudly when it is missing. */
function requireAddress(value: string | null | undefined, message: string): Address {
  if (!value || !isAddress(value)) {
    throw new Error(message);
  }
  return value;
}

/**
 * Wait for a transaction the user just signed and throw if it reverted, so a
 * reverted write is never reported as success.
 */
async function waitForSuccess(
  client: BrowserPublicClient,
  hash: Hash,
  label: string,
): Promise<void> {
  const receipt = await client.waitForTransactionReceipt({ hash });

  if (receipt.status !== 'success') {
    throw new Error(`${label} transaction reverted on-chain (${hash}).`);
  }
}

/**
 * Read how much BEES `owner` has already approved `spender` to move.
 *
 * Used so a retry after a failed lock does not ask the user to sign a second,
 * unnecessary approval: an approval that is still large enough is reused.
 */
export async function readBeesAllowance(
  tokenAddress: string,
  owner: Address,
  spender: string,
): Promise<bigint> {
  const token = requireAddress(tokenAddress, 'BEES token address is not configured.');
  const target = requireAddress(spender, 'Escrow contract address is not configured.');

  const client = createBrowserPublicClient();
  if (!client) {
    throw new Error('No browser wallet is available to read the BEES allowance.');
  }

  return client.readContract({
    address: token,
    abi: beesAbi,
    functionName: 'allowance',
    args: [owner, target],
  });
}

export interface ApproveBeesInput {
  tokenAddress: string;
  /** The escrow contract that will pull the BEES. */
  spender: string;
  account: Address;
  amount: bigint;
}

/**
 * Simulate, then send, then confirm `BEES.approve(spender, amount)`.
 *
 * Resolves with the approval transaction hash once its receipt shows success.
 * Throws if the user rejects the prompt (EIP-1193 4001) or the call reverts.
 */
export async function approveBees(input: ApproveBeesInput): Promise<Hash> {
  const token = requireAddress(input.tokenAddress, 'BEES token address is not configured.');
  const spender = requireAddress(input.spender, 'Escrow contract address is not configured.');

  const publicClient = createBrowserPublicClient();
  const walletClient = createBrowserWalletClient(input.account);

  if (!publicClient || !walletClient) {
    throw new Error('No browser wallet is available to send the approval transaction.');
  }

  const { request } = await publicClient.simulateContract({
    account: input.account,
    address: token,
    abi: beesAbi,
    functionName: 'approve',
    args: [spender, input.amount],
  });

  const hash = await walletClient.writeContract(request);
  await waitForSuccess(publicClient, hash, 'BEES approval');

  return hash;
}

export interface LockStakeInput {
  escrowAddress: string;
  account: Address;
  /** The Habitra challenge id — the backend matches this in the lock event. */
  challengeId: string;
  amount: bigint;
  /** Lock release time, unix seconds. Must match the challenge end date. */
  endsAt: number;
}

/**
 * Simulate, then send, then confirm `Escrow.lock(challengeId, amount, endsAt)`.
 *
 * Resolves with the lock transaction hash once its receipt shows success. The
 * hash is what the backend independently verifies in the escrow confirmation
 * endpoint; it is never fabricated here.
 */
export async function lockStake(input: LockStakeInput): Promise<Hash> {
  const escrow = requireAddress(input.escrowAddress, 'Escrow contract address is not configured.');

  const publicClient = createBrowserPublicClient();
  const walletClient = createBrowserWalletClient(input.account);

  if (!publicClient || !walletClient) {
    throw new Error('No browser wallet is available to send the lock transaction.');
  }

  const { request } = await publicClient.simulateContract({
    account: input.account,
    address: escrow,
    abi: habitraChallengeEscrowAbi,
    functionName: 'lock',
    args: [input.challengeId, input.amount, BigInt(input.endsAt)],
  });

  const hash = await walletClient.writeContract(request);
  await waitForSuccess(publicClient, hash, 'Stake lock');

  return hash;
}
