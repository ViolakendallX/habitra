/**
 * Tests for the off-chain reconciliation of a USER-SIGNED escrow lock.
 *
 * Run with: npm run test:challenge_escrow_confirm   (inside backend/)
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * In live mode the backend cannot broadcast `lock` (it holds no user key), so
 * `POST /:challengeId/stake` writes a PENDING FUND row with `txHash = null` and
 * returns REQUIRES_USER_SIGNATURE. `confirmUserLock` + `POST
 * /:challengeId/escrow/confirm` close that gap: the user's wallet reports the
 * hash and the backend proves ON-CHAIN that the transaction really is the
 * expected lock before flipping the row to CONFIRMED.
 *
 * HERMETIC BY DESIGN
 * ------------------
 * The chain reads are injected (`ConfirmUserLockDependencies.getClient`), so
 * every on-chain scenario is exercised against a stub — no RPC, no signing, no
 * broadcast, no network. The HTTP cases below all short-circuit BEFORE a client
 * is ever requested (auth -> zod -> ownership -> wallet -> stake lookup ->
 * idempotency), so the suite passes identically in demo and live mode.
 *
 * Coverage:
 *   HTTP: 401 / malformed hash / unknown challenge / no wallet / no stake /
 *         unconfigured chain refuses without touching the row /
 *         idempotent re-confirm / re-pointing a confirmed lock is refused
 *   Core: happy path flips PENDING -> CONFIRMED with the real hash
 *         reverted tx, wrong chain, wrong destination
 *         missing / mismatched ChallengeLocked event (challenge, user, amount)
 *         commitment endsAt mismatch, already-settled, no on-chain commitment
 *         cross-user ownership
 *   Invariant: a FAILED verification always leaves the row PENDING
 *   End-to-end: GET /:challengeId/escrow reports the real confirmed stake
 */

import { encodeAbiParameters, encodeEventTopics } from 'viem';

import { createApp } from '../src/app.js';
import { prisma } from '../src/db/prisma.js';
import {
  createPendingTransaction,
  updateTransaction,
} from '../src/services/blockchainPersistence.js';
import { isDemoMode } from '../src/services/blockchain.js';
import { getDeployedContracts, habitraChallengeEscrowAbi } from '../src/contracts/index.js';
import {
  confirmUserLock,
  type EscrowPublicClient,
} from '../src/services/challengeEscrow.js';

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

const checks: Check[] = [];

function check(name: string, pass: boolean, detail?: string): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}`);
}

function extractCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const first = setCookie.split(';')[0]?.trim();
  return first || null;
}

async function jsonOf(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Random, syntactically valid EVM address (test fixture only — never a key). */
function randomAddress(): string {
  let hex = '0x';
  const chars = '0123456789abcdef';
  for (let i = 0; i < 40; i += 1) {
    hex += chars[Math.floor(Math.random() * 16)];
  }
  return hex;
}

function isoDay(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

async function registerAndLogin(base: string, name: string, email: string): Promise<string | null> {
  await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password: 'Password123!' }),
  });

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Password123!' }),
  });

  return extractCookie(login.headers.get('set-cookie'));
}

async function userIdOf(base: string, cookie: string | null): Promise<string | null> {
  const me = await fetch(`${base}/api/auth/me`, { headers: cookie ? { Cookie: cookie } : {} });
  const json = await jsonOf(me);
  return (json?.data?.user?.id as string | undefined) ?? null;
}

async function createHabit(
  base: string,
  cookie: string | null,
  name: string,
): Promise<string | undefined> {
  const res = await fetch(`${base}/api/habits`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ name, frequency: 'DAILY', target: 1 }),
  });
  const json = await jsonOf(res);
  return json?.data?.habit?.id;
}

async function createChallenge(
  base: string,
  cookie: string | null,
  habitId: string,
  title: string,
  maxMisses: number,
): Promise<string | undefined> {
  const res = await fetch(`${base}/api/challenges`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({
      title,
      startDate: isoDay(1),
      endDate: isoDay(3),
      maxMisses,
      habitId,
    }),
  });
  const json = await jsonOf(res);
  return json?.data?.challenge?.id;
}

async function commitChallenge(
  base: string,
  cookie: string | null,
  challengeId: string,
): Promise<number> {
  const res = await fetch(`${base}/api/challenges/${challengeId}/commit`, {
    method: 'POST',
    headers: cookie ? { Cookie: cookie } : {},
  });
  return res.status;
}

async function linkWallet(base: string, cookie: string | null): Promise<string> {
  const address = randomAddress();
  await fetch(`${base}/api/wallet`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ address, chainId: 84532 }),
  });
  return address;
}

async function confirmViaApi(
  base: string,
  cookie: string | null,
  challengeId: string,
  txHash: string,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api/challenges/${challengeId}/escrow/confirm`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ txHash }),
  });
  return { status: res.status, json: await jsonOf(res) };
}

/** 5 BEES in base units (below the int8 storage ceiling of ~9.22 BEES). */
const STAKE = '5000000000000000000';

/** A syntactically valid but non-existent transaction hash. */
function fakeHash(seed = 'ab'): string {
  return `0x${seed.repeat(32)}`;
}

// ---------------------------------------------------------------------------
// On-chain stubs
// ---------------------------------------------------------------------------

interface StubScenario {
  status?: 'success' | 'reverted';
  /** Transaction destination. Defaults to the escrow contract. */
  to?: string | null;
  chainId?: number;
  logs?: unknown[] | null;
  commitmentId?: bigint;
  commitment?: {
    user: string;
    amount: bigint;
    endsAt: bigint;
    settled: boolean;
    succeeded: boolean;
    challengeId: string;
  } | null;
  throwOnReceipt?: boolean;
}

/**
 * Build a real, decodable `ChallengeLocked` log. The event shape is read from
 * the generated ABI so this stays correct if the contract changes.
 */
function challengeLockedLog(opts: {
  escrow: string;
  commitmentId: bigint;
  challengeId: string;
  user: string;
  amount: bigint;
  endsAt: bigint;
}): unknown {
  const topics = encodeEventTopics({
    abi: habitraChallengeEscrowAbi,
    eventName: 'ChallengeLocked',
    args: {
      commitmentId: opts.commitmentId,
      user: opts.user as `0x${string}`,
    },
  });

  const eventAbi = (habitraChallengeEscrowAbi as any[]).find(
    (entry) => entry.type === 'event' && entry.name === 'ChallengeLocked',
  );
  const nonIndexed = eventAbi.inputs.filter((input: any) => !input.indexed);
  const values = nonIndexed.map((input: any) => {
    if (input.name === 'challengeId') return opts.challengeId;
    if (input.name === 'amount') return opts.amount;
    if (input.name === 'endsAt') return opts.endsAt;
    return 0n;
  });

  return {
    address: opts.escrow,
    topics,
    data: encodeAbiParameters(nonIndexed, values),
  };
}

function stubClient(scenario: StubScenario, escrow: string): EscrowPublicClient {
  return {
    getTransactionReceipt: async () => {
      if (scenario.throwOnReceipt) throw new Error('receipt not found');
      return {
        status: scenario.status ?? 'success',
        logs: scenario.logs ?? [],
      } as any;
    },
    getTransaction: async () => {
      const to = scenario.to === undefined ? escrow : scenario.to;
      return { to, chainId: scenario.chainId ?? 84532 } as any;
    },
    readContract: async (args: any) => {
      if (args.functionName === 'commitmentIdByChallenge') {
        return scenario.commitmentId ?? 1n;
      }
      if (args.functionName === 'getCommitment') {
        if (scenario.commitment === null) throw new Error('no commitment');
        return scenario.commitment as any;
      }
      throw new Error(`unexpected read: ${args.functionName}`);
    },
  } as unknown as EscrowPublicClient;
}

async function main(): Promise<void> {
  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const createdUserIds: string[] = [];

  try {
    const contracts = getDeployedContracts();
    const escrow = contracts.escrowAddress ?? '';

    check(
      'escrow contract address is configured (required to verify a lock)',
      Boolean(escrow),
      `escrow=${escrow || 'none'}`,
    );
    if (!escrow) {
      throw new Error('CHALLENGE_CONTRACT_ADDRESS is not configured; cannot run this suite.');
    }

    // ------------------------------------------------------------------
    // Setup: user A (wallet + challenge), user B (no wallet), user C (no stake)
    // ------------------------------------------------------------------
    const stamp = Date.now();
    const emailA = `confirm-a-${stamp}@example.com`;
    const emailB = `confirm-b-${stamp}@example.com`;
    const emailC = `confirm-c-${stamp}@example.com`;

    const cookieA = await registerAndLogin(base, 'Confirm A', emailA);
    const cookieB = await registerAndLogin(base, 'Confirm B', emailB);
    const cookieC = await registerAndLogin(base, 'Confirm C', emailC);

    const userAId = (await userIdOf(base, cookieA))!;
    const userBId = (await userIdOf(base, cookieB))!;
    const userCId = (await userIdOf(base, cookieC))!;
    createdUserIds.push(userAId, userBId, userCId);

    check('test users resolved', Boolean(userAId && userBId && userCId));

    const habitAId = (await createHabit(base, cookieA, 'Confirm Habit A'))!;
    const habitCId = (await createHabit(base, cookieC, 'Confirm Habit C'))!;

    const walletA = await linkWallet(base, cookieA);
    await linkWallet(base, cookieC);

    const challengeId = (await createChallenge(base, cookieA, habitAId, 'Confirm challenge', 2))!;
    const commitStatus = await commitChallenge(base, cookieA, challengeId);
    check('challenge committed to ACTIVE', commitStatus === 200, `status=${commitStatus}`);

    const challengeC = (await createChallenge(base, cookieC, habitCId, 'Confirm challenge C', 2))!;
    await commitChallenge(base, cookieC, challengeC);

    const walletRow = await prisma.wallet.findFirst({
      where: { userId: userAId, chainId: 84532 },
      select: { id: true, address: true },
    });
    check('wallet row resolved for user A', Boolean(walletRow), `address=${walletRow?.address}`);
    if (!walletRow) throw new Error('Wallet setup failed.');

    const challengeRow = await prisma.challenge.findUnique({
      where: { id: challengeId },
      select: { endDate: true },
    });
    const expectedEndsAt = BigInt(Math.floor(challengeRow!.endDate.getTime() / 1000));

    /** Creates the PENDING FUND row that live-mode staking would have created. */
    async function seedPendingFund(): Promise<string> {
      const existing = await prisma.transaction.findFirst({
        where: { challengeId, type: 'FUND' },
        select: { id: true },
      });
      if (existing) {
        await prisma.transaction.update({
          where: { id: existing.id },
          data: { status: 'PENDING', txHash: null },
        });
        return existing.id;
      }
      const row = await createPendingTransaction({
        userId: userAId,
        walletId: walletRow!.id,
        type: 'FUND',
        challengeId,
        chainId: 84532,
        amount: STAKE,
        tokenAddress: contracts.beesTokenAddress ?? randomAddress(),
      });
      return row.id;
    }

    async function fundState(): Promise<{ status: string; txHash: string | null }> {
      const row = await prisma.transaction.findFirst({
        where: { challengeId, type: 'FUND' },
        select: { status: true, txHash: true },
      });
      return { status: row?.status ?? 'MISSING', txHash: row?.txHash ?? null };
    }

    async function fundCount(): Promise<number> {
      return prisma.transaction.count({ where: { challengeId, type: 'FUND' } });
    }

    /** Fresh lock log + matching commitment for the happy path. */
    function goodLock(over: {
      challengeId?: string;
      user?: string;
      amount?: bigint;
      commitmentId?: bigint;
    } = {}) {
      const commitmentId = over.commitmentId ?? 7n;
      const log = challengeLockedLog({
        escrow,
        commitmentId,
        challengeId: over.challengeId ?? challengeId,
        user: over.user ?? walletRow!.address,
        amount: over.amount ?? BigInt(STAKE),
        endsAt: expectedEndsAt,
      });
      return {
        log,
        commitment: {
          user: over.user ?? walletRow!.address,
          amount: over.amount ?? BigInt(STAKE),
          endsAt: expectedEndsAt,
          settled: false,
          succeeded: false,
          challengeId: over.challengeId ?? challengeId,
        },
        commitmentId,
      };
    }

    // ------------------------------------------------------------------
    // HTTP-level guards (all short-circuit before any chain access)
    // ------------------------------------------------------------------
    const unauth = await confirmViaApi(base, null, challengeId, fakeHash());
    check('unauthenticated confirm is rejected (401)', unauth.status === 401, `status=${unauth.status}`);

    await seedPendingFund();

    const badHash = await confirmViaApi(base, cookieA, challengeId, 'not-a-hash');
    check(
      'malformed txHash is rejected by validation (400)',
      badHash.status === 400 && Boolean(badHash.json?.errors?.txHash),
      `status=${badHash.status}`,
    );

    const shortHash = await confirmViaApi(base, cookieA, challengeId, '0x1234');
    check(
      'truncated txHash is rejected (400)',
      shortHash.status === 400,
      `status=${shortHash.status}`,
    );

    const unknownChallenge = await confirmViaApi(base, cookieA, 'does-not-exist', fakeHash());
    check(
      'unknown challenge returns 404 CHALLENGE_NOT_FOUND',
      unknownChallenge.status === 404 &&
        unknownChallenge.json?.code === 'CHALLENGE_NOT_FOUND',
      `status=${unknownChallenge.status} code=${unknownChallenge.json?.code}`,
    );

    const crossUser = await confirmViaApi(base, cookieB, challengeId, fakeHash());
    check(
      'another user cannot confirm someone else\'s lock (404)',
      crossUser.status === 404 && crossUser.json?.code === 'CHALLENGE_NOT_FOUND',
      `status=${crossUser.status} code=${crossUser.json?.code}`,
    );

    const noStake = await confirmViaApi(base, cookieC, challengeC, fakeHash());
    check(
      'confirming a challenge with no stake returns 409 STAKE_NOT_LOCKED',
      noStake.status === 409 && noStake.json?.code === 'STAKE_NOT_LOCKED',
      `status=${noStake.status} code=${noStake.json?.code}`,
    );

    // In demo mode there is no chain to verify against: refuse, never update.
    if (isDemoMode()) {
      await seedPendingFund();
      const noChain = await confirmViaApi(base, cookieA, challengeId, fakeHash());
      const after = await fundState();
      check(
        'demo mode refuses to confirm (503 CHAIN_NOT_CONFIGURED)',
        noChain.status === 503 && noChain.json?.code === 'CHAIN_NOT_CONFIGURED',
        `status=${noChain.status} code=${noChain.json?.code}`,
      );
      check(
        'an unverifiable hash never touches the FUND row',
        after.status === 'PENDING' && after.txHash === null,
        `status=${after.status} txHash=${after.txHash}`,
      );
    } else {
      check('demo-mode guard skipped (backend is in live mode)', true);
    }

    // ------------------------------------------------------------------
    // Core: happy path via the injected (stubbed) chain client
    // ------------------------------------------------------------------
    const fundId = await seedPendingFund();
    const happy = goodLock();
    const realHash = fakeHash('7b');

    const ok = await confirmUserLock(
      { userId: userAId, challengeId, txHash: realHash },
      { getClient: () => stubClient({ logs: [happy.log], commitmentId: happy.commitmentId, commitment: happy.commitment }, escrow) },
    );

    const afterOk = await fundState();
    check(
      'verified lock confirms the stake (ok, code LOCKED)',
      ok.ok === true && ok.code === 'LOCKED',
      `ok=${ok.ok} code=${ok.code} message=${ok.message}`,
    );
    check(
      'FUND row flips PENDING -> CONFIRMED',
      afterOk.status === 'CONFIRMED',
      `status=${afterOk.status}`,
    );
    check(
      'the real transaction hash is persisted',
      afterOk.txHash === realHash,
      `txHash=${afterOk.txHash}`,
    );
    check(
      'commitment id is reported back',
      ok.commitmentId === happy.commitmentId.toString(),
      `commitmentId=${ok.commitmentId}`,
    );
    check(
      'the confirmed record is no longer simulated',
      ok.simulated === false && ok.txHash === realHash,
      `simulated=${ok.simulated}`,
    );
    check('exactly one FUND row exists', (await fundCount()) === 1);

    // End-to-end: the escrow state endpoint now reports the real stake.
    const escrowStateRes = await fetch(`${base}/api/challenges/${challengeId}/escrow`, {
      headers: cookieA ? { Cookie: cookieA } : {},
    });
    const escrowState = (await jsonOf(escrowStateRes))?.data?.escrow;
    check(
      'GET /escrow reports the stake as CONFIRMED and not simulated',
      escrowState?.stake?.status === 'CONFIRMED' && escrowState?.stake?.simulated === false,
      `status=${escrowState?.stake?.status} simulated=${escrowState?.stake?.simulated}`,
    );

    // ------------------------------------------------------------------
    // Idempotency
    // ------------------------------------------------------------------
    const repeat = await confirmUserLock(
      { userId: userAId, challengeId, txHash: realHash },
      { getClient: () => stubClient({ logs: [happy.log], commitmentId: happy.commitmentId, commitment: happy.commitment }, escrow) },
    );
    const afterRepeat = await fundState();
    check(
      're-confirming the same hash is an idempotent no-op',
      repeat.ok === true && repeat.duplicate === true,
      `ok=${repeat.ok} duplicate=${repeat.duplicate} code=${repeat.code}`,
    );
    check(
      'idempotent re-confirm does not create a second FUND row',
      (await fundCount()) === 1 && afterRepeat.txHash === realHash,
      `count=${await fundCount()} txHash=${afterRepeat.txHash}`,
    );

    const repoint = await confirmUserLock(
      { userId: userAId, challengeId, txHash: fakeHash('cd') },
      { getClient: () => stubClient({ logs: [happy.log], commitmentId: happy.commitmentId, commitment: happy.commitment }, escrow) },
    );
    const afterRepoint = await fundState();
    check(
      'a confirmed lock cannot be re-pointed at a different transaction',
      repoint.ok === false && repoint.code === 'LOCK_ALREADY_CONFIRMED',
      `ok=${repoint.ok} code=${repoint.code}`,
    );
    check(
      'the rejected re-point leaves the original hash intact',
      afterRepoint.txHash === realHash,
      `txHash=${afterRepoint.txHash}`,
    );

    const httpRepoint = await confirmViaApi(base, cookieA, challengeId, fakeHash('cd'));
    check(
      'HTTP re-point of a confirmed lock is a 409 conflict',
      httpRepoint.status === 409,
      `status=${httpRepoint.status}`,
    );

    // ------------------------------------------------------------------
    // Rejection scenarios — each must leave the row PENDING
    // ------------------------------------------------------------------
    async function expectRefusal(
      label: string,
      expectedCode: string,
      scenario: StubScenario,
    ): Promise<void> {
      await seedPendingFund();
      const result = await confirmUserLock(
        { userId: userAId, challengeId, txHash: fakeHash('9f') },
        { getClient: () => stubClient(scenario, escrow) },
      );
      const state = await fundState();

      check(
        `${label} -> ${expectedCode}`,
        result.ok === false && result.code === expectedCode,
        `ok=${result.ok} code=${result.code} message=${result.message}`,
      );
      check(
        `${label} leaves the stake PENDING with no hash`,
        state.status === 'PENDING' && state.txHash === null,
        `status=${state.status} txHash=${state.txHash}`,
      );

    }

    await expectRefusal('reverted transaction', 'TX_REVERTED', {
      status: 'reverted',
      logs: [goodLock().log],
      commitmentId: 7n,
      commitment: goodLock().commitment,
    });

    await expectRefusal('transaction on the wrong chain', 'TX_CHAIN_MISMATCH', {
      chainId: 1,
      logs: [goodLock().log],
      commitmentId: 7n,
      commitment: goodLock().commitment,
    });

    await expectRefusal('transaction to the wrong contract', 'TX_CONTRACT_MISMATCH', {
      to: randomAddress(),
      logs: [goodLock().log],
      commitmentId: 7n,
      commitment: goodLock().commitment,
    });

    await expectRefusal('no ChallengeLocked event', 'LOCK_EVENT_MISMATCH', {
      logs: [],
      commitmentId: 7n,
      commitment: goodLock().commitment,
    });

    await expectRefusal('event from a foreign contract', 'LOCK_EVENT_MISMATCH', {
      logs: [{ address: randomAddress(), topics: [`0x${'11'.repeat(32)}`], data: '0x' }],
      commitmentId: 7n,
      commitment: goodLock().commitment,
    });

    await expectRefusal('event for a different challenge', 'LOCK_EVENT_MISMATCH', {
      logs: [goodLock({ challengeId: 'some-other-challenge' }).log],
      commitmentId: 7n,
      commitment: goodLock().commitment,
    });

    await expectRefusal('event from a different wallet', 'LOCK_EVENT_MISMATCH', {
      logs: [goodLock({ user: randomAddress() }).log],
      commitmentId: 7n,
      commitment: goodLock().commitment,
    });

    await expectRefusal('event for a different amount', 'LOCK_EVENT_MISMATCH', {
      logs: [goodLock({ amount: BigInt(STAKE) + 1n }).log],
      commitmentId: 7n,
      commitment: goodLock().commitment,
    });

    await expectRefusal('commitment endsAt mismatch', 'COMMITMENT_MISMATCH', {
      logs: [goodLock().log],
      commitmentId: 7n,
      commitment: { ...goodLock().commitment, endsAt: expectedEndsAt + 1000n },
    });

    await expectRefusal('commitment already settled', 'COMMITMENT_MISMATCH', {
      logs: [goodLock().log],
      commitmentId: 7n,
      commitment: { ...goodLock().commitment, settled: true },
    });

    await expectRefusal('commitment belongs to another wallet', 'COMMITMENT_MISMATCH', {
      logs: [goodLock().log],
      commitmentId: 7n,
      commitment: { ...goodLock().commitment, user: randomAddress() },
    });

    await expectRefusal('no on-chain commitment', 'NO_ONCHAIN_COMMITMENT', {
      logs: [goodLock().log],
      commitmentId: 0n,
      commitment: goodLock().commitment,
    });

    // ------------------------------------------------------------------
    // Cross-user at the service layer
    // ------------------------------------------------------------------
    await seedPendingFund();
    const otherUser = await confirmUserLock(
      { userId: userBId, challengeId, txHash: fakeHash('ee') },
      { getClient: () => stubClient({ logs: [goodLock().log], commitmentId: 7n, commitment: goodLock().commitment }, escrow) },
    );
    check(
      'another user cannot confirm this lock (CHALLENGE_NOT_FOUND)',
      otherUser.ok === false && otherUser.code === 'CHALLENGE_NOT_FOUND',
      `ok=${otherUser.ok} code=${otherUser.code}`,
    );

    // ------------------------------------------------------------------
    // Summary
    // ------------------------------------------------------------------
    const failed = checks.filter((c) => !c.pass);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
    if (failed.length > 0) {
      console.log('FAILED:');
      for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` :: ${f.detail}` : ''}`);
      process.exitCode = 1;
    }
  } finally {
    // Clean up only the fixtures this run created.
    await prisma.transaction.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.challenge.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.habit.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
