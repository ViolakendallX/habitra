/**
 * challengeEscrow.ts — integration boundary between Habitra's off-chain
 * challenge evaluator and the on-chain BEES challenge escrow.
 *
 * ARCHITECTURE RULE (do not break this)
 * -------------------------------------
 * `services/challenges.ts` is the ONLY source of truth for whether a challenge
 * passed or failed. It reads habit completions and derives COMPLETED / FAILED.
 * This service NEVER decides the verdict — it only enforces the *economic
 * consequence* of a verdict the evaluator already reached:
 *
 *   evaluator says COMPLETED -> settle(succeeded = true)  -> stake returned   (CLAIM)
 *   evaluator says FAILED    -> settle(succeeded = false) -> stake slashed    (PENALTY)
 *
 * The smart contract never reads Habitra's database, and Habitra's database is
 * never used to invent a verdict.
 *
 * MODES
 * -----
 * DEMO_CHAIN_MODE=true (default): no RPC call, no signing, no transaction is
 *   ever broadcast. The same business conditions as the live path are validated
 *   (owned challenge, terminal status, linked wallet, locked stake, no duplicate
 *   settlement) and a Transaction row is written so the flow is observable.
 *   Demo rows are SIMULATED: `txHash` is always null — a hash is never
 *   fabricated — and every response carries `simulated: true`.
 *
 * DEMO_CHAIN_MODE=false: real Base Sepolia calls using the existing viem
 *   configuration (`services/blockchain.ts`) and the generated escrow ABI
 *   (`contracts/index.ts`). The signer comes only from the environment at run
 *   time; it is never logged, persisted, or exposed to a client.
 *
 * IDEMPOTENCY
 * -----------
 * Settlement is one-shot per challenge. A CLAIM/PENALTY row that is not FAILED
 * counts as "already settled", so re-running evaluation never duplicates it.
 * In live mode the on-chain `settled` flag is re-read before settling, which is
 * the authoritative second line of defence.
 *
 * This module never throws for expected conditions: it returns a typed
 * `EscrowResult` so that an escrow problem can never break challenge evaluation.
 */

import { decodeEventLog } from 'viem';

import { prisma } from '../db/prisma.js';
import {
  getBlockchainConfig,
  getPublicClient,
  getWalletClient,
  isDemoMode,
} from './blockchain.js';
import {
  BlockchainPersistenceError,
  DEFAULT_CHAIN_ID,
  createPendingTransaction,
  getUserTransactionHistory,
  getUserWalletForChain,
  updateTransaction,
  type TransactionRecord,
  type WalletRecord,
} from './blockchainPersistence.js';
import { getDeployedContracts, habitraChallengeEscrowAbi } from '../contracts/index.js';
import type { ChallengeStatus } from './challenges.js';

export type EscrowAction = 'FUND' | 'CLAIM' | 'PENALTY';
export type EscrowMode = 'demo' | 'live';

export type EscrowCode =
  /** Stake lock recorded. */
  | 'LOCKED'
  /** Settlement recorded / submitted. */
  | 'SETTLED'
  /** Stake was already locked for this challenge; nothing new was written. */
  | 'ALREADY_LOCKED'
  /** This challenge was already financially settled; nothing new was written. */
  | 'ALREADY_SETTLED'
  /** Challenge does not exist, or belongs to another user. */
  | 'CHALLENGE_NOT_FOUND'
  /** Challenge has not reached a terminal (COMPLETED/FAILED) status. */
  | 'CHALLENGE_NOT_SETTLED_STATE'
  /** Challenge is already closed, so a stake can no longer be locked. */
  | 'CHALLENGE_CLOSED'
  /** The user has no wallet linked on the target chain. */
  | 'NO_WALLET'
  /** No stake was ever locked for this challenge, so there is nothing to settle. */
  | 'STAKE_NOT_LOCKED'
  /** Stake amount is not a positive integer in base units. */
  | 'INVALID_AMOUNT'
  /** Lock end timestamp is not in the future. */
  | 'INVALID_END_DATE'
  /** Live mode selected but chain/contract configuration is incomplete. */
  | 'CHAIN_NOT_CONFIGURED'
  /** Live mode selected but no resolver signer is configured. */
  | 'NO_SIGNER'
  /** No escrow commitment exists on-chain for this challenge id. */
  | 'NO_ONCHAIN_COMMITMENT'
  /** The on-chain transaction reverted or could not be submitted. */
  | 'ONCHAIN_FAILED'
  /** Live lock requires the user's own signature (the backend has no user key). */
  | 'REQUIRES_USER_SIGNATURE'
  /** The supplied transaction hash is not a valid 0x-prefixed 32-byte hash. */
  | 'INVALID_TX_HASH'
  /** No transaction / receipt was found on-chain for the supplied hash. */
  | 'TX_NOT_FOUND'
  /** The supplied transaction reverted, so no stake was locked. */
  | 'TX_REVERTED'
  /** The supplied transaction was sent on a chain other than Base Sepolia. */
  | 'TX_CHAIN_MISMATCH'
  /** The supplied transaction was not sent to the escrow contract. */
  | 'TX_CONTRACT_MISMATCH'
  /** No matching ChallengeLocked event, or its challenge/user/amount differ. */
  | 'LOCK_EVENT_MISMATCH'
  /** The on-chain commitment does not match the expected lock. */
  | 'COMMITMENT_MISMATCH'
  /** A stake lock is already confirmed and cannot be re-pointed at another tx. */
  | 'LOCK_ALREADY_CONFIRMED'
  /** Database write failed. */
  | 'PERSISTENCE_ERROR';

export interface EscrowContractCall {
  address: string;
  functionName: 'lock' | 'settle';
  /** Encoded-ready arguments as strings/numbers (bigints are stringified). */
  args: Array<string | number | boolean>;
  note: string;
}

export interface EscrowResult {
  /** True when the operation completed (or was a legitimate no-op duplicate). */
  ok: boolean;
  mode: EscrowMode;
  /** True when NO on-chain transaction exists for this record. */
  simulated: boolean;
  challengeId: string;
  action: EscrowAction;
  /** The Transaction row that was created/reused, when there is one. */
  transaction: TransactionRecord | null;
  /** True when the operation was skipped because it already happened. */
  duplicate: boolean;
  /** On-chain tx hash. Always null for simulated (demo) records. */
  txHash: string | null;
  /** On-chain escrow commitment id, when known. */
  commitmentId: string | null;
  /** Present when the user (not the backend) must sign the on-chain call. */
  contractCall: EscrowContractCall | null;
  code: EscrowCode;
  message: string;
}

export interface LockChallengeStakeInput {
  userId: string;
  challengeId: string;
  /** Stake amount in BEES base units, as a non-negative integer string. */
  amount: string;
  /** Optional lock end; defaults to the challenge's end date (UTC). */
  endsAt?: Date;
}

export interface ConfirmUserLockInput {
  userId: string;
  challengeId: string;
  /**
   * On-chain lock transaction hash, as reported by the user's own wallet.
   * Public data only — never a key, seed or any other secret.
   */
  txHash: string;
}

/** The read-only viem client used to verify a user-signed transaction. */
export type EscrowPublicClient = NonNullable<ReturnType<typeof getPublicClient>>;

/**
 * Injectable seam so the reconciliation rules can be exercised in tests
 * without any network access. Defaults to the shared client from
 * `services/blockchain.ts`.
 */
export interface ConfirmUserLockDependencies {
  getClient?: () => EscrowPublicClient | null;
}

export interface SettleChallengeInput {
  userId: string;
  challengeId: string;
  /** Verdict from the off-chain evaluator. Must match the challenge status. */
  succeeded: boolean;
  /** Optional evaluator failure reason, kept for observability messages. */
  reason?: string | null;
}

export interface ChallengeEscrowState {
  challengeId: string;
  status: string;
  mode: EscrowMode;
  wallet: Pick<WalletRecord, 'id' | 'address' | 'chainId'> | null;
  stake: {
    transactionId: string;
    amount: string | null;
    status: string;
    simulated: boolean;
    createdAt: string;
  } | null;
  settlement: {
    transactionId: string;
    type: 'CLAIM' | 'PENALTY';
    status: string;
    simulated: boolean;
    txHash: string | null;
    createdAt: string;
  } | null;
  /** True once a non-failed settlement row exists. */
  settled: boolean;
  simulated: boolean;
}

const BASE_UNITS_PATTERN = /^\d+$/;
const SETTLEMENT_TYPES: readonly string[] = ['CLAIM', 'PENALTY'];
/** A valid EVM transaction hash: 0x followed by 64 hex characters. */
const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * `Transaction.amount` is a Prisma `BigInt`, stored as Postgres `int8`, so the
 * largest representable stake is 2^63-1 base units (~9.22 BEES at 18 decimals).
 * Amounts above that are rejected up front with INVALID_AMOUNT instead of
 * surfacing a database range error.
 */
const MAX_AMOUNT_BASE_UNITS = 9223372036854775807n;

/**
 * A Transaction with no txHash is a SIMULATED record: no transaction was ever
 * broadcast. Real records always carry a hash. This is the documented
 * demo/live marker and required no schema change.
 */
export function isSimulatedTransaction(transaction: TransactionRecord | null): boolean {
  return transaction != null && transaction.txHash == null;
}

function parseAmount(value: string): bigint | null {
  const trimmed = value.trim();
  if (!BASE_UNITS_PATTERN.test(trimmed)) return null;
  const parsed = BigInt(trimmed);
  if (parsed <= 0n || parsed > MAX_AMOUNT_BASE_UNITS) return null;
  return parsed;
}

function toUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function currentMode(): EscrowMode {
  return isDemoMode() ? 'demo' : 'live';
}

function baseResult(
  input: { challengeId: string; action: EscrowAction },
  overrides: Partial<EscrowResult>,
): EscrowResult {
  return {
    ok: false,
    mode: currentMode(),
    simulated: true,
    challengeId: input.challengeId,
    action: input.action,
    transaction: null,
    duplicate: false,
    txHash: null,
    commitmentId: null,
    contractCall: null,
    code: 'PERSISTENCE_ERROR',
    message: '',
    ...overrides,
  };
}

function failure(
  input: { challengeId: string; action: EscrowAction },
  code: EscrowCode,
  message: string,
): EscrowResult {
  return baseResult(input, { ok: false, code, message });
}

/**
 * Like `failure`, but for the live reconciliation path: a refusal is never a
 * simulated record, because the (real) stake row it refers to is untouched.
 */
function refusal(
  input: { challengeId: string; action: EscrowAction },
  code: EscrowCode,
  message: string,
): EscrowResult {
  return baseResult(input, { ok: false, simulated: false, code, message });
}

async function loadOwnedChallenge(userId: string, challengeId: string) {
  return prisma.challenge.findFirst({
    where: { id: challengeId, userId },
    select: {
      id: true,
      userId: true,
      status: true,
      startDate: true,
      endDate: true,
    },
  });
}

async function loadChallengeTransactions(
  userId: string,
  challengeId: string,
): Promise<TransactionRecord[]> {
  return getUserTransactionHistory(userId, { challengeId, limit: 100 });
}

/** The active stake lock, if any. A FAILED row does not count. */
export function findStakeLock(transactions: TransactionRecord[]): TransactionRecord | null {
  return transactions.find((tx) => tx.type === 'FUND' && tx.status !== 'FAILED') ?? null;
}

/** The active settlement, if any. A FAILED row does not count. */
export function findSettlement(transactions: TransactionRecord[]): TransactionRecord | null {
  return (
    transactions.find(
      (tx) => SETTLEMENT_TYPES.includes(tx.type) && tx.status !== 'FAILED',
    ) ?? null
  );
}

/**
 * Read an escrow commitment. viem decodes the named Solidity struct into an
 * object, so `endsAt` / `amount` are read as bigints.
 */
async function readCommitment(
  client: EscrowPublicClient,
  escrowAddress: `0x${string}`,
  commitmentId: bigint,
) {
  return client.readContract({
    address: escrowAddress,
    abi: habitraChallengeEscrowAbi,
    functionName: 'getCommitment',
    args: [commitmentId],
  });
}

interface DecodedChallengeLocked {
  commitmentId: bigint;
  challengeId: string;
  user: `0x${string}`;
  amount: bigint;
}

/**
 * Find and decode the `ChallengeLocked` event in a receipt's logs.
 *
 * The event carries `commitmentId` (indexed), `challengeId`, `user` (indexed)
 * and `amount` — but NOT `endsAt`. That is why the commitment itself is
 * re-read separately when reconciling a lock.
 */
function decodeChallengeLocked(
  logs: readonly unknown[],
  escrowAddress: string,
): DecodedChallengeLocked | null {
  const target = escrowAddress.toLowerCase();

  for (const entry of logs) {
    const log = entry as {
      address?: string;
      topics?: readonly `0x${string}`[];
      data?: `0x${string}`;
    };

    if (!log?.address || log.address.toLowerCase() !== target) continue;
    if (!log.topics || log.topics.length === 0) continue;

    try {
      const decoded = decodeEventLog({
        abi: habitraChallengeEscrowAbi,
        data: log.data ?? '0x',
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });

      if (decoded.eventName !== 'ChallengeLocked') continue;

      const args = decoded.args as {
        commitmentId?: bigint;
        challengeId?: string;
        user?: string;
        amount?: bigint;
      };

      if (typeof args.challengeId !== 'string') continue;
      if (typeof args.user !== 'string') continue;
      if (typeof args.amount !== 'bigint') continue;

      return {
        commitmentId: args.commitmentId ?? 0n,
        challengeId: args.challengeId,
        user: args.user as `0x${string}`,
        amount: args.amount,
      };
    } catch {
      // Not a ChallengeLocked log (or not decodable) — keep scanning.
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// 1. Lock a challenge stake
// ---------------------------------------------------------------------------

/**
 * Lock a BEES stake against a challenge.
 *
 * Demo: validates everything the live path requires, then writes a simulated
 * CONFIRMED FUND row (txHash = null).
 *
 * Live: writes a PENDING FUND row and returns the `lock` call descriptor. The
 * backend CANNOT complete this call itself — `HabitraChallengeEscrow.lock`
 * pulls BEES from `msg.sender`, i.e. the user — and Habitra never holds a
 * user's key. The user's wallet must approve the escrow and send the tx.
 */
export async function lockChallengeStake(
  input: LockChallengeStakeInput,
): Promise<EscrowResult> {
  const action: EscrowAction = 'FUND';
  const ctx = { challengeId: input.challengeId, action };

  const challenge = await loadOwnedChallenge(input.userId, input.challengeId);
  if (!challenge) {
    return failure(ctx, 'CHALLENGE_NOT_FOUND', 'Challenge not found for this user.');
  }

  if (challenge.status === 'COMPLETED' || challenge.status === 'FAILED' || challenge.status === 'ARCHIVED') {
    return failure(ctx, 'CHALLENGE_CLOSED', `Challenge is already ${challenge.status}.`);
  }

  const amount = parseAmount(input.amount);
  if (amount === null) {
    return failure(
      ctx,
      'INVALID_AMOUNT',
      'Stake amount must be a positive integer in BEES base units and at most ' +
        `${MAX_AMOUNT_BASE_UNITS.toString()} (the storage limit of Transaction.amount).`,
    );
  }

  const endsAt = input.endsAt ?? challenge.endDate;
  if (!(endsAt.getTime() > Date.now())) {
    return failure(
      ctx,
      'INVALID_END_DATE',
      'Stake lock end time must be in the future.',
    );
  }

  const wallet = await getUserWalletForChain(input.userId, DEFAULT_CHAIN_ID);
  if (!wallet) {
    return failure(
      ctx,
      'NO_WALLET',
      'No wallet is linked to this account. Connect a wallet before locking a stake.',
    );
  }

  const transactions = await loadChallengeTransactions(input.userId, input.challengeId);
  const existing = findStakeLock(transactions);
  if (existing) {
    return baseResult(ctx, {
      ok: true,
      duplicate: true,
      code: 'ALREADY_LOCKED',
      transaction: existing,
      txHash: existing.txHash,
      simulated: isSimulatedTransaction(existing),
      message: 'A stake is already locked for this challenge; nothing new was recorded.',
    });
  }

  const config = getBlockchainConfig();
  const tokenAddress = config.beesTokenAddress;

  try {
    const pending = await createPendingTransaction({
      userId: input.userId,
      walletId: wallet.id,
      type: 'FUND',
      challengeId: input.challengeId,
      chainId: DEFAULT_CHAIN_ID,
      amount: amount.toString(),
      tokenAddress,
    });

    if (isDemoMode()) {
      const confirmed = await updateTransaction({
        userId: input.userId,
        transactionId: pending.id,
        status: 'CONFIRMED',
      });

      return baseResult(ctx, {
        ok: true,
        simulated: true,
        transaction: confirmed,
        code: 'LOCKED',
        message:
          'Simulated demo stake lock recorded. No on-chain transaction was submitted and no BEES moved.',
      });
    }

    const contracts = getDeployedContracts();
    if (!contracts.ready || !contracts.escrowAddress) {
      await updateTransaction({
        userId: input.userId,
        transactionId: pending.id,
        status: 'FAILED',
      }).catch(() => undefined);
      return failure(
        ctx,
        'CHAIN_NOT_CONFIGURED',
        'On-chain mode is enabled but the escrow contract address is not configured.',
      );
    }

    return baseResult(ctx, {
      ok: true,
      simulated: false,
      transaction: pending,
      code: 'REQUIRES_USER_SIGNATURE',
      contractCall: {
        address: contracts.escrowAddress,
        functionName: 'lock',
        args: [input.challengeId, amount.toString(), toUnixSeconds(endsAt)],
        note:
          'The user must first call BEES.approve(escrow, amount), then send this lock ' +
          'transaction from their own wallet. Habitra never holds a user private key.',
      },
      message:
        'Stake lock recorded as PENDING. The user must sign the escrow lock transaction ' +
        'from their own wallet; no on-chain transaction has been submitted by Habitra.',
    });
  } catch (error) {
    const detail =
      error instanceof BlockchainPersistenceError ? error.message : 'Unknown persistence error.';
    return failure(ctx, 'PERSISTENCE_ERROR', detail);
  }
}

// ---------------------------------------------------------------------------
// 1b. Reconcile a user-signed lock transaction with its PENDING FUND record
// ---------------------------------------------------------------------------

/**
 * Reconcile the on-chain lock a user signed themselves with the PENDING FUND
 * row `lockChallengeStake` wrote when it handed back the call descriptor.
 *
 * This closes the gap in the live flow: the backend cannot broadcast `lock`
 * (it holds no user key), so the row stays PENDING with `txHash = null` until
 * the user's wallet reports the hash back. This function NEVER trusts that
 * hash — it is read-only on-chain and proves, before writing anything, that
 * the transaction:
 *   - exists on Base Sepolia and did NOT revert,
 *   - was sent to the deployed escrow contract,
 *   - emitted `ChallengeLocked` for THIS challenge, THIS linked wallet and the
 *     recorded stake amount, and
 *   - produced a commitment whose endsAt matches the challenge end date and
 *     which has not already been settled.
 *
 * Only then is the FUND row flipped to CONFIRMED with the real hash. Any
 * failed verification leaves the row PENDING so the user can retry with the
 * correct hash — a bad hash never destroys a stake. The operation is
 * idempotent: confirming the same hash twice is a no-op success, while
 * re-pointing an already-confirmed lock at a different transaction is refused.
 *
 * Nothing here signs or broadcasts: it uses only the read-only public client.
 */
export async function confirmUserLock(
  input: ConfirmUserLockInput,
  deps: ConfirmUserLockDependencies = {},
): Promise<EscrowResult> {
  const action: EscrowAction = 'FUND';
  const ctx = { challengeId: input.challengeId, action };

  const rawHash = typeof input.txHash === 'string' ? input.txHash.trim() : '';
  if (!TX_HASH_PATTERN.test(rawHash)) {
    return refusal(
      ctx,
      'INVALID_TX_HASH',
      'txHash must be a 0x-prefixed 32-byte (64 hex character) transaction hash.',
    );
  }
  const txHash = rawHash.toLowerCase() as `0x${string}`;

  const challenge = await loadOwnedChallenge(input.userId, input.challengeId);
  if (!challenge) {
    return refusal(ctx, 'CHALLENGE_NOT_FOUND', 'Challenge not found for this user.');
  }

  const wallet = await getUserWalletForChain(input.userId, DEFAULT_CHAIN_ID);
  if (!wallet) {
    return refusal(
      ctx,
      'NO_WALLET',
      'No wallet is linked to this account on Base Sepolia, so no stake lock can be confirmed.',
    );
  }

  const transactions = await loadChallengeTransactions(input.userId, input.challengeId);
  const stake = findStakeLock(transactions);
  if (!stake) {
    return refusal(
      ctx,
      'STAKE_NOT_LOCKED',
      'No stake lock exists for this challenge, so there is nothing to confirm.',
    );
  }

  // Idempotency: never re-associate an already-confirmed lock with a new hash.
  if (stake.status === 'CONFIRMED') {
    if (stake.txHash != null && stake.txHash.toLowerCase() === txHash) {
      return baseResult(ctx, {
        ok: true,
        duplicate: true,
        simulated: false,
        transaction: stake,
        txHash: stake.txHash,
        code: 'LOCKED',
        message: 'This stake lock has already been confirmed with the same transaction hash.',
      });
    }
    return refusal(
      ctx,
      'LOCK_ALREADY_CONFIRMED',
      'This stake lock is already confirmed and cannot be associated with a different transaction.',
    );
  }

  if (stake.status !== 'PENDING') {
    return refusal(
      ctx,
      'LOCK_ALREADY_CONFIRMED',
      `The stake lock for this challenge is ${stake.status}, so it cannot be confirmed.`,
    );
  }

  if (stake.amount == null) {
    return refusal(
      ctx,
      'LOCK_EVENT_MISMATCH',
      'The recorded stake has no amount, so it cannot be matched against an on-chain lock.',
    );
  }
  const expectedAmount = BigInt(stake.amount);
  const expectedEndsAt = BigInt(toUnixSeconds(challenge.endDate));

  const contracts = getDeployedContracts();
  const escrowAddress = contracts.escrowAddress;
  const client = (deps.getClient ?? getPublicClient)();

  if (!client || !contracts.ready || !escrowAddress) {
    return refusal(
      ctx,
      'CHAIN_NOT_CONFIGURED',
      'On-chain mode is disabled or the chain/contract configuration is incomplete, ' +
        'so the transaction cannot be verified.',
    );
  }

  // 1. The transaction must exist and must not have reverted.
  let receipt: Awaited<ReturnType<NonNullable<typeof client>['getTransactionReceipt']>>;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch {
    return refusal(
      ctx,
      'TX_NOT_FOUND',
      'No transaction receipt was found on Base Sepolia for that hash.',
    );
  }

  if (receipt.status === 'reverted') {
    return refusal(
      ctx,
      'TX_REVERTED',
      'That transaction reverted, so no stake was locked.',
    );
  }

  // 2. It must be a Base Sepolia transaction sent to the escrow contract.
  let transaction: Awaited<ReturnType<NonNullable<typeof client>['getTransaction']>>;
  try {
    transaction = await client.getTransaction({ hash: txHash });
  } catch {
    return refusal(ctx, 'TX_NOT_FOUND', 'No transaction was found on Base Sepolia for that hash.');
  }

  // `chainId` is absent on some transaction shapes (e.g. deposits), so read it
  // defensively: anything other than Base Sepolia is refused.
  const txChainId = 'chainId' in transaction ? transaction.chainId : undefined;

  if (txChainId !== DEFAULT_CHAIN_ID) {
    return refusal(
      ctx,
      'TX_CHAIN_MISMATCH',
      `That transaction is on chain ${String(txChainId)}, not Base Sepolia (${DEFAULT_CHAIN_ID}).`,
    );
  }

  if (!transaction.to || transaction.to.toLowerCase() !== escrowAddress.toLowerCase()) {
    return refusal(
      ctx,
      'TX_CONTRACT_MISMATCH',
      'That transaction was not sent to the Habitra escrow contract.',
    );
  }

  // 3. It must have emitted ChallengeLocked for this challenge, wallet and amount.
  const locked = decodeChallengeLocked(receipt.logs, escrowAddress);
  if (!locked) {
    return refusal(
      ctx,
      'LOCK_EVENT_MISMATCH',
      'That transaction did not emit a ChallengeLocked event from the Habitra escrow contract.',
    );
  }

  if (locked.challengeId !== input.challengeId) {
    return refusal(
      ctx,
      'LOCK_EVENT_MISMATCH',
      'That transaction locked a stake for a different challenge.',
    );
  }

  if (locked.user.toLowerCase() !== wallet.address.toLowerCase()) {
    return refusal(
      ctx,
      'LOCK_EVENT_MISMATCH',
      'That transaction was sent by a wallet other than the one linked to this account.',
    );
  }

  if (locked.amount !== expectedAmount) {
    return refusal(
      ctx,
      'LOCK_EVENT_MISMATCH',
      `That transaction locked ${locked.amount.toString()} base units, ` +
        `but the recorded stake is ${expectedAmount.toString()} base units.`,
    );
  }

  // 4. The on-chain commitment must match (endsAt is not in the event).
  let commitmentId: bigint;
  try {
    commitmentId = await client.readContract({
      address: escrowAddress,
      abi: habitraChallengeEscrowAbi,
      functionName: 'commitmentIdByChallenge',
      args: [input.challengeId],
    });
  } catch {
    return refusal(ctx, 'CHAIN_NOT_CONFIGURED', 'Unable to read the escrow contract on Base Sepolia.');
  }

  if (commitmentId === 0n) {
    return refusal(
      ctx,
      'NO_ONCHAIN_COMMITMENT',
      'No escrow commitment exists on-chain for this challenge id.',
    );
  }

  if (locked.commitmentId !== 0n && locked.commitmentId !== commitmentId) {
    return refusal(
      ctx,
      'COMMITMENT_MISMATCH',
      'The locked commitment does not match the escrow commitment for this challenge.',
    );
  }

  let commitment: Awaited<ReturnType<typeof readCommitment>>;
  try {
    commitment = await readCommitment(client, escrowAddress, commitmentId);
  } catch {
    return refusal(ctx, 'CHAIN_NOT_CONFIGURED', 'Unable to read the escrow commitment on Base Sepolia.');
  }

  if (commitment.challengeId !== input.challengeId) {
    return refusal(ctx, 'COMMITMENT_MISMATCH', 'The on-chain commitment belongs to a different challenge.');
  }

  if (commitment.user.toLowerCase() !== wallet.address.toLowerCase()) {
    return refusal(ctx, 'COMMITMENT_MISMATCH', 'The on-chain commitment belongs to a different wallet.');
  }

  if (commitment.amount !== expectedAmount) {
    return refusal(ctx, 'COMMITMENT_MISMATCH', 'The on-chain commitment amount does not match the recorded stake.');
  }

  if (commitment.endsAt !== expectedEndsAt) {
    return refusal(
      ctx,
      'COMMITMENT_MISMATCH',
      `The on-chain commitment ends at ${commitment.endsAt.toString()}, ` +
        `expected ${expectedEndsAt.toString()} (the challenge end date).`,
    );
  }

  if (commitment.settled) {
    return refusal(
      ctx,
      'COMMITMENT_MISMATCH',
      'The on-chain commitment is already settled, so it can no longer be recorded as a fresh lock.',
    );
  }

  // 5. Every check passed: record the real hash and confirm the stake.
  try {
    const confirmed = await updateTransaction({
      userId: input.userId,
      transactionId: stake.id,
      status: 'CONFIRMED',
      txHash,
    });

    return baseResult(ctx, {
      ok: true,
      simulated: false,
      transaction: confirmed,
      txHash,
      commitmentId: commitmentId.toString(),
      code: 'LOCKED',
      message:
        'Stake lock confirmed: the on-chain lock transaction was verified against this ' +
        'challenge, wallet and amount, and the stake is now recorded as CONFIRMED.',
    });
  } catch (error) {
    const detail =
      error instanceof BlockchainPersistenceError ? error.message : 'Unknown persistence error.';
    return refusal(ctx, 'PERSISTENCE_ERROR', detail);
  }
}

// ---------------------------------------------------------------------------
// 2 + 3. Settle a challenge (success = CLAIM, failure = PENALTY)
// ---------------------------------------------------------------------------

/**
 * Settle a challenge's locked stake.
 *
 * Demo: validates, then writes a simulated CONFIRMED CLAIM/PENALTY row
 * (txHash = null).
 *
 * Live: re-reads the on-chain commitment (rejecting if already settled), then
 * submits `settle(commitmentId, succeeded)` with the resolver key from the
 * environment. A reverted or failed submission marks the row FAILED — it never
 * claims that BEES were returned or slashed.
 */
export async function settleChallenge(input: SettleChallengeInput): Promise<EscrowResult> {
  const action: EscrowAction = input.succeeded ? 'CLAIM' : 'PENALTY';
  const ctx = { challengeId: input.challengeId, action };

  const challenge = await loadOwnedChallenge(input.userId, input.challengeId);
  if (!challenge) {
    return failure(ctx, 'CHALLENGE_NOT_FOUND', 'Challenge not found for this user.');
  }

  if (challenge.status !== 'COMPLETED' && challenge.status !== 'FAILED') {
    return failure(
      ctx,
      'CHALLENGE_NOT_SETTLED_STATE',
      `Challenge status is ${challenge.status}; only COMPLETED or FAILED challenges can be settled.`,
    );
  }

  const expectedSuccess = challenge.status === 'COMPLETED';
  if (expectedSuccess !== input.succeeded) {
    return failure(
      ctx,
      'CHALLENGE_NOT_SETTLED_STATE',
      `Verdict does not match challenge status (${challenge.status}). The evaluator owns the verdict.`,
    );
  }

  const wallet = await getUserWalletForChain(input.userId, DEFAULT_CHAIN_ID);
  if (!wallet) {
    return failure(
      ctx,
      'NO_WALLET',
      'No wallet is linked to this account, so there is no stake to settle.',
    );
  }

  const transactions = await loadChallengeTransactions(input.userId, input.challengeId);

  const settlement = findSettlement(transactions);
  if (settlement) {
    return baseResult(ctx, {
      ok: true,
      duplicate: true,
      code: 'ALREADY_SETTLED',
      transaction: settlement,
      txHash: settlement.txHash,
      simulated: isSimulatedTransaction(settlement),
      message:
        'This challenge has already been financially settled; no second settlement was created.',
    });
  }

  const stake = findStakeLock(transactions);
  if (!stake) {
    return failure(
      ctx,
      'STAKE_NOT_LOCKED',
      'No locked stake exists for this challenge, so there is nothing to settle.',
    );
  }

  const config = getBlockchainConfig();
  const tokenAddress = config.beesTokenAddress;
  const reasonSuffix = input.reason ? ` (${input.reason})` : '';

  try {
    const pending = await createPendingTransaction({
      userId: input.userId,
      walletId: wallet.id,
      type: action,
      challengeId: input.challengeId,
      chainId: DEFAULT_CHAIN_ID,
      amount: stake.amount,
      tokenAddress,
    });

    if (isDemoMode()) {
      const confirmed = await updateTransaction({
        userId: input.userId,
        transactionId: pending.id,
        status: 'CONFIRMED',
      });

      return baseResult(ctx, {
        ok: true,
        simulated: true,
        transaction: confirmed,
        code: 'SETTLED',
        message: input.succeeded
          ? `Simulated demo settlement: the stake would be returned to the user${reasonSuffix}. ` +
            'No on-chain transaction was submitted and no BEES moved.'
          : `Simulated demo settlement: the stake would be slashed to the treasury${reasonSuffix}. ` +
            'No on-chain transaction was submitted and no BEES moved.',
      });
    }

    const contracts = getDeployedContracts();
    const publicClient = getPublicClient();
    const walletClient = getWalletClient();

    if (!contracts.ready || !contracts.escrowAddress || !publicClient) {
      await updateTransaction({
        userId: input.userId,
        transactionId: pending.id,
        status: 'FAILED',
      }).catch(() => undefined);
      return failure(
        ctx,
        'CHAIN_NOT_CONFIGURED',
        'On-chain mode is enabled but the chain/contract configuration is incomplete.',
      );
    }

    if (!walletClient) {
      await updateTransaction({
        userId: input.userId,
        transactionId: pending.id,
        status: 'FAILED',
      }).catch(() => undefined);
      return failure(
        ctx,
        'NO_SIGNER',
        'On-chain mode is enabled but no resolver signer is configured.',
      );
    }

    const escrowAddress = contracts.escrowAddress;

    let commitmentId: bigint;
    try {
      commitmentId = await publicClient.readContract({
        address: escrowAddress,
        abi: habitraChallengeEscrowAbi,
        functionName: 'commitmentIdByChallenge',
        args: [input.challengeId],
      });
    } catch {
      await updateTransaction({
        userId: input.userId,
        transactionId: pending.id,
        status: 'FAILED',
      }).catch(() => undefined);
      return failure(
        ctx,
        'CHAIN_NOT_CONFIGURED',
        'Unable to read the escrow contract on Base Sepolia.',
      );
    }

    if (commitmentId === 0n) {
      await updateTransaction({
        userId: input.userId,
        transactionId: pending.id,
        status: 'FAILED',
      }).catch(() => undefined);
      return failure(
        ctx,
        'NO_ONCHAIN_COMMITMENT',
        'No escrow commitment exists on-chain for this challenge id.',
      );
    }

    const commitment = await publicClient.readContract({
      address: escrowAddress,
      abi: habitraChallengeEscrowAbi,
      functionName: 'getCommitment',
      args: [commitmentId],
    });

    if (commitment.settled) {
      await updateTransaction({
        userId: input.userId,
        transactionId: pending.id,
        status: 'FAILED',
      }).catch(() => undefined);
      return baseResult(ctx, {
        ok: true,
        duplicate: true,
        code: 'ALREADY_SETTLED',
        commitmentId: commitmentId.toString(),
        message: 'The on-chain commitment is already settled; no second settlement was sent.',
      });
    }

    try {
      const hash = await walletClient.writeContract({
        address: escrowAddress,
        abi: habitraChallengeEscrowAbi,
        functionName: 'settle',
        args: [commitmentId, input.succeeded],
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      if (receipt.status === 'reverted') {
        await updateTransaction({
          userId: input.userId,
          transactionId: pending.id,
          status: 'FAILED',
          txHash: hash,
        }).catch(() => undefined);

        return baseResult(ctx, {
          ok: false,
          simulated: false,
          transaction: pending,
          txHash: hash,
          commitmentId: commitmentId.toString(),
          code: 'ONCHAIN_FAILED',
          message: 'The settlement transaction reverted. No BEES were returned or slashed.',
        });
      }

      const confirmed = await updateTransaction({
        userId: input.userId,
        transactionId: pending.id,
        status: 'CONFIRMED',
        txHash: hash,
      });

      return baseResult(ctx, {
        ok: true,
        simulated: false,
        transaction: confirmed,
        txHash: hash,
        commitmentId: commitmentId.toString(),
        code: 'SETTLED',
        message: input.succeeded
          ? `Stake returned to the user on Base Sepolia${reasonSuffix}.`
          : `Stake slashed to the treasury on Base Sepolia${reasonSuffix}.`,
      });
    } catch (error) {
      await updateTransaction({
        userId: input.userId,
        transactionId: pending.id,
        status: 'FAILED',
      }).catch(() => undefined);

      const detail = error instanceof Error ? error.message : 'Unknown on-chain error.';
      return baseResult(ctx, {
        ok: false,
        simulated: false,
        transaction: pending,
        commitmentId: commitmentId.toString(),
        code: 'ONCHAIN_FAILED',
        message: `Settlement transaction failed and was not confirmed: ${detail}`,
      });
    }
  } catch (error) {
    const detail =
      error instanceof BlockchainPersistenceError ? error.message : 'Unknown persistence error.';
    return failure(ctx, 'PERSISTENCE_ERROR', detail);
  }
}

/** Settlement helper for a successful (COMPLETED) challenge. */
export function settleChallengeAsSuccess(
  userId: string,
  challengeId: string,
): Promise<EscrowResult> {
  return settleChallenge({ userId, challengeId, succeeded: true });
}

/** Settlement helper for a failed (FAILED) challenge. */
export function settleChallengeAsFailure(
  userId: string,
  challengeId: string,
  reason?: string | null,
): Promise<EscrowResult> {
  return settleChallenge({ userId, challengeId, succeeded: false, reason });
}

/**
 * Called by the challenge evaluation flow after a status transition.
 * Returns null when the status is not terminal, so callers can ignore it.
 */
export async function settleChallengeForEvaluation(
  userId: string,
  challengeId: string,
  status: ChallengeStatus,
  reason?: string | null,
): Promise<EscrowResult | null> {
  if (status === 'COMPLETED') {
    return settleChallengeAsSuccess(userId, challengeId);
  }
  if (status === 'FAILED') {
    return settleChallengeAsFailure(userId, challengeId, reason);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

/** Read-only view of a challenge's escrow state, scoped to its owner. */
export async function getChallengeEscrowState(
  userId: string,
  challengeId: string,
): Promise<ChallengeEscrowState | null> {
  const challenge = await loadOwnedChallenge(userId, challengeId);
  if (!challenge) return null;

  const wallet = await getUserWalletForChain(userId, DEFAULT_CHAIN_ID);
  const transactions = await loadChallengeTransactions(userId, challengeId);
  const stake = findStakeLock(transactions);
  const settlement = findSettlement(transactions);

  return {
    challengeId: challenge.id,
    status: challenge.status,
    mode: currentMode(),
    wallet: wallet
      ? { id: wallet.id, address: wallet.address, chainId: wallet.chainId }
      : null,
    stake: stake
      ? {
        transactionId: stake.id,
        amount: stake.amount,
        status: stake.status,
        simulated: isSimulatedTransaction(stake),
        createdAt: stake.createdAt,
      }
      : null,
    settlement: settlement
      ? {
        transactionId: settlement.id,
        type: settlement.type === 'PENALTY' ? 'PENALTY' : 'CLAIM',
        status: settlement.status,
        simulated: isSimulatedTransaction(settlement),
        txHash: settlement.txHash,
        createdAt: settlement.createdAt,
      }
      : null,
    settled: settlement !== null,
    simulated: isSimulatedTransaction(stake) || isSimulatedTransaction(settlement),
  };
}
