/**
 * blockchain.ts — Base + BEES foundation (Step 1 of Base + BEES).
 *
 * Minimal, dependency-light skeleton. It performs NO network I/O on import,
 * deploys/reads NO contracts, and handles NO wallets. It exists to be the single
 * entry point that later steps build on:
 *   - typed access to the Base/BEES environment configuration,
 *   - a viem `PublicClient` for Base Sepolia when the backend is "properly
 *     configured" (DEMO_CHAIN_MODE=false and a usable RPC/chain id), and
 *   - a clearly-labeled DEMO_CHAIN_MODE stub for local/offline development.
 *
 * Deliberately out of scope for this step (added in later approved steps):
 *   wallet connection, contract read/write, reward/penalty execution,
 *   /api/wallet + /api/blockchain routes, Prisma Wallet/Transaction models,
 *   and any frontend UI. Virtuals is untouched.
 */

import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { env } from '../config/env.js';

const BASE_SEPOLIA_CHAIN_ID = 84532;

export interface BlockchainConfig {
  demoMode: boolean;
  chainId: number;
  rpcUrl: string | null;
  beesTokenAddress: `0x${string}` | null;
  challengeContractAddress: `0x${string}` | null;
}

export type BlockchainMode = 'demo' | 'live' | 'unconfigured';

export interface BlockchainStatus {
  mode: BlockchainMode;
  chainId: number;
  rpcUrl: string | null;
  beesTokenAddress: `0x${string}` | null;
  challengeContractAddress: `0x${string}` | null;
  note: string;
}

/** Typed view of the Base/BEES environment configuration. Safe to call anytime. */
export function getBlockchainConfig(): BlockchainConfig {
  return {
    demoMode: env.demoChainMode,
    chainId: env.baseChainId,
    rpcUrl: env.baseRpcUrl || null,
    beesTokenAddress: env.beesTokenAddress
      ? (env.beesTokenAddress as `0x${string}`)
      : null,
    challengeContractAddress: env.challengeContractAddress
      ? (env.challengeContractAddress as `0x${string}`)
      : null,
  };
}

/** True when DEMO_CHAIN_MODE is active (off-chain/mock reward behavior). */
export function isDemoMode(): boolean {
  return env.demoChainMode;
}

/**
 * Returns a viem PublicClient for Base Sepolia when the backend is properly
 * configured; otherwise returns null:
 *   - DEMO_CHAIN_MODE=true  -> null + a clearly-labeled demo-mode notice
 *   - no RPC URL configured -> null + an unconfigured notice
 *   - otherwise             -> a real Base Sepolia public client
 * The client is created lazily (on call), never at import time, so importing
 * this module is always side-effect free.
 */
export function getPublicClient() {
  if (env.demoChainMode) {
    console.warn(
      '[blockchain] DEMO_CHAIN_MODE=true — on-chain client is STUBBED. ' +
        'Reward/penalty flows must use off-chain/mock behavior.',
    );
    return null;
  }
  if (!env.baseRpcUrl) {
    console.warn(
      '[blockchain] BASE_RPC_URL is not set — no on-chain client available. ' +
        'Set BASE_RPC_URL and DEMO_CHAIN_MODE=false to enable Base Sepolia.',
    );
    return null;
  }
  if (env.baseChainId !== BASE_SEPOLIA_CHAIN_ID) {
    console.warn(
      `[blockchain] BASE_CHAIN_ID=${env.baseChainId} is not Base Sepolia ` +
        `(${BASE_SEPOLIA_CHAIN_ID}); using the Base Sepolia chain definition. ` +
        'Set BASE_CHAIN_ID=84532 to target Base Sepolia.',
    );
  }
  return createPublicClient({
    chain: baseSepolia,
    transport: http(env.baseRpcUrl),
  });
}

/**
 * Returns a viem WalletClient for Base Sepolia when the backend is properly
 * configured AND a resolver signer key is present in the environment; otherwise
 * returns null:
 *   - DEMO_CHAIN_MODE=true        -> null (on-chain writes are never attempted)
 *   - no RPC URL configured       -> null
 *   - no ESCROW_RESOLVER_PRIVATE_KEY -> null
 *
 * This is the ONE place a signing client is constructed, so callers (e.g.
 * services/challengeEscrow.ts) never create a second blockchain client. The key
 * comes only from the environment at run time; it is never logged, never
 * persisted and never exposed to a client — the warnings below deliberately do
 * not mention whether a key exists beyond "missing".
 */
export function getWalletClient() {
  if (env.demoChainMode) {
    console.warn(
      '[blockchain] DEMO_CHAIN_MODE=true — no signing client is created. ' +
        'Escrow operations must use simulated/demo records.',
    );
    return null;
  }
  if (!env.baseRpcUrl) {
    console.warn(
      '[blockchain] BASE_RPC_URL is not set — no signing client available. ' +
        'Set BASE_RPC_URL and DEMO_CHAIN_MODE=false to enable Base Sepolia.',
    );
    return null;
  }
  if (!env.escrowResolverPrivateKey) {
    console.warn(
      '[blockchain] ESCROW_RESOLVER_PRIVATE_KEY is not set — no signing client ' +
        'available, so on-chain settlement cannot be performed.',
    );
    return null;
  }

  try {
    return createWalletClient({
      account: privateKeyToAccount(env.escrowResolverPrivateKey as `0x${string}`),
      chain: baseSepolia,
      transport: http(env.baseRpcUrl),
    });
  } catch {
    // Never echo the key or the parse error (it can contain key material).
    console.warn(
      '[blockchain] ESCROW_RESOLVER_PRIVATE_KEY is not a usable EVM private key — ' +
        'no signing client available.',
    );
    return null;
  }
}

/**
 * Human-readable status used by diagnostics/health and as the "clearly labeled"
 * demo-mode stub. Pure: performs no network I/O.
 */
export function getBlockchainStatus(): BlockchainStatus {
  const config = getBlockchainConfig();
  if (env.demoChainMode) {
    return {
      mode: 'demo',
      chainId: config.chainId,
      rpcUrl: config.rpcUrl,
      beesTokenAddress: null,
      challengeContractAddress: null,
      note:
        'DEMO_CHAIN_MODE is ON. No on-chain calls are made; BEES reward/penalty ' +
        'logic is stubbed for local development.',
    };
  }
  if (!env.baseRpcUrl) {
    return {
      mode: 'unconfigured',
      chainId: config.chainId,
      rpcUrl: null,
      beesTokenAddress: config.beesTokenAddress,
      challengeContractAddress: config.challengeContractAddress,
      note: 'On-chain mode selected but BASE_RPC_URL is missing.',
    };
  }
  return {
    mode: 'live',
    chainId: config.chainId,
    rpcUrl: config.rpcUrl,
    beesTokenAddress: config.beesTokenAddress,
    challengeContractAddress: config.challengeContractAddress,
    note: 'Connected to Base Sepolia via a viem PublicClient.',
  };
}
