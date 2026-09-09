/**
 * contracts/index.ts — typed entry point for the Base + BEES on-chain layer.
 *
 * This module is the *only* place the backend needs to know about contract ABIs
 * and deployed addresses. It is intentionally read-only and side-effect free:
 * importing it performs no network I/O, creates no viem client, signs nothing
 * and sends nothing.
 *
 * The ABIs are generated from `contracts/artifacts` by
 * `contracts/scripts/export-abis.js`; do not edit `abi.ts` by hand.
 *
 * NOTE: `src/services/blockchain.ts` was deliberately left unchanged — it
 * already exposes `beesTokenAddress` / `challengeContractAddress` through
 * `getBlockchainConfig()`, and `DEMO_CHAIN_MODE` still defaults to true, so no
 * existing behaviour (including the /api/blockchain/status response consumed by
 * the Wallet page) is affected by adding this module.
 */

import { getBlockchainConfig } from '../services/blockchain.js';
import { beesAbi, habitraChallengeEscrowAbi } from './abi.js';
import type { BeesAbi, HabitraChallengeEscrowAbi } from './abi.js';

export { beesAbi, habitraChallengeEscrowAbi };
export type { BeesAbi, HabitraChallengeEscrowAbi };

/** BEES uses 18 decimals, matching its Solidity `decimals()` override. */
export const BEES_DECIMALS = 18;

/** Base Sepolia — the only chain this layer targets. */
export const HABITRA_CHAIN_ID = 84532;

/** How a Habitra `Transaction.type` maps onto the escrow calls. */
export const ESCROW_TRANSACTION_TYPE = {
  lock: 'FUND',
  settleSuccess: 'CLAIM',
  settleFailure: 'PENALTY',
} as const;

export interface DeployedContracts {
  chainId: number;
  /** BEES ERC-20 address, or null when not deployed/configured. */
  beesTokenAddress: `0x${string}` | null;
  /** HabitraChallengeEscrow address, or null when not deployed/configured. */
  escrowAddress: `0x${string}` | null;
  /** True only when both addresses are configured. */
  ready: boolean;
}

/**
 * Deployed contract addresses for the configured chain. Both are null until an
 * operator deploys to Base Sepolia and sets BEES_TOKEN_ADDRESS /
 * CHALLENGE_CONTRACT_ADDRESS, so callers must handle `ready === false`.
 */
export function getDeployedContracts(): DeployedContracts {
  const config = getBlockchainConfig();
  const beesTokenAddress = config.beesTokenAddress;
  const escrowAddress = config.challengeContractAddress;

  return {
    chainId: config.chainId,
    beesTokenAddress,
    escrowAddress,
    ready: beesTokenAddress !== null && escrowAddress !== null,
  };
}
