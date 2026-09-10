/**
 * bees.ts — read-only BEES helpers for the browser wallet (Phase 2).
 *
 * Uses the EXISTING frontend ABI (lib/contracts/abi.ts) unchanged. The BEES
 * token address is always passed in by the caller, which sources it from
 * GET /api/blockchain/status — it is never hardcoded here.
 *
 * Read-only: `balanceOf` only. No approve, no transfer, no mint, no
 * transaction of any kind is constructed or broadcast.
 */

import { isAddress, formatUnits, type Address } from 'viem';

import { beesAbi } from '../contracts/abi';
import { createBrowserPublicClient } from './injectedWallet';

/** Mirrors BEES.decimals() and the backend's BEES_DECIMALS. */
export const BEES_DECIMALS = 18;

/**
 * Read `balanceOf(account)` from the BEES contract.
 *
 * @param tokenAddress BEES contract address, taken from the backend's
 *                     blockchain status. Throws when it is missing/invalid so
 *                     the UI can say "not configured" rather than fail oddly.
 * @param account      Address to query.
 * @returns Balance in BEES base units (1 BEES = 1e18).
 */
export async function readBeesBalance(
  tokenAddress: string,
  account: Address,
): Promise<bigint> {
  if (!isAddress(tokenAddress)) {
    throw new Error('BEES token address is not configured.');
  }

  const client = createBrowserPublicClient();
  if (!client) {
    throw new Error('No browser wallet available to read the balance.');
  }

  return client.readContract({
    address: tokenAddress,
    abi: beesAbi,
    functionName: 'balanceOf',
    args: [account],
  });
}

/** Format BEES base units for display (BigInt-safe; never uses Number). */
export function formatBeesAmount(baseUnits: bigint): string {
  return formatUnits(baseUnits, BEES_DECIMALS);
}
