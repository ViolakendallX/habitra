/**
 * blockchainPersistence.ts — minimal persistence helpers for the Base + BEES
 * wallet / transaction flow (PRD §19, §21, §22).
 *
 * This module ONLY reads/writes the Wallet and Transaction tables. It performs
 * NO on-chain calls, connects NO real wallet, and NEVER handles secrets: only a
 * user's public EVM address is accepted or stored. All EVM addresses are
 * validated (and checksummed) with viem; chain ids are restricted to the
 * supported set, currently Base Sepolia (84532).
 *
 * Every write/lookup is scoped by the caller-supplied `userId` so a user can
 * only ever touch their own wallet and transaction rows.
 */

import { getAddress, isAddress } from 'viem';
import type { Transaction, Wallet } from '../generated/prisma/client.js';
import { prisma } from '../db/prisma.js';

/** Base Sepolia is the current demo / default chain for Habitra. */
export const DEFAULT_CHAIN_ID = 84532;

/** Chains this build will accept. Extend here when mainnet/testnets are added. */
export const SUPPORTED_CHAIN_IDS = [DEFAULT_CHAIN_ID] as const;

export type TransactionType = 'FUND' | 'CLAIM' | 'PENALTY';
export type TransactionStatus = 'PENDING' | 'CONFIRMED' | 'FAILED';

export interface ConnectWalletInput {
  userId: string;
  /** Public EVM address. Never a private key / seed / password. */
  address: string;
  /** Optional explicit chain id; defaults to DEFAULT_CHAIN_ID. */
  chainId?: number;
}

export interface CreateTransactionInput {
  userId: string;
  /** Wallet that owns/signs this transaction. Must belong to `userId`. */
  walletId: string;
  type: TransactionType;
  /** Optional link to the challenge this transaction funds or rewards. */
  challengeId?: string | null;
  chainId?: number;
  /** Token amount in base units, as a non-negative integer string. */
  amount?: string | null;
  /** ERC-20 token address the amount refers to (e.g. BEES). */
  tokenAddress?: string | null;
}

export interface UpdateTransactionInput {
  userId: string;
  transactionId: string;
  status: TransactionStatus;
  /** On-chain hash once broadcast. Optional; null clears it. */
  txHash?: string | null;
}

export interface TransactionHistoryQuery {
  walletId?: string;
  challengeId?: string;
  type?: TransactionType;
  status?: TransactionStatus;
  limit?: number;
  offset?: number;
}

export interface WalletRecord {
  id: string;
  userId: string;
  address: string;
  chainId: number;
  createdAt: string;
  updatedAt: string;
}

export interface TransactionRecord {
  id: string;
  userId: string;
  walletId: string;
  challengeId: string | null;
  type: TransactionType;
  status: TransactionStatus;
  txHash: string | null;
  chainId: number;
  /** Token amount in base units, as a string (BigInt is not JSON-safe). */
  amount: string | null;
  tokenAddress: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Thrown for invalid input or ownership/authorization failures. */
export class BlockchainPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockchainPersistenceError';
  }
}

const VALID_TYPES: readonly TransactionType[] = ['FUND', 'CLAIM', 'PENALTY'];
const VALID_STATUSES: readonly TransactionStatus[] = ['PENDING', 'CONFIRMED', 'FAILED'];

function assertSupportedChain(chainId: number): void {
  if (!(SUPPORTED_CHAIN_IDS as readonly number[]).includes(chainId)) {
    throw new BlockchainPersistenceError(
      `Unsupported chainId: ${chainId}. Supported: ${SUPPORTED_CHAIN_IDS.join(', ')}`,
    );
  }
}

function requireTransactionType(type: string): TransactionType {
  if (!(VALID_TYPES as readonly string[]).includes(type)) {
    throw new BlockchainPersistenceError(
      `Invalid transaction type: ${type}. Expected one of: ${VALID_TYPES.join(', ')}`,
    );
  }
  return type as TransactionType;
}

function requireTransactionStatus(status: string): TransactionStatus {
  if (!(VALID_STATUSES as readonly string[]).includes(status)) {
    throw new BlockchainPersistenceError(
      `Invalid transaction status: ${status}. Expected one of: ${VALID_STATUSES.join(', ')}`,
    );
  }
  return status as TransactionStatus;
}

/** Parse a base-units amount string into a BigInt. Throws on non-integer input. */
function parseBaseUnitsAmount(value: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new BlockchainPersistenceError(
      `Invalid amount: ${value}. Must be a non-negative integer in base units.`,
    );
  }
  return BigInt(trimmed);
}

function toWalletRecord(w: Wallet): WalletRecord {
  return {
    id: w.id,
    userId: w.userId,
    address: w.address,
    chainId: w.chainId,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}

function toTransactionRecord(t: Transaction): TransactionRecord {
  return {
    id: t.id,
    userId: t.userId,
    walletId: t.walletId,
    challengeId: t.challengeId,
    type: t.type as TransactionType,
    status: t.status as TransactionStatus,
    txHash: t.txHash,
    chainId: t.chainId,
    amount: t.amount != null ? t.amount.toString() : null,
    tokenAddress: t.tokenAddress,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/**
 * Save/connect a user's public wallet address for a chain. Idempotent: if the
 * same (address, chainId) is already linked to this user, the existing record is
 * returned. If it is linked to a different user, an error is thrown — an address
 * cannot be owned by two users. The address is checksummed before storage.
 */
export async function connectWallet(input: ConnectWalletInput): Promise<WalletRecord> {
  const chainId = input.chainId ?? DEFAULT_CHAIN_ID;
  assertSupportedChain(chainId);

  if (!isAddress(input.address)) {
    throw new BlockchainPersistenceError(`Invalid EVM address: ${input.address}`);
  }
  const checksumAddress = getAddress(input.address);

  const existing = await prisma.wallet.findFirst({
    where: { address: checksumAddress, chainId },
  });

  if (existing) {
    if (existing.userId !== input.userId) {
      throw new BlockchainPersistenceError(
        'This wallet address is already linked to a different user.',
      );
    }
    return toWalletRecord(existing);
  }

  const created = await prisma.wallet.create({
    data: {
      userId: input.userId,
      address: checksumAddress,
      chainId,
    },
  });
  return toWalletRecord(created);
}

/**
 * Retrieve the user's wallet for a specific chain, or null if none is connected.
 * Scoped strictly to `userId`.
 */
export async function getUserWalletForChain(
  userId: string,
  chainId: number = DEFAULT_CHAIN_ID,
): Promise<WalletRecord | null> {
  assertSupportedChain(chainId);
  const wallet = await prisma.wallet.findFirst({
    where: { userId, chainId },
  });
  return wallet ? toWalletRecord(wallet) : null;
}

/**
 * Create a PENDING transaction record tied to a user's wallet. Validates the type,
 * chain, amount, and token address, and enforces that `walletId` belongs to
 * `userId` before writing.
 */
export async function createPendingTransaction(
  input: CreateTransactionInput,
): Promise<TransactionRecord> {
  const chainId = input.chainId ?? DEFAULT_CHAIN_ID;
  assertSupportedChain(chainId);
  const type = requireTransactionType(input.type);

  const wallet = await prisma.wallet.findFirst({
    where: { id: input.walletId, userId: input.userId },
    select: { id: true },
  });
  if (!wallet) {
    throw new BlockchainPersistenceError('Wallet not found or not owned by user.');
  }

  const amount = input.amount != null ? parseBaseUnitsAmount(input.amount) : null;
  if (input.tokenAddress != null && !isAddress(input.tokenAddress)) {
    throw new BlockchainPersistenceError(`Invalid token address: ${input.tokenAddress}`);
  }

  const tx = await prisma.transaction.create({
    data: {
      userId: input.userId,
      walletId: input.walletId,
      challengeId: input.challengeId ?? null,
      type,
      status: 'PENDING',
      chainId,
      amount,
      tokenAddress: input.tokenAddress ?? null,
      txHash: null,
    },
  });
  return toTransactionRecord(tx);
}

/**
 * Update a transaction's status and (optionally) its on-chain hash. Scoped to
 * `userId`; attempting to update another user's transaction throws.
 */
export async function updateTransaction(
  input: UpdateTransactionInput,
): Promise<TransactionRecord> {
  const status = requireTransactionStatus(input.status);

  if (input.txHash != null && input.txHash.length > 0 && !input.txHash.startsWith('0x')) {
    throw new BlockchainPersistenceError('txHash must start with 0x.');
  }

  const existing = await prisma.transaction.findFirst({
    where: { id: input.transactionId, userId: input.userId },
    select: { id: true },
  });
  if (!existing) {
    throw new BlockchainPersistenceError('Transaction not found or not owned by user.');
  }

  const updated = await prisma.transaction.update({
    where: { id: input.transactionId },
    data: {
      status,
      ...(input.txHash !== undefined ? { txHash: input.txHash } : {}),
    },
  });
  return toTransactionRecord(updated);
}

/**
 * Retrieve a user's transaction history, newest first, optionally filtered.
 * Always scoped to `userId`.
 */
export async function getUserTransactionHistory(
  userId: string,
  query: TransactionHistoryQuery = {},
): Promise<TransactionRecord[]> {
  const txs = await prisma.transaction.findMany({
    where: {
      userId,
      ...(query.walletId ? { walletId: query.walletId } : {}),
      ...(query.challengeId ? { challengeId: query.challengeId } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: query.limit ?? 50,
    skip: query.offset ?? 0,
  });
  return txs.map(toTransactionRecord);
}
